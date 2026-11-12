"""Prepare the local Whisper and Ollama models for the desktop launcher."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent


def request_json(url: str, timeout: float = 2) -> dict:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=timeout) as response:
        return json.load(response)


def ollama_tags(base_url: str) -> list[str] | None:
    try:
        data = request_json(f"{base_url}/api/tags")
        return [item.get("name", "") for item in data.get("models", [])]
    except (ValueError, urllib.error.URLError, TimeoutError, OSError):
        return None


def find_ollama() -> Path | None:
    local_appdata = Path(os.getenv("LOCALAPPDATA", str(Path.home() / "AppData/Local")))
    candidates = [
        PROJECT_ROOT / "tools" / "ollama" / "ollama.exe",
        PROJECT_ROOT / "tools" / "ollama" / "bin" / "ollama.exe",
        Path(shutil.which("ollama") or "__missing_ollama__"),
        local_appdata / "Programs" / "Ollama" / "ollama.exe",
        Path(os.getenv("ProgramFiles", "C:/Program Files")) / "Ollama" / "ollama.exe",
    ]
    return next((path for path in candidates if path.is_file()), None)


def ensure_ollama() -> None:
    base_url = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("Local mode requires a loopback OLLAMA_BASE_URL such as http://127.0.0.1:11434.")
    model = os.getenv("OLLAMA_MODEL", "qwen2.5:3b").strip() or "qwen2.5:3b"
    os.environ["OLLAMA_MODEL"] = model
    tags = ollama_tags(base_url)
    if tags is None:
        executable = find_ollama()
        if executable is None:
            raise RuntimeError(
                "Ollama is missing. Install it from https://ollama.com/download/windows "
                "or place the portable files in tools/ollama, then double-click start.cmd."
            )
        models_dir = PROJECT_ROOT / "models" / "ollama"
        models_dir.mkdir(parents=True, exist_ok=True)
        logs_dir = PROJECT_ROOT / "logs"
        logs_dir.mkdir(exist_ok=True)
        env = os.environ.copy()
        env.update({
            "OLLAMA_HOST": parsed.netloc,
            "OLLAMA_MODELS": str(models_dir),
            "OLLAMA_KEEP_ALIVE": "5m",
        })
        print("Starting local Ollama...", flush=True)
        with (logs_dir / "ollama.log").open("ab") as log:
            process = subprocess.Popen(
                [str(executable), "serve"], cwd=executable.parent, env=env,
                stdout=log, stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        for _ in range(100):
            tags = ollama_tags(base_url)
            if tags is not None:
                break
            if process.poll() is not None:
                raise RuntimeError("Ollama stopped during startup. Read logs/ollama.log.")
            time.sleep(0.2)
        if tags is None:
            raise RuntimeError("Ollama startup timed out. Read logs/ollama.log and run start.cmd again.")

    expected = model if ":" in model else f"{model}:latest"
    if model in tags or expected in tags:
        print(f"Local text model is ready: {model}", flush=True)
        return
    print(f"Downloading local text model {model}. First setup needs an Internet connection...", flush=True)
    request = urllib.request.Request(
        f"{base_url}/api/pull", data=json.dumps({"name": model, "stream": True}).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    last_status = ""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=900) as response:
        for line in response:
            if not line.strip():
                continue
            progress = json.loads(line)
            if progress.get("error"):
                raise RuntimeError(f"Ollama model download failed: {progress['error']}")
            status = progress.get("status", "")
            total, completed = progress.get("total", 0), progress.get("completed", 0)
            if total:
                status = f"{status}: {completed * 100 // total}%"
            if status != last_status:
                print(status, flush=True)
                last_status = status
    tags = ollama_tags(base_url)
    if not tags or not (model in tags or expected in tags):
        raise RuntimeError(f"The downloaded model {model} was not found. Run start.cmd again.")


def ensure_whisper() -> None:
    configured = os.getenv("LOCAL_WHISPER_MODEL", "models/whisper-small").strip()
    configured = configured or "models/whisper-small"
    os.environ.setdefault("LOCAL_WHISPER_DEVICE", "cpu")
    os.environ.setdefault("LOCAL_WHISPER_COMPUTE_TYPE", "int8")
    if "/" in configured or "\\" in configured or Path(configured).is_absolute():
        target = Path(configured)
        if not target.is_absolute():
            target = PROJECT_ROOT / target
        required_files = ("model.bin", "config.json", "tokenizer.json")
        if not all((target / name).is_file() for name in required_files):
            if target.resolve() == (PROJECT_ROOT / "models" / "whisper-small").resolve():
                print("Downloading Whisper small. First setup needs an Internet connection...", flush=True)
                from faster_whisper.utils import download_model

                download_model("small", output_dir=str(target))
            else:
                raise RuntimeError(f"Whisper model files were not found in {target}. Check LOCAL_WHISPER_MODEL in .env.")
        os.environ["LOCAL_WHISPER_MODEL"] = str(target.resolve())
        print(f"Local transcription model is ready: {target}", flush=True)
    else:
        print(f"Whisper model: {configured} (downloads on first use if not cached).", flush=True)


def prepare_local() -> None:
    ensure_whisper()
    ensure_ollama()
    from speaker_diarization import ensure_speaker_models
    ensure_speaker_models()

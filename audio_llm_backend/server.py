"""Audio transcription and important-information extraction service.

The Android client never receives or stores the OpenAI API key.  It uploads an
audio file to this service, while the service calls the transcription endpoint
and then asks a text model for structured information to retain.
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import importlib.util
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import uuid
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from openai import OpenAI
from pydantic import BaseModel, Field
from chinese_text import simplify_record_text, simplify_value
from fragment_summary import build_fragment_source, summarize_fragment
from transcript_editing import edit_transcript, TranscriptConflictError
from recognition_queue import RecognitionWorker
from audio_waveform import waveform_for_file
from segment_editing import adjust_segments

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
AUDIO_DIR = ROOT / "data" / "audio"
RECORD_DIR = ROOT / "data" / "records"
CLIP_DIR = ROOT / "data" / "clips"
FRAGMENT_DIR = ROOT / "data" / "fragment-summaries"
WAVEFORM_DIR = ROOT / "data" / "waveforms"
WEB_DIR = ROOT / "web"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)
RECORD_DIR.mkdir(parents=True, exist_ok=True)

MAX_FILE_SIZE = int(os.getenv("MAX_FILE_SIZE_MB", "50")) * 1024 * 1024
MAX_DURATION_SECONDS = int(os.getenv("MAX_DURATION_SECONDS", "300"))
SUPPORTED_SUFFIXES = {".mp3", ".wav", ".aac", ".m4a", ".mp4", ".mpeg", ".mpga", ".ogg", ".webm", ".flac"}
MOCK_MODE = os.getenv("MOCK_MODE", "false").lower() == "true"
AI_MODE = os.getenv("AI_MODE", "local").lower()
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:3b")
LOCAL_WHISPER_MODEL = os.getenv("LOCAL_WHISPER_MODEL", "base")
LOCAL_WHISPER_DEVICE = os.getenv("LOCAL_WHISPER_DEVICE", "cpu")
LOCAL_WHISPER_COMPUTE_TYPE = os.getenv("LOCAL_WHISPER_COMPUTE_TYPE", "int8")
LOCAL_LANGUAGE = os.getenv("LOCAL_LANGUAGE", "zh")
_LOCAL_WHISPER = None
_PROCESS_LOCK = threading.Lock()
_SUMMARY_REQUEST_LOCK = threading.Lock()
_ACTIVE_STATUSES = {"Queued", "Preparing", "Uploading", "Analyzing", "Recognizing", "Summarizing", "Diarizing", "Reviewing"}
_RECOGNITION_QUEUE = None

@asynccontextmanager
async def lifespan(application):
    global _RECOGNITION_QUEUE
    for path in RECORD_DIR.glob("*.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            if record.get("status") in _ACTIVE_STATUSES - {"Queued"}:
                record.update(status="Partial" if record.get("transcript") or record.get("pitchStats") else "Failed",
                              message="上次处理被中断，已有文字可重新提取重点；转写未完成时请重新上传",
                              error="上次服务在处理完成前关闭")
                _write_record(record)
            if record.get('queueState') == 'processing':
                record.update(queueState='finished', queueResultStatus=record.get('status'),
                              queueCompletedAt=datetime.now(timezone.utc).isoformat())
                _write_record(record)
        except (OSError, ValueError, KeyError):
            continue
    worker = RecognitionWorker(_take_queued_record, _process_task, _queue_failed, _queue_finished)
    _RECOGNITION_QUEUE = worker
    worker.start()
    try:
        yield
    finally:
        worker.stop()
        if _RECOGNITION_QUEUE is worker:
            _RECOGNITION_QUEUE = None


app = FastAPI(title="Audio Insight API", version="9.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.get("/", include_in_schema=False)
def web_home() -> FileResponse:
    if not (WEB_DIR / "cover.html").exists():
        raise HTTPException(status_code=404, detail="项目封面不存在")
    return FileResponse(WEB_DIR / "cover.html")


@app.get("/app", include_in_schema=False)
def web_workspace() -> FileResponse:
    if not (WEB_DIR / "index.html").exists():
        raise HTTPException(status_code=404, detail="网页文件不存在")
    return FileResponse(WEB_DIR / "index.html")


def _record_path(task_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{32}", task_id):
        raise HTTPException(status_code=400, detail="任务编号格式错误")
    return RECORD_DIR / f"{task_id}.json"


def _read_record(task_id: str) -> dict[str, Any] | None:
    path = _record_path(task_id)
    if not path.exists():
        return None
    record = json.loads(path.read_text(encoding="utf-8"))
    simplify_record_text(record)
    return record


def _write_record(record: dict[str, Any]) -> None:
    simplify_record_text(record)
    target = _record_path(record["taskId"])
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(target)


def _client() -> OpenAI:
    key = os.getenv("OPENAI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("OPENAI_API_KEY 未配置，请在服务端 .env 中设置")
    return OpenAI(api_key=key, base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"))


def _mock_result() -> tuple[str, dict[str, Any]]:
    transcript = "这是演示模式的固定文本。切换到本地 AI 模式后可进行真实音频识别。"
    info = {
        "summary": "演示模式结果",
        "keywords": ["音频识别", "大模型"],
        "facts": ["当前服务运行在 MOCK_MODE=true"],
        "decisions": [],
        "action_items": [],
        "questions": [],
    }
    return transcript, info


def _normalize_important_info(info: dict[str, Any], transcript: str = "") -> dict[str, Any]:
    """Keep local-model JSON compatible with the cloud structured schema."""
    if not isinstance(info, dict):
        raise ValueError("模型输出应为 JSON 对象")
    info = simplify_value(info)
    transcript = simplify_value(transcript)
    def strings(name):
        value = info.get(name, [])
        if not isinstance(value, list):
            raise ValueError(f"模型输出 {name} 应为数组")
        return [str(item) for item in value if item is not None]
    result = {
        "summary": str(info.get("summary", "")),
        "keywords": strings("keywords"),
        "facts": strings("facts"),
        "decisions": strings("decisions"),
        "action_items": [],
        "questions": strings("questions"),
    }
    for item in info.get("action_items") or []:
        if isinstance(item, dict):
            owner = str(item.get("owner", "")).strip()
            deadline = str(item.get("deadline", "")).strip()
            # Local models can invent calendar dates or names even with a schema.
            # These two fields must quote information actually in the transcript.
            if transcript:
                owner = owner if owner in transcript else ""
                deadline = deadline if deadline in transcript else ""
            result["action_items"].append({
                "task": str(item.get("task", "")),
                "owner": owner,
                "deadline": deadline,
            })
    return result


def _transcribe_local(audio_path: Path) -> str:
    """Transcribe locally with faster-whisper; model weights stay on the PC."""
    global _LOCAL_WHISPER
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError("本地模式缺少 faster-whisper，请运行 start_local.cmd 安装本地依赖") from exc
    if _LOCAL_WHISPER is None:
        _LOCAL_WHISPER = WhisperModel(
            LOCAL_WHISPER_MODEL,
            device=LOCAL_WHISPER_DEVICE,
            compute_type=LOCAL_WHISPER_COMPUTE_TYPE,
        )
    segments, _ = _LOCAL_WHISPER.transcribe(
        str(audio_path),
        language=LOCAL_LANGUAGE or None,
        vad_filter=True,
    )
    text = " ".join(segment.text.strip() for segment in segments if segment.text.strip())
    if not text:
        raise RuntimeError("本地语音识别没有检测到可用语音")
    return text


def _extract_local_important_info(transcript: str) -> dict[str, Any]:
    prompt = (
        "请从以下音频转写文字中提取重要信息。只返回 JSON，不要 Markdown。"
        "JSON 必须包含 summary、keywords、facts、decisions、action_items、questions。"
        "action_items 是包含 task、owner、deadline 的对象数组；没有内容就返回空数组。"
        "摘要用一到三句话。facts 是原文明确陈述的信息；decisions 只列明确作出的决定。"
        "每条待办必须是原文明确要求的事项，不要将不同任务的负责人和截止时间混在一起。"
        "owner 和 deadline 必须直接摘录原文：没有明确对应的负责人或期限就填空字符串。"
        "例如原文说‘周五之前’，deadline 就填‘周五之前’，严禁补年份或换成具体年月日。"
        "历史或影视对话中没有现实待办时，action_items 返回空数组。"
        f"\n\n转写文字：\n{transcript}"
    )
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "stream": False,
        "format": {
            "type": "object", "additionalProperties": False,
            "properties": {
                "summary": {"type": "string"},
                **{name: {"type": "array", "items": {"type": "string"}}
                   for name in ("keywords", "facts", "decisions", "questions")},
                "action_items": {"type": "array", "items": {
                    "type": "object", "properties": {
                        name: {"type": "string"} for name in ("task", "owner", "deadline")},
                    "required": ["task", "owner", "deadline"], "additionalProperties": False}},
            },
            "required": ["summary", "keywords", "facts", "decisions", "questions", "action_items"],
        },
        "options": {"temperature": 0, "num_ctx": 8192, "num_predict": 1800},
        "messages": [
            {"role": "system", "content": "你是严谨的中文音频信息整理助手。统一使用简体中文。只提取原文有依据的信息，禁止补写姓名、日期或事实。无法确定的内容留空，不猜测修正含糊的转写。"},
            {"role": "user", "content": prompt},
        ],
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{OLLAMA_BASE_URL}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with _ollama_open(request, timeout=180) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = json.loads(exc.read().decode("utf-8")).get("error", "")
        raise RuntimeError(f"Ollama 返回错误：{detail}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError("无法连接 Ollama，请先启动 Ollama 并确认本地模型已下载") from exc
    content = body.get("message", {}).get("content", "")
    if not content:
        raise RuntimeError("Ollama 没有返回重点信息")
    content = content.strip().removeprefix("```json").removesuffix("```").strip()
    try:
        return _normalize_important_info(json.loads(content), transcript)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Ollama 返回的重点信息不是有效 JSON") from exc


def _ollama_open(request, timeout):
    """Keep local model traffic on this computer even when a proxy is configured."""
    if (urlsplit(OLLAMA_BASE_URL).hostname or "").lower() in {"127.0.0.1", "localhost", "::1"}:
        return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=timeout)
    return urllib.request.urlopen(request, timeout=timeout)


def _warnings_without_summary(record: dict[str, Any]) -> list[str]:
    existing = record.get("warnings")
    if not isinstance(existing, list):
        existing = [existing] if existing else str(record.get("error") or "").split("；")
    return list(dict.fromkeys(str(item) for item in existing
                             if item and not str(item).startswith("重点提取失败：")))


def _retry_summary(record: dict[str, Any]) -> None:
    """Summarize the saved transcript without decoding or transcribing the audio again."""
    started = time.perf_counter()
    warnings = _warnings_without_summary(record)
    summary_error = ""
    with _PROCESS_LOCK:
        record.update(message="正在从已有文字提取摘要和待办")
        _write_record(record)
        try:
            info = (_extract_local_important_info(record["transcript"])
                    if AI_MODE == "local" else _extract_important_info(_client(), record["transcript"]))
            record["importantInfo"] = info
            record["importantInfoStale"] = False
        except Exception as exc:
            summary_error = f"重点提取失败：{exc}"
            warnings.append(summary_error)
        record.update(status="Partial" if warnings else "Success", warnings=warnings,
                      error="；".join(warnings), summaryError=summary_error,
                      summaryElapsedMs=round((time.perf_counter() - started) * 1000),
                      summaryCompletedAt=datetime.now(timezone.utc).isoformat(),
                      message="重点已重新提取" if not summary_error else "重点提取未完成，已有文字和音高结果已保留")
        _write_record(record)


def _normalize_pitch_data(raw: str) -> dict[str, Any]:
    empty = {"points": [], "minHz": None, "maxHz": None, "avgHz": None, "voicedRatio": 0}
    if not raw:
        return empty
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return empty
    points = []
    for item in data.get("points", [])[:400]:
        if not isinstance(item, dict):
            continue
        try:
            time_value = float(item["time"])
            hz_value = float(item["hz"])
        except (KeyError, TypeError, ValueError):
            continue
        if time_value >= 0 and 40 <= hz_value <= 2000:
            points.append({"time": round(time_value, 3), "hz": round(hz_value, 2)})
    return {
        "points": points,
        "minHz": data.get("minHz"),
        "maxHz": data.get("maxHz"),
        "avgHz": data.get("avgHz"),
        "voicedRatio": data.get("voicedRatio", 0),
    }


def _transcribe(client: OpenAI, audio_path: Path) -> str:
    with audio_path.open("rb") as audio_file:
        response = client.audio.transcriptions.create(
            model=os.getenv("TRANSCRIPTION_MODEL", "gpt-4o-mini-transcribe"),
            file=audio_file,
            response_format="json",
        )
    text = getattr(response, "text", None)
    if not text:
        raise RuntimeError("语音识别服务未返回文本")
    return text.strip()


def _extract_important_info(client: OpenAI, transcript: str) -> dict[str, Any]:
    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "summary": {"type": "string", "description": "用一到三句话概括音频内容"},
            "keywords": {"type": "array", "items": {"type": "string"}},
            "facts": {"type": "array", "items": {"type": "string"}},
            "decisions": {"type": "array", "items": {"type": "string"}},
            "action_items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "task": {"type": "string"},
                        "owner": {"type": "string"},
                        "deadline": {"type": "string"},
                    },
                    "required": ["task", "owner", "deadline"],
                },
            },
            "questions": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["summary", "keywords", "facts", "decisions", "action_items", "questions"],
    }
    response = client.chat.completions.create(
        model=os.getenv("EXTRACTION_MODEL", "gpt-4o-mini"),
        messages=[
            {
                "role": "developer",
                "content": (
                    "你是会议和课堂音频整理助手。只根据给出的转写文本提取信息，"
                    "不要补写文本中没有依据的事实。没有内容的数组返回空数组，"
                    "没有明确负责人或日期时使用空字符串。"
                ),
            },
            {"role": "user", "content": f"请整理以下转写文本：\n\n{transcript}"},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {"name": "audio_important_info", "strict": True, "schema": schema},
        },
    )
    content = response.choices[0].message.content
    if not content:
        raise RuntimeError("大模型未返回结构化结果")
    return json.loads(content)


def _process_task(record: dict[str, Any]) -> None:
    started = time.perf_counter()
    def stage(status, message):
        record.update(status=status, message=message)
        _write_record(record)
    stage("Analyzing", "等待本机处理资源")
    # Avoid several model instances competing for RAM/GPU on repeated uploads.
    with _PROCESS_LOCK:
        warnings = []
        samples = None
        try:
            from local_audio import decode_audio, analyze_pitch, transcribe
            stage("Analyzing", "解码音频并计算音高统计")
            samples = decode_audio(Path(record["audioPath"]), MAX_DURATION_SECONDS)
            record["duration"] = round(len(samples) / 16000, 3)
            try:
                record["pitchStats"] = analyze_pitch(samples)
            except Exception as exc:
                warnings.append(f"音高分析失败：{exc}")
            _write_record(record)
        except Exception as exc:
            if AI_MODE == "local" and not MOCK_MODE:
                record.update(status="Failed", error=f"音频解码失败：{exc}")
                record["elapsedMs"] = round((time.perf_counter() - started) * 1000)
                _write_record(record)
                return
            warnings.append(f"音频分析不可用：{exc}")
        try:
            stage("Recognizing", "正在将音频转为文字，首次加载模型可能较慢")
            if MOCK_MODE:
                record["transcript"], record["importantInfo"] = _mock_result()
            elif AI_MODE == "local":
                result = transcribe(samples, LOCAL_WHISPER_MODEL, LOCAL_WHISPER_DEVICE,
                                    LOCAL_WHISPER_COMPUTE_TYPE, LOCAL_LANGUAGE)
                record.update(transcript=result["text"], segments=result["segments"], language=result["language"], reviewInfo=result["reviewInfo"])
                record["reviewInfo"]["completedAt"] = datetime.now(timezone.utc).isoformat()
                if not result["text"]:
                    raise ValueError("没有检测到可用语音，音高分析结果仍已保留")
            else:
                record["transcript"] = _transcribe(_client(), Path(record["audioPath"]))
            _write_record(record)  # Save transcript BEFORE summarization, even if model fails.
        except Exception as exc:
            warnings.append(f"语音转写失败：{exc}")
        if record.get("segments") and not MOCK_MODE:
            try:
                stage("Diarizing", "正在区分不同说话人")
                _apply_speaker_analysis(record, samples)
                _write_record(record)
            except Exception as exc:
                warnings.append(f"说话人区分失败：{exc}")
        if record.get("transcript") and not MOCK_MODE:
            try:
                stage("Summarizing", "文字已保存，正在提取摘要和待办")
                record["importantInfo"] = (_extract_local_important_info(record["transcript"])
                    if AI_MODE == "local" else _extract_important_info(_client(), record["transcript"]))
            except Exception as exc:
                warnings.append(f"重点提取失败：{exc}")
        usable = bool(record.get("transcript") or record.get("pitchStats"))
        record.update(status=("Partial" if warnings else "Success") if usable else "Failed",
                      warnings=warnings, error="；".join(warnings),
                      message="处理完成" if not warnings else "已有结果已保存，请查看提示",
                      elapsedMs=round((time.perf_counter() - started) * 1000))
        _write_record(record)


@app.get("/api/health")
def health() -> dict[str, Any]:
    ollama = {"reachable": False, "modelAvailable": False, "model": OLLAMA_MODEL, "error": ""}
    if AI_MODE == "local" and not MOCK_MODE:
        try:
            with _ollama_open(f"{OLLAMA_BASE_URL}/api/tags", timeout=1.5) as response:
                tags = json.loads(response.read())
            ollama.update(reachable=True, modelAvailable=any(
                item.get("name") == OLLAMA_MODEL for item in tags.get("models", [])))
            if not ollama["modelAvailable"]:
                ollama["error"] = "Ollama 模型尚未下载，请运行 start_local.cmd 完成准备"
        except (OSError, ValueError) as exc:
            ollama["error"] = "Ollama 未启动，请运行 start_local.cmd"
    return {
        "ok": True, "service": "audio-insight", "version": 9,
        "liveTranscription": AI_MODE == "local" and not MOCK_MODE,
        "maxRecordingSeconds": MAX_DURATION_SECONDS,
        "mode": "mock" if MOCK_MODE else AI_MODE,
        "mockMode": MOCK_MODE,
        "openaiConfigured": bool(os.getenv("OPENAI_API_KEY", "").strip()),
        "ollama": ollama,
        "localWhisperInstalled": importlib.util.find_spec("faster_whisper") is not None,
        "pitchInstalled": importlib.util.find_spec("librosa") is not None,
        "localWhisperModel": LOCAL_WHISPER_MODEL,
    }


def _live_transcribe(payload):
    if not _PROCESS_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="本机正在处理其他任务，实时文字稍后继续")
    try:
        from live_audio import decode_live_wav
        from local_audio import transcribe_preview
        samples = decode_live_wav(payload)
        return transcribe_preview(samples, LOCAL_WHISPER_MODEL, LOCAL_WHISPER_DEVICE,
                                  LOCAL_WHISPER_COMPUTE_TYPE, LOCAL_LANGUAGE)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail="实时转写暂不可用，请检查本地语音模型；录音仍可保存后完整识别") from exc
    finally:
        _PROCESS_LOCK.release()


@app.post("/api/live/transcribe")
async def live_transcribe(request: Request):
    if AI_MODE != "local" or MOCK_MODE:
        raise HTTPException(status_code=400, detail="实时转写需要使用 start.cmd 启动真实本地模式")
    from live_audio import MAX_LIVE_BYTES
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_LIVE_BYTES:
            raise HTTPException(status_code=413, detail="实时音频片段过大")
        chunks.append(chunk)
    return await run_in_threadpool(_live_transcribe, b"".join(chunks))


@app.get("/api/recognition/search")
def search_transcripts(q: str = Query(min_length=1, max_length=120), taskId: str | None = None,
                       limit: int = Query(default=100, ge=1, le=100)):
    if not q.strip():
        raise HTTPException(status_code=400, detail="请输入要搜索的关键词")
    from transcript_search import search_records
    if taskId:
        path = _record_path(taskId)
        if not path.is_file():
            raise HTTPException(status_code=404, detail="识别记录不存在")
        paths = [path]
    else:
        paths = RECORD_DIR.glob("*.json")
    return search_records(paths, q, limit)


@app.post("/api/recognition")
async def create_recognition(
    audioFile: UploadFile = File(...),
    format: str = Form(""),
    sampleRate: int = Form(16000),
    duration: int = Form(0),
    pitchData: str = Form(""),
) -> dict[str, str]:
    suffix = Path(audioFile.filename or "audio.bin").suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        raise HTTPException(status_code=400, detail=f"不支持的音频格式：{suffix or 'unknown'}")
    if duration < 0 or duration > MAX_DURATION_SECONDS:
        raise HTTPException(status_code=400, detail=f"音频时长必须在 0 到 {MAX_DURATION_SECONDS} 秒之间")
    task_id = uuid.uuid4().hex
    destination = AUDIO_DIR / f"{task_id}{suffix}"
    size = 0
    try:
        with destination.open("wb") as output:
            while chunk := await audioFile.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_FILE_SIZE:
                    raise HTTPException(status_code=400, detail=f"文件不能超过 {MAX_FILE_SIZE // 1024 // 1024} MB")
                output.write(chunk)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    if not size:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="文件内容为空，请选择有效音频或视频")
    record = {
        "taskId": task_id,
        "status": "Queued",
        "queueState": "waiting",
        "message": "已上传，正在排队等待识别",
        "queueSubmittedAt": datetime.now(timezone.utc).isoformat(),
        "audioPath": str(destination),
        "fileName": audioFile.filename,
        "format": format or suffix.lstrip("."),
        "sampleRate": sampleRate,
        "duration": duration,
        "fileSize": size,
        "mode": "mock" if MOCK_MODE else AI_MODE,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    with _SUMMARY_REQUEST_LOCK:
        _write_record(record)
    if _RECOGNITION_QUEUE:
        _RECOGNITION_QUEUE.notify()
    return {"taskId": task_id, "status": "Queued", "message": record['message']}


def _queue_records():
    records = []
    for path in RECORD_DIR.glob('*.json'):
        try:
            record = json.loads(path.read_text(encoding='utf-8'))
            if isinstance(record, dict) and record.get('queueSubmittedAt') and re.fullmatch(r'[0-9a-f]{32}', str(record.get('taskId', ''))):
                records.append(record)
        except (OSError, ValueError):
            continue
    return sorted(records, key=lambda row: (row['queueSubmittedAt'], row['taskId']))


def _take_queued_record():
    with _SUMMARY_REQUEST_LOCK:
        record = next((row for row in _queue_records() if row.get('status') == 'Queued' and row.get('queueState') == 'waiting'), None)
        if record is not None:
            record.update(status='Preparing', queueState='processing', message='正在准备识别，等待本机处理资源',
                          queueStartedAt=datetime.now(timezone.utc).isoformat())
            _write_record(record)
        return record


def _queue_failed(record, error):
    with _SUMMARY_REQUEST_LOCK:
        current = _read_record(record['taskId']) or record
        current.update(status='Partial' if current.get('transcript') or current.get('pitchStats') else 'Failed',
                       error=f"识别任务异常：{error}", message='本文件处理未完成，队列将继续处理下一个文件')
        _write_record(current)


def _queue_finished(record):
    with _SUMMARY_REQUEST_LOCK:
        current = _read_record(record['taskId']) or record
        current.update(queueState='finished', queueResultStatus=current.get('status'),
                       queueCompletedAt=datetime.now(timezone.utc).isoformat())
        _write_record(current)


@app.get('/api/recognition/queue')
def recognition_queue():
    records = _queue_records()
    active = [row for row in records if row.get('queueState') in ('waiting', 'processing')]
    completed = [row for row in records if row.get('queueState') not in ('waiting', 'processing')][-20:]
    # Queue positions count only waiting files; the current file is displayed separately.
    positions = {row['taskId']: index + 1 for index, row in enumerate(row for row in active if row.get('queueState') == 'waiting')}
    fields = ('taskId', 'fileName', 'displayName', 'message', 'error', 'queueState', 'queueSubmittedAt', 'queueStartedAt', 'queueCompletedAt')
    return {'items': [{**{key: row.get(key) for key in fields},
                       'status': row.get('status') if row.get('queueState') in ('waiting', 'processing') else row.get('queueResultStatus', row.get('status')),
                       'position': positions.get(row['taskId'])} for row in active + completed],
            'waitingCount': sum(row.get('queueState') == 'waiting' for row in active),
            'processingCount': sum(row.get('queueState') == 'processing' for row in active)}


@app.post('/api/recognition/{task_id}/cancel')
def cancel_queued_recognition(task_id: str):
    with _SUMMARY_REQUEST_LOCK:
        record = _read_record(task_id)
        if record is None:
            raise HTTPException(status_code=404, detail='识别记录不存在')
        if record.get('status') != 'Queued' or record.get('queueState') != 'waiting':
            raise HTTPException(status_code=409, detail='只能取消尚未开始的排队文件，当前文件可能已开始处理')
        record.update(status='Cancelled', queueState='cancelled', queueResultStatus='Cancelled',
                      queueCompletedAt=datetime.now(timezone.utc).isoformat(), message='已取消排队，原文件仍保存在本机')
        _write_record(record)
    return {'taskId': task_id, 'status': 'Cancelled'}


@app.get("/api/recognition/status")
def recognition_status(taskId: str) -> dict[str, Any]:
    record = _read_record(taskId)
    if record is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    return {key: value for key, value in record.items() if key != "audioPath"}


@app.post("/api/recognition/{task_id}/summary")
def retry_summary(task_id: str, background_tasks: BackgroundTasks) -> dict[str, str]:
    if MOCK_MODE:
        raise HTTPException(status_code=400, detail="演示模式不能重新提取重点，请使用本地或 API 模式启动")
    # The read/check/write must be atomic so two clicks cannot enqueue the same record.
    with _SUMMARY_REQUEST_LOCK:
        record = _read_record(task_id)
        if record is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        if record.get("status") in _ACTIVE_STATUSES:
            raise HTTPException(status_code=409, detail="这条记录正在处理，请等待完成后再试")
        if not isinstance(record.get("transcript"), str) or not record["transcript"].strip():
            raise HTTPException(status_code=400, detail="这条记录没有可用转写文字，请先上传音频完成转写")
        warnings = _warnings_without_summary(record)
        record.update(status="Summarizing", message="已有文字已保留，等待本机资源重新提取重点",
                      warnings=warnings, error="；".join(warnings), summaryError="",
                      summaryAttemptedAt=datetime.now(timezone.utc).isoformat(),
                      summaryMode=AI_MODE)
        _write_record(record)
    background_tasks.add_task(_retry_summary, record)
    return {"taskId": task_id, "status": "Summarizing", "message": record["message"]}


class FragmentSummaryRequest(BaseModel):
    segmentIndices: list[int] | None = Field(default=None, max_length=120)
    refresh: bool = False
    expectedStructureRevision: int | None = Field(default=None, ge=0, strict=True)


@app.post("/api/recognition/{task_id}/fragment-summary")
def fragment_summary(task_id: str, body: FragmentSummaryRequest):
    with _SUMMARY_REQUEST_LOCK:
        record = _editable_record(task_id)
        _check_structure_revision(record, body.expectedStructureRevision)
        try:
            source = build_fragment_source(record, body.segmentIndices)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    signature = hashlib.sha256(json.dumps({'version': 1, 'model': OLLAMA_MODEL, **source}, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
    target = FRAGMENT_DIR / task_id / f'{signature}.json'
    if target.exists() and not body.refresh:
        try:
            cached = json.loads(target.read_text(encoding='utf-8'))
            if cached.get('sourceHash') == signature and isinstance(cached.get('summary'), str):
                return {**cached, 'cached': True}
        except (OSError, ValueError, AttributeError):
            pass
    if MOCK_MODE or AI_MODE != 'local':
        raise HTTPException(status_code=400, detail='片段总结请使用本地 AI 模式启动项目')
    if not _PROCESS_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail='本机正在处理音频或其他总结，请稍后再试')
    try:
        try:
            info = summarize_fragment(source['sourceText'], OLLAMA_MODEL, OLLAMA_BASE_URL, _ollama_open)
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        result = {**source, **info, 'taskId': task_id, 'sourceHash': signature, 'model': OLLAMA_MODEL,
                  'createdAt': datetime.now(timezone.utc).isoformat()}
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(f'.{uuid.uuid4().hex}.tmp')
        temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(target)
        # A separate cache never replaces the original recording or recognition record.
        return {**result, 'cached': False}
    finally:
        _PROCESS_LOCK.release()


def _apply_speaker_analysis(record, samples=None):
    from speaker_diarization import analyze_speakers_isolated
    if samples is None:
        from local_audio import decode_audio
        source = Path(record.get("audioPath") or "").resolve()
        if not source.is_relative_to(AUDIO_DIR.resolve()) or not source.is_file():
            raise ValueError("原始音视频文件不存在或不在项目音频目录中")
        samples = decode_audio(source, MAX_DURATION_SECONDS)
    record.update(analyze_speakers_isolated(samples, record["segments"], record.get("speakers")))
    record["speakerInfo"]["completedAt"] = datetime.now(timezone.utc).isoformat()


def _speaker_job(record):
    started = time.perf_counter()
    previous_warnings = record.get("warnings")
    if not isinstance(previous_warnings, list):
        previous_warnings = [previous_warnings] if previous_warnings else str(record.get("error") or "").split("；")
    warnings = [str(item) for item in previous_warnings if item and not str(item).startswith("说话人区分失败：")]
    with _PROCESS_LOCK:
        try:
            record["message"] = "正在从原声区分不同说话人"
            _write_record(record)
            _apply_speaker_analysis(record)
            record['transcriptRevision'] = int(record.get('transcriptRevision') or 0) + 1
        except Exception as exc:
            warnings.append(f"说话人区分失败：{exc}")
        record.update(status="Partial" if warnings else "Success", warnings=warnings, error="；".join(warnings),
                      message="说话人分组未完成，请查看提示" if any(w.startswith("说话人区分失败：") for w in warnings)
                      else "说话人分组已完成，可修改每组的显示名称",
                      speakerElapsedMs=round((time.perf_counter() - started) * 1000))
        _write_record(record)


def _editable_record(task_id):
    record = _read_record(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="识别记录不存在")
    if record.get("status") in _ACTIVE_STATUSES:
        raise HTTPException(status_code=409, detail="这条记录正在处理，请完成后再修改")
    return record


def _check_structure_revision(record, expected):
    current = int(record.get('segmentStructureRevision') or 0)
    if (expected is None and current) or (expected is not None and expected != current):
        raise HTTPException(status_code=409, detail='分句结构已变化，请保留草稿并刷新记录后重新选择句子')


@app.post("/api/recognition/{task_id}/speakers")
def identify_speakers(task_id: str, background_tasks: BackgroundTasks):
    if MOCK_MODE:
        raise HTTPException(status_code=400, detail="演示模式不能进行真实说话人分组")
    with _SUMMARY_REQUEST_LOCK:
        record = _editable_record(task_id)
        if not record.get("segments"):
            raise HTTPException(status_code=400, detail="这条记录没有分句时间，请先完成音频转写")
        record.update(status="Diarizing", message="等待本机资源区分说话人")
        _write_record(record)
    background_tasks.add_task(_speaker_job, record)
    return {"taskId": task_id, "status": "Diarizing", "message": record["message"]}


def _review_job(record):
    started = time.perf_counter()
    previous = record.get("warnings")
    if not isinstance(previous, list):
        previous = [previous] if previous else str(record.get("error") or "").split("；")
    warnings = [str(item) for item in previous if item and not str(item).startswith("模糊片段检查失败：")]
    with _PROCESS_LOCK:
        try:
            from local_audio import decode_audio, transcribe
            from transcript_review import finite, review_existing
            source = Path(record.get("audioPath") or "").resolve()
            if not source.is_relative_to(AUDIO_DIR.resolve()) or not source.is_file():
                raise ValueError("原始音视频文件不存在，无法复查")
            samples = decode_audio(source, MAX_DURATION_SECONDS)
            record["message"] = "正在复听分析识别分数，原文和说话人标签保持保存"
            _write_record(record)
            needs_scores = any(finite((s.get("asrMetrics") or {}).get("avgLogProb")) is None
                               for s in record["segments"])
            fresh = transcribe(samples, LOCAL_WHISPER_MODEL, LOCAL_WHISPER_DEVICE,
                               LOCAL_WHISPER_COMPUTE_TYPE, LOCAL_LANGUAGE)["segments"] if needs_scores else []
            record["reviewInfo"] = review_existing(record["segments"], fresh, samples)
            record["reviewInfo"]["completedAt"] = datetime.now(timezone.utc).isoformat()
            record['transcriptRevision'] = int(record.get('transcriptRevision') or 0) + 1
        except Exception as exc:
            warnings.append(f"模糊片段检查失败：{exc}")
            record["reviewError"] = str(exc)
        else:
            record.pop("reviewError", None)
        record.update(status="Partial" if warnings else "Success", warnings=warnings, error="；".join(warnings),
                      message="模糊片段检查未完成，请查看提示" if record.get("reviewError") else "模糊片段检查完成，请查看待核对页",
                      reviewElapsedMs=round((time.perf_counter() - started) * 1000))
        _write_record(record)


@app.post("/api/recognition/{task_id}/review")
def review_transcript(task_id: str, background_tasks: BackgroundTasks):
    if MOCK_MODE:
        raise HTTPException(status_code=400, detail="演示模式不能检查真实音频")
    with _SUMMARY_REQUEST_LOCK:
        record = _editable_record(task_id)
        if not record.get("segments"):
            raise HTTPException(status_code=400, detail="这条记录没有分句时间，请先完成本地音频转写")
        record.update(status="Reviewing", message="等待本机资源检查模糊片段")
        _write_record(record)
    background_tasks.add_task(_review_job, record)
    return {"taskId": task_id, "status": "Reviewing", "message": record["message"]}


class SpeakerLabelsRequest(BaseModel):
    labels: dict[str, str]


class TranscriptEditRequest(BaseModel):
    segmentIndex: int | None = Field(default=None, ge=0, strict=True)
    text: str = Field(min_length=1, max_length=20000)
    expectedText: str = Field(max_length=200000)
    expectedStructureRevision: int | None = Field(default=None, ge=0, strict=True)


@app.patch("/api/recognition/{task_id}/transcript")
def update_transcript(task_id: str, body: TranscriptEditRequest):
    with _SUMMARY_REQUEST_LOCK:
        record = _editable_record(task_id)
        _check_structure_revision(record, body.expectedStructureRevision)
        try:
            changed = edit_transcript(record, body.segmentIndex, body.text, body.expectedText)
        except TranscriptConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if changed:
            _write_record(record)
    return {key: value for key, value in record.items() if key != "audioPath"}


@app.patch("/api/recognition/{task_id}/speaker-labels")
def update_speaker_labels(task_id: str, body: SpeakerLabelsRequest):
    with _SUMMARY_REQUEST_LOCK:
        record = _editable_record(task_id)
        known = {speaker["id"]: speaker for speaker in record.get("speakers", [])}
        cleaned = {}
        for sid, label in body.labels.items():
            if sid not in known:
                raise HTTPException(status_code=400, detail="说话人分组不存在，请先区分说话人")
            label = simplify_value(label).strip().rstrip("：:").strip()
            if not 1 <= len(label) <= 32:
                raise HTTPException(status_code=400, detail="每个说话人名称需为 1–32 个字符")
            cleaned[sid] = label
        for sid, label in cleaned.items():
            known[sid]["label"] = label
        _write_record(record)
    return {key: value for key, value in record.items() if key != "audioPath"}


class SegmentSpeakerRequest(BaseModel):
    speakerId: str | None = Field(default=None, max_length=64)
    expectedStructureRevision: int | None = Field(default=None, ge=0, strict=True)


@app.patch("/api/recognition/{task_id}/segments/{segment_index}/speaker")
def update_segment_speaker(task_id: str, segment_index: int, body: SegmentSpeakerRequest):
    with _SUMMARY_REQUEST_LOCK:
        record = _editable_record(task_id)
        _check_structure_revision(record, body.expectedStructureRevision)
        segments = record.get("segments", [])
        if not 0 <= segment_index < len(segments):
            raise HTTPException(status_code=404, detail="这条转写不存在")
        known = {speaker["id"] for speaker in record.get("speakers", [])}
        if body.speakerId is not None and body.speakerId not in known:
            raise HTTPException(status_code=400, detail="说话人分组不存在")
        segments[segment_index].update(speakerId=body.speakerId, speakerMixed=False, speakerManuallyAssigned=True)
        record['transcriptRevision'] = int(record.get('transcriptRevision') or 0) + 1
        for speaker in record.get("speakers", []):
            speaker["segmentCount"] = sum(segment.get("speakerId") == speaker["id"] for segment in segments)
        _write_record(record)
    return {key: value for key, value in record.items() if key != "audioPath"}


def _stored_media(task_id):
    record = _read_record(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="识别记录不存在")
    stored = record.get("audioPath")
    if not isinstance(stored, str) or not stored:
        raise HTTPException(status_code=404, detail="这条记录没有保存原始音视频")
    source = Path(stored).resolve()
    if not source.is_relative_to(AUDIO_DIR.resolve()):
        raise HTTPException(status_code=403, detail="原文件不在项目音频目录中")
    if not source.is_file():
        raise HTTPException(status_code=404, detail="原始音视频文件已不存在")
    return record, source


def _media_details(source):
    from source_media import inspect_media
    stat = source.stat()
    try:
        return inspect_media(str(source), stat.st_size, stat.st_mtime_ns)
    except Exception as exc:
        raise HTTPException(status_code=422, detail="无法读取原文件的音视频信息") from exc


@app.get("/api/recognition/{task_id}/media")
def recognition_media(task_id: str):
    record, source = _stored_media(task_id)
    return {**_media_details(source), "taskId": task_id, "fileName": record.get("fileName", "原始音视频"),
            "url": f"/api/recognition/{task_id}/media/file?v={source.stat().st_mtime_ns}"}


@app.get('/api/recognition/{task_id}/waveform')
def recognition_waveform(task_id: str):
    record, source = _stored_media(task_id)
    if record.get('status') in _ACTIVE_STATUSES:
        raise HTTPException(status_code=409, detail='请等待当前文件处理完成后再打开波形编辑')
    try:
        return waveform_for_file(source, WAVEFORM_DIR, MAX_DURATION_SECONDS)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f'无法读取音频波形：{exc}') from exc


class SegmentAdjustRequest(BaseModel):
    operation: Literal['timing', 'split', 'merge', 'undo']
    expectedRevision: int = Field(ge=0, strict=True)
    segmentIndex: int | None = Field(default=None, ge=0, strict=True)
    start: float | None = Field(default=None, allow_inf_nan=False, strict=True)
    end: float | None = Field(default=None, allow_inf_nan=False, strict=True)
    splitAt: float | None = Field(default=None, allow_inf_nan=False, strict=True)
    leftText: str | None = Field(default=None, max_length=20000)
    rightText: str | None = Field(default=None, max_length=20000)
    nextIndex: int | None = Field(default=None, ge=0, strict=True)
    speakerId: str | None = Field(default=None, max_length=64)
    confirmSpeakerChange: bool = False


@app.patch('/api/recognition/{task_id}/segments/adjust')
def update_segment_structure(task_id: str, body: SegmentAdjustRequest):
    with _SUMMARY_REQUEST_LOCK:
        _editable_record(task_id)
    _, source = _stored_media(task_id)
    try:
        waveform = waveform_for_file(source, WAVEFORM_DIR, MAX_DURATION_SECONDS)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f'无法确认原音频时长：{exc}') from exc
    with _SUMMARY_REQUEST_LOCK:
        record = _editable_record(task_id)
        try:
            changed = adjust_segments(record, body.model_dump(), waveform['durationSeconds'])
        except TranscriptConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if changed:
            _write_record(record)
    return {key: value for key, value in record.items() if key != 'audioPath'}


@app.get("/api/recognition/{task_id}/media/file")
def recognition_media_file(task_id: str):
    _, source = _stored_media(task_id)
    info = _media_details(source)
    # FileResponse supports byte-range requests so the player can seek directly.
    return FileResponse(source, media_type=info["mimeType"], headers={
        "Cache-Control": "private, max-age=3600", "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
    })


@app.get("/api/recognition/{task_id}/segments/{segment_index}/audio")
def recognition_segment_audio(task_id: str, segment_index: int) -> FileResponse:
    record = _read_record(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="这条识别记录不存在")
    segments = record.get("segments")
    if not isinstance(segments, list) or not 0 <= segment_index < len(segments):
        raise HTTPException(status_code=404, detail="这条转写的语音分段不存在")
    segment = segments[segment_index]
    if not isinstance(segment, dict):
        raise HTTPException(status_code=400, detail="这条转写没有有效的原声时间段")
    try:
        start, end = float(segment["start"]), float(segment["end"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="这条转写没有保存原声时间段")
    stored_path = record.get("audioPath")
    if not isinstance(stored_path, str) or not stored_path:
        raise HTTPException(status_code=404, detail="原始音视频文件未保存，无法播放原声")
    source = Path(stored_path).resolve()
    if not source.is_relative_to(AUDIO_DIR.resolve()):
        raise HTTPException(status_code=403, detail="原始音视频文件不在项目音频目录中")
    if not source.is_file():
        raise HTTPException(status_code=404, detail="原始音视频文件已不存在，无法播放原声")
    try:
        from audio_clips import segment_clip

        clip = segment_clip(source, CLIP_DIR, task_id, segment_index, start, end, MAX_DURATION_SECONDS)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ImportError as exc:
        raise HTTPException(status_code=503, detail="原声播放依赖尚未安装，请重新运行 start.cmd") from exc
    except Exception as exc:
        raise HTTPException(status_code=422, detail="无法提取此音频的原声，请确认原始文件可正常播放") from exc
    return FileResponse(clip, media_type="audio/wav", headers={
        "Content-Disposition": f'inline; filename="segment-{segment_index + 1}.wav"',
        "Cache-Control": "private, max-age=3600",
    })


@app.get("/api/recognition/history")
def recognition_history() -> list[dict[str, Any]]:
    records = []
    for path in RECORD_DIR.glob("*.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        record.pop("audioPath", None)
        simplify_record_text(record)
        records.append(record)
    return sorted(records, key=lambda item: item.get("createdAt", ""), reverse=True)


class HistoryMetaRequest(BaseModel):
    displayName: str
    favorite: bool = False
    tags: list[str] = Field(default_factory=list)


@app.patch("/api/recognition/{task_id}/history")
def update_history_meta(task_id: str, body: HistoryMetaRequest) -> dict[str, Any]:
    name = simplify_value(body.displayName).strip()
    if not 1 <= len(name) <= 80 or any(ord(char) < 32 for char in name):
        raise HTTPException(status_code=400, detail="记录名称需为 1–80 个字符，不能包含换行")
    if len(body.tags) > 8:
        raise HTTPException(status_code=400, detail="最多添加 8 个标签")
    tags = []
    for raw_tag in body.tags:
        tag = simplify_value(raw_tag).strip()
        if not 1 <= len(tag) <= 24 or any(ord(char) < 32 for char in tag):
            raise HTTPException(status_code=400, detail="每个标签需为 1–24 个字符，不能包含换行")
        if tag not in tags:
            tags.append(tag)
    with _SUMMARY_REQUEST_LOCK:
        record = _editable_record(task_id)
        record.update(displayName=name, favorite=body.favorite, tags=tags)
        _write_record(record)
    return {key: value for key, value in record.items() if key != "audioPath"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8000")))

"""Launch Audio Insight on a free loopback port and optionally open a browser."""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
# --lan binds every interface so a phone on the same Wi-Fi can reach the service.
LAN_BIND_HOST = "0.0.0.0"
PORTS = range(8000, 8011)
SERVICE = "audio-insight"
API_VERSION = 9
HEALTH_TIMEOUT_SECONDS = 3.0


def port_available(port: int, bind_host: str = HOST) -> bool:
    for host in ({HOST, bind_host}):
        with socket.socket() as sock:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            try:
                sock.bind((host, port))
            except OSError:
                return False
    return True


def lan_addresses() -> list[tuple[str, str]]:
    """Return (interface, IPv4) pairs a phone could use; Wi-Fi/Ethernet first."""
    found: list[tuple[str, str]] = []
    if os.name == "nt":
        try:
            script = (
                "[Console]::OutputEncoding = [Text.Encoding]::UTF8; "
                "Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | "
                "ForEach-Object { $_.InterfaceAlias + '|' + $_.IPAddress }"
            )
            raw = subprocess.run(
                ["powershell", "-NoProfile", "-Command", script],
                capture_output=True, timeout=10,
            ).stdout or b""
            output = raw.decode("utf-8", errors="replace")
            for line in output.splitlines():
                alias, _, address = line.strip().rpartition("|")
                if address:
                    found.append((alias, address))
        except (OSError, ValueError, subprocess.SubprocessError):
            found = []
    if not found:
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                found.append(("", info[4][0]))
        except OSError:
            pass
    usable = []
    for alias, address in found:
        # Skip loopback, link-local and the 198.18.0.0/15 range used by proxy TUN adapters.
        if address.startswith(("127.", "169.254.", "198.18.", "198.19.")):
            continue
        if (alias, address) not in usable:
            usable.append((alias, address))

    def rank(item: tuple[str, str]) -> int:
        name = item[0].lower()
        if any(key in name for key in ("vmware", "virtualbox", "vethernet", "radmin", "vpn", "hyper-v", "wsl")):
            return 2
        if any(key in name for key in ("wlan", "wi-fi", "wifi", "无线", "以太网", "ethernet", "本地连接")):
            return 0
        return 1

    return sorted(usable, key=rank)


def print_lan_help(port: int) -> None:
    addresses = lan_addresses()
    print("", flush=True)
    print("LAN mode: phones on the same Wi-Fi can connect.", flush=True)
    if not addresses:
        print("No LAN IPv4 address was found. Connect this computer to Wi-Fi and retry.", flush=True)
        return
    print("Enter this address in the phone app Settings (use the one on the phone's Wi-Fi):", flush=True)
    for alias, address in addresses:
        label = f"  [{alias}]" if alias else ""
        print(f"  http://{address}:{port}{label}", flush=True)
    print("Anyone on this network can reach the service while LAN mode runs. Close it when finished.", flush=True)
    print("", flush=True)


def website_ready(port: int, mode: str, host: str = HOST) -> bool:
    """Never mistake another project or an old incompatible service for this app."""
    try:
        request = urllib.request.Request(
            f"http://{host}:{port}/api/health", headers={"Accept": "application/json"}
        )
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        # /api/health also checks Ollama with a 1.5-second timeout.
        with opener.open(request, timeout=HEALTH_TIMEOUT_SECONDS) as response:
            if response.status != 200:
                return False
            health = json.loads(response.read(16384))
        return (
            isinstance(health, dict)
            and health.get("service") == SERVICE
            and health.get("version") == API_VERSION
            and health.get("mode") == mode
        )
    except (ValueError, urllib.error.URLError, TimeoutError, OSError):
        return False


def open_browser_when_ready(port: int, mode: str) -> None:
    for _ in range(150):
        if website_ready(port, mode):
            webbrowser.open(f"http://{HOST}:{port}/")
            return
        time.sleep(0.2)
    print("Browser was not opened: the service did not become ready. See errors above.", flush=True)


def main() -> int:
    load_dotenv(ROOT / ".env")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("local", "cloud", "mock"), default="local")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--check", action="store_true", help="Check setup without starting the web server")
    parser.add_argument("--lan", action="store_true", help="Also accept phones on the same local network")
    args = parser.parse_args()
    bind_host = LAN_BIND_HOST if args.lan else HOST

    os.chdir(ROOT)
    os.environ["AI_MODE"] = "local" if args.mode == "mock" else args.mode
    os.environ["MOCK_MODE"] = "true" if args.mode == "mock" else "false"

    existing_port = None if args.check else next(
        (port for port in PORTS if website_ready(port, args.mode)), None)
    if args.mode == "local":
        from setup_local import prepare_local

        try:
            prepare_local()
        except (RuntimeError, OSError) as exc:
            print(f"Local model setup is incomplete: {exc}", flush=True)
            if args.check:
                return 1
            print("Opening the website so you can view setup status and use completed transcription/pitch results.", flush=True)
    if args.mode == "cloud" and not os.getenv("OPENAI_API_KEY", "").strip():
        raise RuntimeError("Cloud mode requires OPENAI_API_KEY in audio_llm_backend/.env. Use start.cmd for local AI.")
    if args.check:
        print(f"Setup is ready. Mode: {args.mode}.", flush=True)
        return 0
    # Even when the web page is already open, prepare_local must restart Ollama
    # and verify/download the model before the launcher reuses that service.
    if existing_port is not None:
        if args.lan and not any(
            website_ready(existing_port, args.mode, address) for _, address in lan_addresses()
        ):
            # Starting a second server would process the same recognition queue twice.
            print(
                f"Audio Insight is already running at http://{HOST}:{existing_port}/ but only for this computer.\n"
                "Close that Audio Insight window (Ctrl+C), then run start_lan.cmd again.",
                flush=True,
            )
            return 1
        print(f"Audio Insight ({args.mode}) is already running: http://{HOST}:{existing_port}/", flush=True)
        if args.lan:
            print_lan_help(existing_port)
        if not args.no_browser:
            webbrowser.open(f"http://{HOST}:{existing_port}/")
        return 0

    port = next((candidate for candidate in PORTS if port_available(candidate, bind_host)), None)
    if port is None:
        print("All ports 8000-8010 are occupied. Close an old Audio Insight window and retry.", flush=True)
        return 1

    print(f"Audio Insight ({args.mode}): http://{HOST}:{port}/", flush=True)
    print("This address works on this computer. Press Ctrl+C to stop the web server.", flush=True)
    if args.lan:
        print_lan_help(port)
    if not args.no_browser:
        threading.Thread(target=open_browser_when_ready, args=(port, args.mode), daemon=True).start()
    import uvicorn

    uvicorn.run("server:app", host=bind_host, port=port)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
    except Exception as exc:
        print(f"Startup failed: {exc}", flush=True)
        raise SystemExit(1)

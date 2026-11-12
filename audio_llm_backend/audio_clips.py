"""Cut real PCM audio from the same decoded timeline used for transcription."""

from __future__ import annotations

import hashlib
import math
import threading
import wave
from pathlib import Path

_CACHE_LOCK = threading.Lock()
SAMPLE_RATE = 16000


def segment_clip(source: Path, cache_root: Path, task_id: str, index: int,
                 start: float, end: float, max_seconds: int) -> Path:
    if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= max_seconds + 1):
        raise ValueError("这条转写没有有效的原声时间段")
    stat = source.stat()
    identity = f"{source.name}:{stat.st_size}:{stat.st_mtime_ns}"
    version = hashlib.sha256(identity.encode()).hexdigest()[:20]
    folder = cache_root / task_id
    decoded = folder / f"source-{version}.wav"
    clip = folder / f"segment-{index}-{round(start * 1000)}-{round(end * 1000)}-{version}.wav"
    with _CACHE_LOCK:
        folder.mkdir(parents=True, exist_ok=True)
        if clip.is_file():
            return clip
        if not decoded.is_file():
            import numpy as np
            from local_audio import decode_audio

            samples = decode_audio(source, max_seconds)
            pcm = np.rint(np.clip(samples, -1, 1) * 32767).astype("<i2")
            temporary = decoded.with_suffix(".tmp")
            with wave.open(str(temporary), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(SAMPLE_RATE)
                output.writeframes(pcm.tobytes())
            temporary.replace(decoded)
        with wave.open(str(decoded), "rb") as audio:
            first = round(start * SAMPLE_RATE)
            last = min(audio.getnframes(), round(end * SAMPLE_RATE))
            if first >= last:
                raise ValueError("这条转写的时间段超出了音频范围")
            audio.setpos(first)
            frames = audio.readframes(last - first)
        temporary = clip.with_suffix(".tmp")
        with wave.open(str(temporary), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(SAMPLE_RATE)
            output.writeframes(frames)
        temporary.replace(clip)
    return clip

"""Inspect stored media for browser playback without trusting the filename."""
import mimetypes
from functools import lru_cache


@lru_cache(maxsize=128)
def inspect_media(path, size, modified_ns):
    import av
    with av.open(path) as container:
        # Attached album cover images are not a playable video track.
        videos = [stream for stream in container.streams.video if not int(stream.disposition) & 1024]
        if not videos and not container.streams.audio:
            raise ValueError("原文件没有可播放的音视频轨道")
        kind = "video" if videos else "audio"
        mime = mimetypes.guess_type(path)[0]
        formats = set(container.format.name.split(","))
        if "webm" in formats:
            mime = f"{kind}/webm"
        elif "mov" in formats or "mp4" in formats:
            mime = f"{kind}/mp4"
        elif "wav" in formats:
            mime = "audio/wav"
        elif "ogg" in formats:
            mime = f"{kind}/ogg"
        elif "flac" in formats:
            mime = "audio/flac"
        elif "aac" in formats:
            mime = "audio/aac"
        elif "mp3" in formats or "mpeg" in formats:
            mime = "video/mpeg" if videos else "audio/mpeg"
        if not mime or not mime.startswith(("audio/", "video/")):
            mime = "application/octet-stream"
        return {"kind": kind, "mimeType": mime,
                "duration": round(container.duration / 1_000_000, 3) if container.duration else None,
                "width": videos[0].width if videos else None,
                "height": videos[0].height if videos else None}

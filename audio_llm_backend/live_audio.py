"""Bounded, in-memory PCM input for the local live-transcription preview."""
import io
import wave

MAX_LIVE_BYTES = 16_000 * 2 * 12 + 4096


def decode_live_wav(payload):
    import numpy as np
    if len(payload) > MAX_LIVE_BYTES:
        raise ValueError("实时音频片段不能超过 12 秒")
    try:
        with wave.open(io.BytesIO(payload), "rb") as source:
            if (source.getnchannels(), source.getsampwidth(), source.getframerate(), source.getcomptype()) != (1, 2, 16000, "NONE"):
                raise ValueError("实时音频需要 16 kHz、单声道、16 位 PCM WAV")
            frames = source.getnframes()
            if not 1600 <= frames <= 16000 * 12:
                raise ValueError("实时片段时长需要在 0.1 到 12 秒之间")
            raw = source.readframes(frames)
            if len(raw) != frames * 2:
                raise ValueError("实时音频数据不完整")
    except (wave.Error, EOFError) as exc:
        raise ValueError("实时音频格式无效，请重新录音") from exc
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0

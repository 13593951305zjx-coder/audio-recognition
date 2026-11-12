"""Local decoding, speech recognition and measured fundamental frequency (F0)."""

from __future__ import annotations

import os
import threading
from pathlib import Path

MODEL_LOCK = threading.Lock()
_whisper = None
SAMPLE_RATE = 16000


def decode_audio(path: Path, max_seconds: int):
    import av
    import numpy as np

    chunks = []
    count = 0
    with av.open(str(path)) as container:
        if not container.streams.audio:
            raise ValueError("文件中没有音轨")
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=SAMPLE_RATE)
        for frame in container.decode(audio=0):
            for output in resampler.resample(frame):
                samples = output.to_ndarray().reshape(-1)
                count += samples.size
                if count > max_seconds * SAMPLE_RATE:
                    raise ValueError(f"音频实际时长超过 {max_seconds} 秒，请截取后上传")
                chunks.append(samples.copy())
        for output in resampler.resample(None):
            samples = output.to_ndarray().reshape(-1)
            count += samples.size
            chunks.append(samples.copy())
    if not chunks or count == 0:
        raise ValueError("音频为空或无法解码")
    if count > max_seconds * SAMPLE_RATE:
        raise ValueError(f"音频实际时长超过 {max_seconds} 秒")
    return np.concatenate(chunks).astype(np.float32)


def analyze_pitch(samples):
    """pYIN in bounded chunks; ignore silence/unvoiced frames in statistics."""
    import librosa
    import numpy as np

    hop = 640  # 40 ms; sufficient for speech prosody without enormous JSON.
    frame_length = 1024
    frames = []
    chunk_size = SAMPLE_RATE * 15
    for start in range(0, len(samples), chunk_size):
        chunk = samples[start:start + chunk_size]
        original_length = len(chunk)
        if len(chunk) < frame_length:
            chunk = np.pad(chunk, (0, frame_length - len(chunk)))
        f0, voiced, probabilities = librosa.pyin(
            chunk, sr=SAMPLE_RATE, fmin=65, fmax=600,
            frame_length=frame_length, hop_length=hop,
            resolution=0.2, n_thresholds=40,
        )
        energy = librosa.feature.rms(y=chunk, frame_length=frame_length, hop_length=hop)[0]
        for index, value in enumerate(f0):
            if index * hop >= original_length:
                break
            timestamp = (start + index * hop) / SAMPLE_RATE
            if timestamp >= len(samples) / SAMPLE_RATE:
                break
            is_voiced = bool(voiced[index] and np.isfinite(value) and energy[index] > 0.003)
            frames.append({"time": round(timestamp, 3), "hz": round(float(value), 2) if is_voiced else None})
    values = np.array([point["hz"] for point in frames if point["hz"] is not None])
    counts, edges = np.histogram(values, bins=np.arange(50, 651, 50))
    stride = max(1, int(np.ceil(len(frames) / 2000)))
    return {
        "method": "librosa.pyin", "minFrequencyHz": 65, "maxFrequencyHz": 600,
        "durationSeconds": round(len(samples) / SAMPLE_RATE, 3),
        "points": frames[::stride],
        "minHz": round(float(values.min()), 2) if values.size else None,
        "maxHz": round(float(values.max()), 2) if values.size else None,
        "avgHz": round(float(values.mean()), 2) if values.size else None,
        "medianHz": round(float(np.median(values)), 2) if values.size else None,
        "voicedRatio": round(len(values) / max(len(frames), 1), 4),
        "histogram": [{"lowerHz": int(edges[i]), "upperHz": int(edges[i+1]), "count": int(value)} for i, value in enumerate(counts)],
    }


def _load_whisper(model_name, device, compute_type):
    global _whisper
    from faster_whisper import WhisperModel
    # Callers hold MODEL_LOCK: live preview and full transcription share one model.
    if _whisper is None:
        root = Path(__file__).resolve().parent.parent
        model_path = Path(model_name)
        if not model_path.is_absolute() and (root / model_path).exists():
            model_name = str(root / model_path)
        _whisper = WhisperModel(
            model_name, device=device, compute_type=compute_type,
            cpu_threads=min(8, os.cpu_count() or 4),
            download_root=str(root / "models" / "whisper-cache"),
        )
    return _whisper


def transcribe_preview(samples, model_name, device, compute_type, language):
    import numpy as np
    if not len(samples) or float(np.sqrt(np.mean(samples ** 2))) < 0.002:
        return {"text": "", "words": []}
    from chinese_text import simplify_value
    with MODEL_LOCK:
        model = _load_whisper(model_name, device, compute_type)
        segments, _ = model.transcribe(
            samples, language=language or None, vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300}, beam_size=1,
            temperature=0, condition_on_previous_text=False, word_timestamps=True,
        )
        words = []
        for segment in segments:
            if segment.no_speech_prob > 0.7 and segment.avg_logprob < -1:
                continue
            words.extend({"word": simplify_value(word.word), "start": round(word.start, 3), "end": round(word.end, 3)}
                         for word in segment.words or [])
    return {"text": "".join(word["word"] for word in words).strip(), "words": words}


def transcribe(samples, model_name: str, device: str, compute_type: str, language: str):
    # The parent processor serializes tasks; lock also protects independent callers.
    with MODEL_LOCK:
        model = _load_whisper(model_name, device, compute_type)
        segments, info = model.transcribe(
            samples, language=language or None, vad_filter=True,
            beam_size=5, condition_on_previous_text=False, word_timestamps=True,
        )
        from transcript_review import annotate_segment, summarize_review
        result = []
        for segment in segments:
            if not segment.text.strip():
                continue
            row = {"start": round(segment.start, 3), "end": round(segment.end, 3), "text": segment.text.strip(),
                   "asrMetrics": {"avgLogProb": round(segment.avg_logprob, 5),
                                  "noSpeechProb": round(segment.no_speech_prob, 5),
                                  "compressionRatio": round(segment.compression_ratio, 5)},
                   "words": [{"start": round(word.start, 3), "end": round(word.end, 3),
                              "word": word.word, "probability": round(word.probability, 5)}
                             for word in segment.words or []]}
            result.append(annotate_segment(row, samples))
    return {"text": " ".join(item["text"] for item in result), "segments": result,
            "language": info.language, "reviewInfo": summarize_review(result)}

"""Bounded min/max amplitude envelope on the same PCM timeline as ASR."""
from pathlib import Path
import hashlib
import json
import threading
import uuid

_LOCK = threading.Lock()


def build_waveform(samples, sample_rate=16000, bins=2400):
    import numpy as np
    data = np.asarray(samples, dtype=np.float32).reshape(-1)
    if not data.size or not np.isfinite(data).all():
        raise ValueError('音频为空或包含无效采样')
    step = max(1, (data.size + bins - 1) // bins)
    peaks = [[round(float(np.clip(data[index:index + step].min(), -1, 1)), 5),
              round(float(np.clip(data[index:index + step].max(), -1, 1)), 5)]
             for index in range(0, data.size, step)]
    return {'durationSeconds': data.size / sample_rate, 'sampleRate': sample_rate,
            'samplesPerPeak': step, 'peaks': peaks}


def waveform_for_file(source: Path, cache_root: Path, max_seconds: int):
    stat = source.stat()
    key = hashlib.sha256(f'{source.resolve()}:{stat.st_size}:{stat.st_mtime_ns}:{max_seconds}:v1'.encode()).hexdigest()
    target = cache_root / f'{key}.json'
    with _LOCK:
        if target.is_file():
            try:
                cached = json.loads(target.read_text(encoding='utf-8'))
                if cached.get('peaks') and cached.get('durationSeconds', 0) > 0:
                    return cached
            except (OSError, ValueError, AttributeError):
                pass
        from local_audio import decode_audio
        result = build_waveform(decode_audio(source, max_seconds))
        cache_root.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(f'.{uuid.uuid4().hex}.tmp')
        temporary.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
        temporary.replace(target)
        return result

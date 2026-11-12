"""Local speaker grouping; display names are supplied by the user."""

from __future__ import annotations

import copy
import os
import tarfile
import threading
import urllib.request
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from multiprocessing import get_context
from pathlib import Path

MODEL_DIR = Path(__file__).resolve().parent.parent / "models" / "speakers"
_LOCK = threading.Lock()
_DIARIZER = None
_POOL = None
_POOL_LOCK = threading.Lock()


def analyze_speakers_isolated(samples, segments, previous_speakers=None):
    """Some native model calls hold the GIL; keep them out of the web process."""
    global _POOL
    with _POOL_LOCK:
        if _POOL is None:
            _POOL = ProcessPoolExecutor(max_workers=1, mp_context=get_context("spawn"))
        future = _POOL.submit(analyze_speakers, samples, segments, previous_speakers)
    try:
        return future.result(timeout=300)
    except BrokenProcessPool as exc:
        with _POOL_LOCK:
            if _POOL is not None:
                _POOL.shutdown(wait=False, cancel_futures=True)
            _POOL = None
        raise RuntimeError("说话人模型进程意外结束，可以重新点击区分说话人") from exc


def ensure_speaker_models():
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    needed = [("segmentation.tar.bz2", 197666131, 6958444), ("3dspeaker.onnx", 198893098, 39593761)]
    for name, asset, size in needed:
        target = MODEL_DIR / name
        if target.is_file() and target.stat().st_size == size:
            continue
        print(f"Downloading local speaker model: {name}", flush=True)
        request = urllib.request.Request(
            f"https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/assets/{asset}",
            headers={"User-Agent": "AudioInsight", "Accept": "application/octet-stream"},
        )
        temporary = target.with_name(target.name + f".download-{os.getpid()}")
        with urllib.request.urlopen(request, timeout=90) as response, temporary.open("wb") as output:
            while block := response.read(1024 * 1024):
                output.write(block)
        if temporary.stat().st_size != size:
            raise RuntimeError(f"Speaker model download incomplete: {name}. Run start.cmd again.")
        temporary.replace(target)
    if not all((MODEL_DIR / name).is_file() for name in ("model.onnx", "model.int8.onnx")):
        with tarfile.open(MODEL_DIR / "segmentation.tar.bz2", "r:bz2") as archive:
            for member in archive.getmembers():
                name = Path(member.name).name
                if member.isfile() and name in {"model.onnx", "model.int8.onnx", "LICENSE", "README.md"}:
                    target = MODEL_DIR / name
                    temporary = target.with_suffix(".tmp")
                    with archive.extractfile(member) as source, temporary.open("wb") as output:
                        output.write(source.read())
                    temporary.replace(target)
    if not (MODEL_DIR / "model.onnx").is_file():
        raise RuntimeError("Speaker segmentation model is missing. Run start.cmd again.")
    print("Local speaker grouping models are ready.", flush=True)


def speaker_code(index):
    result = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def assign_speakers(segments, turns, previous_speakers=None):
    """Keep transcription boundaries/indexes intact so existing clips still match."""
    names = {item["id"]: item.get("label", "") for item in previous_speakers or []}
    totals = defaultdict(float)
    order = []
    for turn in turns:
        sid = turn["speakerId"]
        if sid not in order:
            order.append(sid)
        totals[sid] += turn["end"] - turn["start"]
    assigned = copy.deepcopy(segments)
    counts = defaultdict(int)
    for segment in assigned:
        segment.pop("speakerManuallyAssigned", None)
        coverage = defaultdict(float)
        start, end = float(segment["start"]), float(segment["end"])
        for turn in turns:
            overlap = min(end, turn["end"]) - max(start, turn["start"])
            if overlap > 0:
                coverage[turn["speakerId"]] += overlap
        ranked = sorted(coverage, key=lambda sid: coverage[sid], reverse=True)
        sid = ranked[0] if ranked else None
        segment["speakerId"] = sid
        duration = max(end - start, 0.001)
        segment["speakerMixed"] = bool(len(ranked) > 1 and coverage[ranked[1]] / duration >= 0.25)
        segment["speakerCoverage"] = round(min(1, coverage[sid] / duration), 3) if sid else 0
        if sid:
            counts[sid] += 1
    speakers = [{"id": sid, "code": speaker_code(index),
                 "label": names.get(sid) or f"说话人 {speaker_code(index)}",
                 "duration": round(totals[sid], 3), "segmentCount": counts[sid]}
                for index, sid in enumerate(order)]
    return {"segments": assigned, "speakers": speakers, "speakerTurns": turns,
            "speakerInfo": {"status": "Success", "numSpeakers": len(speakers),
                            "method": "sherpa-onnx: pyannote segmentation + 3D-Speaker embeddings"}}


def analyze_speakers(samples, segments, previous_speakers=None):
    global _DIARIZER
    import numpy as np
    import sherpa_onnx

    with _LOCK:
        if _DIARIZER is None:
            ensure_speaker_models()
            config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
                segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                    pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                        model=str(MODEL_DIR / "model.onnx"), window_shift_ratio=0.1),
                    num_threads=2, provider="cpu"),
                embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                    model=str(MODEL_DIR / "3dspeaker.onnx"), num_threads=2, provider="cpu"),
                clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.75),
                min_duration_on=0.3, min_duration_off=0.5,
            )
            if not config.validate():
                raise RuntimeError("本地说话人模型配置无效，请重新运行 start.cmd")
            _DIARIZER = sherpa_onnx.OfflineSpeakerDiarization(config)
        result = _DIARIZER.process(np.ascontiguousarray(samples, dtype=np.float32)).sort_by_start_time()
        ids = {}
        turns = []
        for item in result:
            if item.end <= item.start:
                continue
            sid = ids.setdefault(item.speaker, f"speaker_{len(ids)}")
            turns.append({"start": round(float(item.start), 3), "end": round(float(item.end), 3), "speakerId": sid})
    if not turns:
        raise RuntimeError("没有检测到可区分的说话人，请检查录音中的语音是否清晰")
    return assign_speakers(segments, turns, previous_speakers)

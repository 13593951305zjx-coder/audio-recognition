"""Flag uncertain ASR passages for listening; scores are not accuracy estimates."""

from __future__ import annotations

import math
from difflib import SequenceMatcher

from chinese_text import simplify_value

WORD_THRESHOLD = 0.55


def finite(value):
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def annotate_segment(segment, samples=None, sample_rate=16000):
    """Only highlight words that can be located in the saved, simplified text."""
    if segment.get("textManuallyEdited") or segment.get("timingManuallyEdited") or segment.get("structureManuallyEdited"):
        # ASR token scores describe the original recognition, not a person's correction.
        segment["review"] = {"checked": False, "needsReview": False, "reasons": [], "spans": [],
                             "manualText": True, "note": "文字或分句时间已人工调整，原识别分数不适用于调整后的片段。"}
        return segment
    text = simplify_value(segment.get("text", "")).strip()
    metrics = segment.get("asrMetrics") or {}
    reasons, spans = [], []
    cursor = 0
    for word in segment.get("words") or []:
        token = simplify_value(str(word.get("word", ""))).strip()
        probability = finite(word.get("probability"))
        if not token:
            continue
        position = text.find(token, cursor)
        if position >= 0:
            cursor = position + len(token)
        if probability is not None and probability < WORD_THRESHOLD:
            if "部分词语识别把握较低" not in reasons:
                reasons.append("部分词语识别把握较低")
            if position >= 0:
                spans.append({"start": position, "end": cursor, "text": token})
    logprob = finite(metrics.get("avgLogProb"))
    no_speech = finite(metrics.get("noSpeechProb"))
    compression = finite(metrics.get("compressionRatio"))
    if logprob is not None and logprob < -0.8:
        reasons.append("整句识别把握较低")
    if no_speech is not None and no_speech > 0.6 and logprob is not None and logprob < -0.5:
        reasons.append("人声不够明确，可能混有背景声")
    if compression is not None and compression > 2.4:
        reasons.append("文字重复较多，可能存在识别异常")
    if samples is not None:
        import numpy as np
        start, end = finite(segment.get("start")), finite(segment.get("end"))
        if start is not None and end is not None and end > start:
            clip = samples[max(0, int(start * sample_rate)):max(0, int(end * sample_rate))]
            if len(clip):
                rms = float(np.sqrt(np.mean(np.square(clip.astype(np.float64)))))
                metrics["rmsDbfs"] = round(20 * math.log10(max(rms, 1e-10)), 1)
    quiet = finite(metrics.get("rmsDbfs"))
    if quiet is not None and quiet < -38:
        reasons.append("这段录音音量偏小")
    if metrics.get("textDiffers") or "复查识别与已保存原文差异较大" in segment.get("review", {}).get("reasons", []):
        metrics["textDiffers"] = True
        reasons.append("复查识别与已保存原文差异较大")
    checked = logprob is not None
    segment["asrMetrics"] = metrics
    segment["review"] = {"checked": checked, "needsReview": bool(reasons), "reasons": reasons, "spans": spans}
    return segment


def summarize_review(segments):
    checked = sum(bool(s.get("review", {}).get("checked")) for s in segments)
    return {"status": "Complete" if checked == len(segments) else "Partial",
            "checkedCount": checked, "totalCount": len(segments),
            "flaggedCount": sum(bool(s.get("review", {}).get("needsReview")) for s in segments),
            "method": "Whisper word/segment scores + audio level",
            "wordThreshold": WORD_THRESHOLD,
            "note": "待核对是复听线索，不代表一定有错；未标记也不保证正确。"}


def review_existing(segments, fresh_segments, samples):
    """Add evidence to old rows by time overlap, preserving text/time/speakers."""
    for segment in segments:
        start, end = finite(segment.get("start")), finite(segment.get("end"))
        if start is None or end is None or end <= start:
            segment["review"] = {"checked": False, "needsReview": False, "reasons": [], "spans": []}
            continue
        if finite((segment.get("asrMetrics") or {}).get("avgLogProb")) is None:
            matches = [(fresh, max(0, min(end, fresh["end"]) - max(start, fresh["start"])))
                       for fresh in fresh_segments]
            matches = [(fresh, overlap) for fresh, overlap in matches if overlap > 0]
            # Missing ASR evidence must remain unknown instead of appearing reliable.
            coverage = sum(overlap for _, overlap in matches)
            if coverage >= (end - start) * 0.5:
                total = sum(overlap for _, overlap in matches)
                metric_rows = [(s["asrMetrics"], overlap) for s, overlap in matches]
                segment["asrMetrics"] = {
                    "avgLogProb": sum(m["avgLogProb"] * weight for m, weight in metric_rows) / total,
                    "noSpeechProb": max(m["noSpeechProb"] for m, _ in metric_rows),
                    "compressionRatio": max(m["compressionRatio"] for m, _ in metric_rows),
                }
                segment["words"] = [word for fresh, _ in matches for word in fresh.get("words", [])
                                    if start <= (word["start"] + word["end"]) / 2 < end]
                evidence = "".join(word["word"] for word in segment["words"])
                clean = lambda text: "".join(c for c in simplify_value(text) if c.isalnum())
                original, repeated = clean(segment.get("text", "")), clean(evidence)
                if len(original) >= 4 and repeated and SequenceMatcher(None, original, repeated).ratio() < 0.6:
                    segment["asrMetrics"]["textDiffers"] = True
        annotate_segment(segment, samples)
    return summarize_review(segments)

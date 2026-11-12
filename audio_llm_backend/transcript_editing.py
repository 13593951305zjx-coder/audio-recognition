"""Edit saved text without changing media, segment positions or speaker identities."""
from datetime import datetime, timezone
import math

from chinese_text import simplify_value
from transcript_review import annotate_segment, summarize_review


class TranscriptConflictError(ValueError):
    pass


def edit_transcript(record, index, text, expected_text):
    text = simplify_value(text).strip()
    if not text or len(text) > 20000:
        raise ValueError('转写文字需为 1–20000 个字符，不能只含空白')
    segments = record.get('segments') or []
    if index is None:
        if segments:
            raise ValueError('此记录有分句，请逐条编辑，避免丢失时间段')
        target = record
        key = 'transcript'
    else:
        if not 0 <= index < len(segments) or not isinstance(segments[index], dict):
            raise LookupError('这条转写不存在')
        target = segments[index]
        key = 'text'
    previous = str(target.get(key) or '').strip()
    if previous != simplify_value(expected_text).strip():
        raise TranscriptConflictError('这条文字已在其他窗口修改。请先复制草稿，取消编辑并刷新记录后再试。')
    if text == previous:
        return False
    now = datetime.now(timezone.utc).isoformat()
    record.setdefault('originalTranscript', record.get('transcript', ''))
    if index is not None:
        target.setdefault('originalText', previous)
    target[key] = text
    target.update(textManuallyEdited=True, textEditedAt=now)
    if segments:
        # Use the same timeline ordering as the transcript viewer, without reindexing segments.
        def timed(segment):
            start, end = segment.get('start'), segment.get('end')
            return all(isinstance(v, (int, float)) and math.isfinite(v) for v in (start, end)) and 0 <= start <= end
        ordered = sorted(enumerate(segments), key=lambda item: (item[1]['start'], item[0])) if all(timed(s) for s in segments) else enumerate(segments)
        record['transcript'] = '\n'.join(str(segment.get('text') or '').strip() for _, segment in ordered if str(segment.get('text') or '').strip())
        annotate_segment(target)
        record['reviewInfo'] = summarize_review(segments)
    revision = int(record.get('transcriptRevision') or 0) + 1
    record.update(transcriptRevision=revision, transcriptEditedAt=now,
                  importantInfoStale=bool(record.get('importantInfo')),
                  message='转写文字已保存' + ('，请重新提取重点以更新摘要' if record.get('importantInfo') else ''))
    record.setdefault('transcriptEdits', []).append({
        'revision': revision, 'segmentIndex': index, 'previousText': previous, 'text': text, 'editedAt': now,
    })
    return True

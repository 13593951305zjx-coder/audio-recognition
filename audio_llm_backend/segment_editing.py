"""Validated timing/split/merge operations with revision checks and one-step undo."""
from copy import deepcopy
from datetime import datetime, timezone
import math

from chinese_text import simplify_value
from transcript_editing import TranscriptConflictError
from transcript_review import annotate_segment, summarize_review

MIN_PART = .05


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _range(start, end, duration):
    if not (_number(start) and _number(end) and 0 <= start < end <= duration + .000001):
        raise ValueError('时间段需满足 0 ≤ 开始 < 结束，且不能超出原音频时长')
    if end - start < MIN_PART - .000001:
        raise ValueError('每段语音至少需要 0.05 秒')


def next_segment_index(segments, index):
    ordered = sorted((i for i, item in enumerate(segments)
                      if _number(item.get('start')) and _number(item.get('end'))),
                     key=lambda i: (segments[i]['start'], i))
    position = ordered.index(index)
    return ordered[position + 1] if position + 1 < len(ordered) else None


def _changed(segment, operation):
    segment['timingManuallyEdited'] = True
    if operation != 'timing':
        segment['structureManuallyEdited'] = True
    # Old word and sentence scores describe a different audio/text range.
    segment.pop('words', None)
    segment.pop('asrMetrics', None)
    annotate_segment(segment)


def _speaker_counts(record):
    for speaker in record.get('speakers') or []:
        selected = [s for s in record['segments'] if s.get('speakerId') == speaker['id']]
        speaker['segmentCount'] = len(selected)
        ranges = sorted((s['start'], s['end']) for s in selected if _number(s.get('start')) and _number(s.get('end')) and s['end'] > s['start'])
        total, right = 0, -1
        for start, end in ranges:
            total += max(0, end - max(start, right))
            right = max(right, end)
        speaker['duration'] = round(total, 3)


def adjust_segments(record, request, duration):
    revision = int(record.get('transcriptRevision') or 0)
    if request['expectedRevision'] != revision:
        raise TranscriptConflictError('转写或分句已在其他窗口修改，请重新打开记录后再调整；当前修改尚未保存。')
    segments = record.get('segments') or []
    if not segments:
        raise ValueError('这条记录没有分句时间，无法调整波形分句')
    operation = request['operation']
    before = deepcopy(segments)
    audit_before, audit_after = before, []
    previous_timeline_flag = bool(record.get('timelineManuallyEdited'))
    previous_speaker_stats = [{key: speaker[key] for key in ('id', 'duration', 'segmentCount') if key in speaker} for speaker in record.get('speakers') or []]
    undo = record.get('segmentUndo')
    if operation == 'undo':
        if not undo or undo.get('revision') != revision:
            raise TranscriptConflictError('没有可撤销的上一步分句调整，或此后已有其他修改')
        segments = deepcopy(undo['segments'])
        record['timelineManuallyEdited'] = undo.get('timelineManuallyEdited', False)
    else:
        index = request['segmentIndex']
        if index is None or not 0 <= index < len(segments):
            raise LookupError('所选转写片段不存在')
        # Work on copies so rejected operations never partly mutate a record.
        segments = deepcopy(segments)
        segment = segments[index]
        audit_before = [deepcopy(segment)]
        if operation != 'timing':
            _range(segment.get('start'), segment.get('end'), duration)
        if operation == 'timing':
            start, end = request.get('start'), request.get('end')
            _range(start, end, duration)
            if (start, end) == (segment['start'], segment['end']):
                return False
            segment.update(start=round(start, 5), end=round(end, 5))
            _changed(segment, operation)
            audit_after = [deepcopy(segment)]
        elif operation == 'split':
            split = request.get('splitAt')
            _range(segment['start'], split, duration)
            _range(split, segment['end'], duration)
            left = simplify_value(request.get('leftText') or '').strip()
            right = simplify_value(request.get('rightText') or '').strip()
            if not left or not right or len(left) > 20000 or len(right) > 20000:
                raise ValueError('拆分后的两句都需包含文字，每句最多 20000 字')
            compact = lambda text: ''.join(text.split())
            if compact(left + right) != compact(str(segment.get('text') or '')):
                raise ValueError('拆分后的文字需与原句一致，不能丢字或重复；错字请先用“编辑文字”修改')
            first, second = deepcopy(segment), deepcopy(segment)
            # Original text restoration after a split must not duplicate the whole old sentence.
            for item in (first, second):
                item.pop('originalText', None)
                item.pop('segmentId', None)
            first.update(end=round(split, 5), text=left)
            second.update(start=round(split, 5), text=right)
            _changed(first, operation); _changed(second, operation)
            segments[index:index + 1] = [first, second]
            audit_after = [deepcopy(first), deepcopy(second)]
        elif operation == 'merge':
            other_index = next_segment_index(segments, index)
            if other_index is None or other_index != request.get('nextIndex'):
                raise ValueError('请选择按时间排列的下一句进行合并')
            other = segments[other_index]
            audit_before.append(deepcopy(other))
            _range(other.get('start'), other.get('end'), duration)
            if segment.get('speakerId') != other.get('speakerId') and not request.get('confirmSpeakerChange'):
                raise ValueError('两句说话人不同，请明确选择合并后的说话人')
            speaker = request.get('speakerId') if request.get('confirmSpeakerChange') else segment.get('speakerId')
            known = {item['id'] for item in record.get('speakers') or []}
            if speaker is not None and speaker not in known:
                raise ValueError('所选说话人不存在，请重新选择')
            text = str(segment.get('text') or '').strip() + '\n' + str(other.get('text') or '').strip()
            if len(text) > 20000:
                raise ValueError('合并后文字超过 20000 字，请缩小合并范围')
            segment.update(start=min(segment['start'], other['start']), end=max(segment['end'], other['end']),
                           text=text, speakerId=speaker, speakerMixed=False, speakerManuallyAssigned=True)
            segment.pop('originalText', None)
            _changed(segment, operation)
            segments.pop(other_index)
            audit_after = [deepcopy(segment)]
        else:
            raise ValueError('不支持的分句操作')
        record['timelineManuallyEdited'] = True
    record.setdefault('originalSegments', before)
    record.setdefault('originalTranscript', record.get('transcript', ''))
    now = datetime.now(timezone.utc).isoformat()
    record['segments'] = segments
    ordered = sorted(enumerate(segments), key=lambda item: (item[1]['start'] if _number(item[1].get('start')) else math.inf, item[0]))
    record['transcript'] = '\n'.join(str(segment.get('text') or '').strip() for _, segment in ordered if str(segment.get('text') or '').strip())
    record.update(transcriptRevision=revision + 1, segmentStructureRevision=int(record.get('segmentStructureRevision') or 0) + (operation in ('split', 'merge', 'undo')),
                  transcriptEditedAt=now, importantInfoStale=bool(record.get('importantInfo')),
                  message='已撤销上一步分句调整' if operation == 'undo' else '波形分句调整已保存，可试听并核对')
    record['reviewInfo'] = summarize_review(segments)
    _speaker_counts(record)
    if operation == 'undo' and not record['timelineManuallyEdited']:
        previous = {item['id']: item for item in undo.get('speakerStats', [])}
        for speaker in record.get('speakers') or []:
            if speaker['id'] in previous:
                for field in ('duration', 'segmentCount'):
                    if field in previous[speaker['id']]: speaker[field] = previous[speaker['id']][field]
    record.setdefault('segmentEditHistory', []).append({'operation': operation, 'revision': revision + 1,
        'segmentIndex': request.get('segmentIndex'), 'at': now, 'before': audit_before,
        'after': deepcopy(segments) if operation == 'undo' else audit_after})
    if operation == 'undo':
        record.pop('segmentUndo', None)
    else:
        record['segmentUndo'] = {'revision': revision + 1, 'segments': before, 'timelineManuallyEdited': previous_timeline_flag, 'speakerStats': previous_speaker_stats}
    return True

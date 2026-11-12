// Statistics use diarization turns for speaking time and transcript segments for text counts.
// A manual sentence assignment replaces the model's turns within that sentence's time range.
function calculateSpeakerStats(record) {
  const speakers = Array.isArray(record?.speakers) ? record.speakers : [];
  const segments = Array.isArray(record?.segments) ? record.segments : [];
  const known = new Set(speakers.map((speaker) => speaker.id));
  const unknown = "__unknown__";
  const ranges = new Map();
  const counts = new Map();
  const validRange = (item) => {
    if (item?.start == null || item?.end == null || item.start === "" || item.end === "") return null;
    const start = Number(item?.start), end = Number(item?.end);
    return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start ? { start, end } : null;
  };
  const group = (id) => known.has(id) ? id : unknown;
  const addRange = (id, start, end) => {
    if (end <= start) return;
    if (!ranges.has(id)) ranges.set(id, []);
    ranges.get(id).push({ start, end });
  };
  const manual = segments.flatMap((segment) => {
    const time = segment?.speakerManuallyAssigned ? validRange(segment) : null;
    return time ? [{ ...time, id: group(segment.speakerId) }] : [];
  }).sort((a, b) => a.start - b.start);
  const turns = (!record?.timelineManuallyEdited && Array.isArray(record?.speakerTurns) ? record.speakerTurns : []).flatMap((turn) => {
    const time = validRange(turn);
    return time ? [{ ...time, id: group(turn.speakerId) }] : [];
  });

  if (turns.length) {
    for (const turn of turns) {
      let pieces = [{ start: turn.start, end: turn.end }];
      for (const override of manual) {
        if (override.start >= turn.end) break;
        if (override.end <= turn.start) continue;
        pieces = pieces.flatMap((piece) => {
          if (override.end <= piece.start || override.start >= piece.end) return [piece];
          const remaining = [];
          if (override.start > piece.start) remaining.push({ start: piece.start, end: override.start });
          if (override.end < piece.end) remaining.push({ start: override.end, end: piece.end });
          return remaining;
        });
      }
      pieces.forEach((piece) => addRange(turn.id, piece.start, piece.end));
    }
    manual.forEach((override) => addRange(override.id, override.start, override.end));
  } else {
    segments.forEach((segment) => {
      const time = validRange(segment);
      if (time) addRange(group(segment.speakerId), time.start, time.end);
    });
  }

  segments.forEach((segment) => {
    if (typeof segment?.text !== "string" || !segment.text.trim()) return;
    const id = group(segment.speakerId);
    const current = counts.get(id) || { sentences: 0, characters: 0 };
    current.sentences += 1;
    current.characters += (segment.text.match(/[\p{L}\p{N}]/gu) || []).length;
    counts.set(id, current);
  });

  const duration = (items) => {
    if (!items?.length) return 0;
    const ordered = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
    let start = ordered[0].start, end = ordered[0].end, seconds = 0;
    for (const item of ordered.slice(1)) {
      if (item.start <= end) end = Math.max(end, item.end);
      else { seconds += end - start; start = item.start; end = item.end; }
    }
    return seconds + end - start;
  };
  const ids = speakers.map((speaker) => speaker.id);
  if (ranges.has(unknown) || counts.has(unknown)) ids.push(unknown);
  const raw = ids.map((id) => {
    const speaker = speakers.find((item) => item.id === id);
    const count = counts.get(id) || { sentences: 0, characters: 0 };
    return { id, label: speaker?.label || (id === unknown ? "未确定说话人" : speaker?.code ? `说话人 ${speaker.code}` : String(id)),
      seconds: duration(ranges.get(id)), sentences: count.sentences, characters: count.characters };
  });
  const totalSeconds = raw.reduce((sum, row) => sum + row.seconds, 0);
  const round = (value, places) => Number(value.toFixed(places));
  return { hasModelTurns: turns.length > 0, totalSeconds: round(totalSeconds, 2),
    rows: raw.map((row) => ({ ...row, seconds: round(row.seconds, 2), percentage: totalSeconds ? round(100 * row.seconds / totalSeconds, 1) : 0 })) };
}

"""Literal, case-insensitive keyword search over saved transcript segments."""
import json
import re

from chinese_text import simplify_record_text, simplify_value


def search_records(paths, query, limit=100):
    needle = simplify_value(query.strip()).casefold()
    matches, total = [], 0
    records = []
    for path in paths:
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(record, dict) or not re.fullmatch(r"[0-9a-f]{32}", str(record.get("taskId", ""))):
                continue
            simplify_record_text(record)
            records.append(record)
        except (ValueError, OSError, TypeError):
            continue
    records.sort(key=lambda record: str(record.get("createdAt", "")), reverse=True)
    for record in records:
        rows = record.get("segments") if isinstance(record.get("segments"), list) else []
        if not rows:
            rows = [{"text": record.get("transcript", "")}]
        names = {speaker.get("id"): speaker.get("label", "") for speaker in record.get("speakers", []) if isinstance(speaker, dict)}
        for index, row in enumerate(rows):
            if not isinstance(row, dict) or not isinstance(row.get("text"), str) or needle not in row["text"].casefold():
                continue
            total += 1
            if len(matches) < limit:
                matches.append({"taskId": record["taskId"], "fileName": record.get("displayName") or record.get("fileName", "未命名录音"),
                                "segmentIndex": index if record.get("segments") else None,
                                "start": row.get("start"), "end": row.get("end"), "text": row["text"],
                                "speakerLabel": names.get(row.get("speakerId"), "")})
    return {"query": simplify_value(query.strip()), "matches": matches, "total": total, "truncated": total > limit}

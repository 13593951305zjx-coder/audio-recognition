"""Normalize result text to simplified Chinese without changing audio or timing."""

from __future__ import annotations

import threading
from typing import Any

from opencc import OpenCC

_CONVERTER = OpenCC("t2s")
_CONVERTER_LOCK = threading.Lock()


def simplify_value(value: Any) -> Any:
    if isinstance(value, str):
        with _CONVERTER_LOCK:
            return _CONVERTER.convert(value)
    if isinstance(value, list):
        return [simplify_value(item) for item in value]
    if isinstance(value, dict):
        return {key: simplify_value(item) for key, item in value.items()}
    return value


def simplify_record_text(record: dict[str, Any]) -> bool:
    """Convert only result fields; filenames, paths, IDs and metrics stay intact."""
    changed = False
    for name in ("transcript", "segments", "importantInfo"):
        if name in record:
            simplified = simplify_value(record[name])
            if simplified != record[name]:
                record[name] = simplified
                changed = True
    return changed

from __future__ import annotations

import json
import re
import sys
from datetime import UTC, datetime
from typing import Literal

_REDACTED = "[REDACTED]"
_SENSITIVE_KEY = re.compile(
    r"authorization|cookie|credential|password|secret|session|token|signed.?url|prediction",
    re.IGNORECASE,
)


def redact_log_value(value: object) -> object:
    if isinstance(value, dict):
        return {
            str(key): (
                _REDACTED
                if _SENSITIVE_KEY.search(str(key))
                else redact_log_value(entry)
            )
            for key, entry in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact_log_value(entry) for entry in value]
    return value


def write_structured_log(
    level: Literal["error", "info"], event: str, **context: object
) -> None:
    entry = redact_log_value(
        {
            **context,
            "event": event,
            "level": level,
            "service": "worker",
            "timestamp": datetime.now(UTC).isoformat(),
        }
    )
    output = json.dumps(entry, separators=(",", ":"), sort_keys=True)
    print(output, file=sys.stderr if level == "error" else sys.stdout, flush=True)

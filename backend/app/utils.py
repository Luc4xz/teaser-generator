from __future__ import annotations

import json
import re
from typing import Any, Dict, Optional


JSON_BLOCK_RE = re.compile(r"\{[\s\S]*\}")


def parse_json_maybe(text: str) -> Optional[Dict[str, Any]]:
    if not text:
        return None

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    match = JSON_BLOCK_RE.search(text)
    if not match:
        return None

    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None

"""Export PATTERN_RECOGNIZERS / weights / thresholds from data_classifier.py
into a GradeProfile JSON bundle consumed by the browser extension's T1 JS engine.

Usage:
    python export_patterns.py [output_path]

Default output: dist/<GRADE_PROFILE_ID>.gradeprofile.json
Also copies the bundle into extension/src/engine/gradeProfile.json so the
extension build always ships the latest profile (single source of truth).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from data_classifier import (  # noqa: E402
    BULK_PII_THRESHOLD,
    BULK_PII_TYPES,
    C_THRESHOLD,
    DEFAULT_ENTITY_WEIGHT,
    ENTITY_COUNT_CAP,
    ENTITY_WEIGHTS,
    GRADE_KEYWORDS,
    GRADE_PROFILE_ID,
    KW_COUNT_CAP,
    PATTERN_RECOGNIZERS,
    S_THRESHOLD,
)

PY_TO_JS_FLAGS = {
    re.IGNORECASE: "i",
}


def flags_to_js(flags: int) -> str:
    js_flags = "g"  # engine always uses matchAll -> needs global
    for py_flag, js_flag in PY_TO_JS_FLAGS.items():
        if flags & py_flag:
            js_flags += js_flag
    return js_flags


def build_bundle() -> dict:
    recognizers = []
    for r in PATTERN_RECOGNIZERS:
        recognizers.append(
            {
                "name": r.name,
                "pattern": r.pattern,
                "flags": flags_to_js(r.flags),
                "description": r.description,
                "validator": r.validator,
                "weight": ENTITY_WEIGHTS.get(r.name, 1.0),
            }
        )
    keywords = [{"keyword": kw, "weight": w, "label": label} for kw, w, label in GRADE_KEYWORDS]

    return {
        "gradeProfile": GRADE_PROFILE_ID,
        "generatedFrom": "profiles/data_classifier.py",
        "thresholds": {
            "cThreshold": C_THRESHOLD,
            "sThreshold": S_THRESHOLD,
            "bulkPiiThreshold": BULK_PII_THRESHOLD,
        },
        "defaultEntityWeight": DEFAULT_ENTITY_WEIGHT,
        "entityCountCap": ENTITY_COUNT_CAP,
        "kwCountCap": KW_COUNT_CAP,
        "bulkPiiTypes": sorted(BULK_PII_TYPES),
        "recognizers": recognizers,
        "keywords": keywords,
    }


def main() -> None:
    bundle = build_bundle()
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "dist" / f"{bundle['gradeProfile']}.gradeprofile.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out_path}")

    extension_copy = Path(__file__).parent.parent / "extension" / "src" / "engine" / "gradeProfile.json"
    if extension_copy.parent.exists():
        extension_copy.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"wrote {extension_copy}")


if __name__ == "__main__":
    main()

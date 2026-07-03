"""N2SF-aligned data classifier — single source of truth for PII/secret detection.

Pattern set, entity weights, keyword list, and grade thresholds defined here
are exported (via export_patterns.py) into a GradeProfile JSON bundle
consumed verbatim by the browser extension's JS engine, so server-side and
client-side judgments stay identical without re-implementing the rules
twice.

This is a JS-portable *subset* of the full document classifier
(`data_classifier.py`/`data_classifier.md` at the repo root, the
classifier-svc integration with Presidio/spaCy NER + optional neural tiers)
— regex + weights + keyword-escalation + thresholds only. NER/neural tiers
stay out of scope here by design (plan doc §2.3: no in-browser neural
inference, 50ms budget), so file/document classification using the full
pipeline remains a server-side concern. Weights, thresholds, count caps, and
the keyword list are kept numerically aligned with that root-level file
wherever the concept is portable, so a prompt/text snippet gets the same
grade whether judged by this module or by the full classifier.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

GRADE_PROFILE_ID = "n2sf-v1"

# ---------------------------------------------------------------------------
# Pattern recognizers
# ---------------------------------------------------------------------------
# Each recognizer is a compiled-regex + validator pair. `validator` is an
# optional extra check (e.g. checksum) applied to every regex match before
# it counts as a detection. The root classifier's Presidio-based recognizers
# rely on multi-pattern confidence scores instead of hard checksums; we keep
# checksum validation here deliberately (KR_RRN, CREDIT_CARD/Luhn) since it
# cuts false positives without needing Presidio's NLP context boosting,
# which isn't available in this lightweight/browser-portable path.


def _luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _kr_rrn_checksum_ok(rrn_digits: str) -> bool:
    # Korean Resident Registration Number checksum (mod-11).
    if len(rrn_digits) != 13:
        return False
    weights = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5]
    total = sum(int(d) * w for d, w in zip(rrn_digits[:12], weights))
    check = (11 - (total % 11)) % 10
    return check == int(rrn_digits[12])


@dataclass(frozen=True)
class PatternRecognizer:
    name: str
    pattern: str
    flags: int = 0
    description: str = ""
    validator: str | None = None  # name of validator applied post-match, or None

    def compiled(self) -> re.Pattern:
        return re.compile(self.pattern, self.flags)


PATTERN_RECOGNIZERS: list[PatternRecognizer] = [
    PatternRecognizer(
        name="KR_RRN",
        pattern=r"\b\d{6}[-\s]?[1-4]\d{6}\b",
        description="Korean Resident Registration Number (주민등록번호)",
        validator="kr_rrn_checksum",
    ),
    PatternRecognizer(
        name="KR_PHONE",
        pattern=r"\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b",
        description="Korean mobile phone number",
    ),
    PatternRecognizer(
        name="KR_ACCOUNT",
        pattern=r"\b\d{2,6}[-\s]\d{2,6}[-\s]\d{2,8}\b",
        description="Korean bank account number (hyphenated groups)",
    ),
    PatternRecognizer(
        name="CREDIT_CARD",
        pattern=r"\b(?:\d[ -]?){13,16}\b",
        description="Credit card number (Luhn-validated)",
        validator="luhn",
    ),
    PatternRecognizer(
        name="EMAIL_ADDRESS",
        pattern=r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
        description="Email address",
    ),
    PatternRecognizer(
        name="AWS_ACCESS_KEY",
        pattern=r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
        description="AWS Access Key ID",
    ),
    PatternRecognizer(
        name="AWS_SECRET_KEY",
        pattern=r"(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])",
        description="AWS Secret Access Key (heuristic, high false-positive without context)",
    ),
    PatternRecognizer(
        name="GENERIC_API_KEY",
        pattern=r"\b(?:api[_-]?key|secret|token)['\"]?\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{16,}['\"]?",
        flags=re.IGNORECASE,
        description="Generic API key / secret / token assignment",
    ),
    PatternRecognizer(
        name="PRIVATE_KEY_BLOCK",
        pattern=r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
        description="PEM private key block header",
    ),
    PatternRecognizer(
        name="IP_ADDRESS",
        pattern=r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b",
        description="IPv4 address",
    ),
]

_VALIDATORS = {
    "kr_rrn_checksum": lambda m: _kr_rrn_checksum_ok(re.sub(r"[-\s]", "", m)),
    "luhn": lambda m: _luhn_ok(re.sub(r"[ -]", "", m)),
}

# ---------------------------------------------------------------------------
# Scoring model
# ---------------------------------------------------------------------------
# Weight per detected entity type; unlisted types default to DEFAULT_ENTITY_WEIGHT.
# Values kept numerically aligned with the root data_classifier.py's
# ENTITY_WEIGHTS for every type both files recognize.
ENTITY_WEIGHTS: dict[str, float] = {
    "KR_RRN": 6.0,
    "KR_ACCOUNT": 6.0,
    "CREDIT_CARD": 6.0,
    "AWS_ACCESS_KEY": 6.0,
    "AWS_SECRET_KEY": 6.0,
    "PRIVATE_KEY_BLOCK": 6.0,
    "GENERIC_API_KEY": 3.5,
    "KR_PHONE": 1.0,
    "EMAIL_ADDRESS": 1.0,
    "IP_ADDRESS": 0.4,
}
# Fallback weight for any recognizer/entity type not listed above.
DEFAULT_ENTITY_WEIGHT = 0.05

# Any single entity type reaching this weighted score alone => grade C.
C_THRESHOLD = 5.5
# Absolute weighted score at/above which grade S kicks in (NOT a fraction of
# C_THRESHOLD — mirrors the root classifier's `_score()`, where a single
# EMAIL_ADDRESS or KR_PHONE hit already crosses 0.75 and lands at S).
S_THRESHOLD = 0.75
# Total PII detection *count* (irrespective of type, but restricted to
# BULK_PII_TYPES) that forces grade C even if per-type weights wouldn't
# (bulk exposure, e.g. a mailing list or customer export).
BULK_PII_THRESHOLD = 10
# Only "personal identifier" style types count toward bulk escalation —
# credentials/secrets are already high-weight individually and shouldn't
# also trigger the bulk-count path (mirrors the root classifier's
# BULK_PII_TYPES, restricted to the identifier types this module supports).
BULK_PII_TYPES = {"KR_RRN", "KR_PHONE", "EMAIL_ADDRESS", "KR_ACCOUNT", "CREDIT_CARD"}
# Non-C-tier detections stop contributing additional score past this many
# occurrences of the same type (repeated low-weight matches, e.g. many
# emails, shouldn't linearly inflate the score — bulk exposure is instead
# caught by BULK_PII_THRESHOLD above). C-tier types (weight >= C_THRESHOLD)
# are exempt: a single occurrence already forces C, and capping wouldn't
# change the outcome, so we keep counting them uncapped for accurate scoring/logs.
ENTITY_COUNT_CAP = 2

# Grade-label keyword escalation (문서/프롬프트에 등급 키워드가 직접 포함된 경우).
# (keyword, weight, display label) — case-insensitive substring match.
GRADE_KEYWORDS: list[tuple[str, float, str]] = [
    ("극비", 4.0, "극비"),
    ("top secret", 4.0, "Top Secret"),
    ("대외비", 3.0, "대외비"),
    ("기밀", 3.0, "기밀"),
    ("confidential", 3.0, "Confidential"),
    ("secret", 2.5, "Secret"),
    ("機密", 3.0, "機密"),
    ("社外秘", 3.0, "社外秘"),
    ("机密", 3.0, "机密"),
    ("内部", 1.5, "内部"),
    ("内部用", 1.5, "内部用"),
    ("内部资料", 1.5, "内部资料"),
    ("内部資料", 1.5, "内部資料"),
    ("社内限", 1.5, "社内限"),
    ("internal use", 1.5, "Internal Use"),
    ("restricted", 1.5, "Restricted"),
    ("private", 1.0, "Private"),
    ("개인정보", 1.0, "개인정보 라벨"),
]
# Keyword matches of the same keyword stop contributing additional score
# past this many occurrences (same rationale as ENTITY_COUNT_CAP).
KW_COUNT_CAP = 3


@dataclass
class Detection:
    type: str
    count: int
    weight: float
    samples: list[str] = field(default_factory=list)


@dataclass
class ClassificationResult:
    grade: str  # "O" | "S" | "C"
    score: float
    detections: list[Detection]


def _mask(value: str) -> str:
    if len(value) <= 4:
        return "*" * len(value)
    keep = max(2, len(value) // 4)
    return value[:keep] + "*" * (len(value) - keep)


def _scan_keywords(text: str) -> list[Detection]:
    lower = text.lower()
    out: list[Detection] = []
    for keyword, weight, label in GRADE_KEYWORDS:
        needle = keyword.lower()
        count = 0
        idx = 0
        while True:
            j = lower.find(needle, idx)
            if j < 0:
                break
            count += 1
            idx = j + len(needle)
            if count >= KW_COUNT_CAP * 2:
                break
        if count:
            out.append(Detection(type=f"KEYWORD:{label}", count=count, weight=weight, samples=[label]))
    return out


def classify(text: str, *, max_samples_per_type: int = 3) -> ClassificationResult:
    """Run T1 regex + keyword classification over `text` and return a grade/score/detections."""
    detections: list[Detection] = []
    total_score = 0.0

    for recognizer in PATTERN_RECOGNIZERS:
        matches = [m.group(0) for m in recognizer.compiled().finditer(text)]
        if recognizer.validator:
            validator_fn = _VALIDATORS[recognizer.validator]
            matches = [m for m in matches if validator_fn(m)]
        if not matches:
            continue
        weight = ENTITY_WEIGHTS.get(recognizer.name, DEFAULT_ENTITY_WEIGHT)
        cap = len(matches) if weight >= C_THRESHOLD else min(len(matches), ENTITY_COUNT_CAP)
        total_score += weight * cap
        detections.append(
            Detection(
                type=recognizer.name,
                count=len(matches),
                weight=weight,
                samples=[_mask(m) for m in matches[:max_samples_per_type]],
            )
        )

    for kw_detection in _scan_keywords(text):
        cap = min(kw_detection.count, KW_COUNT_CAP)
        total_score += kw_detection.weight * cap
        detections.append(kw_detection)

    if total_score >= C_THRESHOLD:
        grade = "C"
    elif total_score >= S_THRESHOLD:
        grade = "S"
    else:
        grade = "O"

    bulk_count = sum(d.count for d in detections if d.type in BULK_PII_TYPES)
    if bulk_count >= BULK_PII_THRESHOLD:
        grade = "C"

    return ClassificationResult(grade=grade, score=round(total_score, 2), detections=detections)


if __name__ == "__main__":
    import json
    import sys

    sample = sys.argv[1] if len(sys.argv) > 1 else "제 주민번호는 900101-1234567 입니다."
    result = classify(sample)
    print(
        json.dumps(
            {
                "grade": result.grade,
                "score": result.score,
                "detections": [d.__dict__ for d in result.detections],
            },
            ensure_ascii=False,
            indent=2,
        )
    )

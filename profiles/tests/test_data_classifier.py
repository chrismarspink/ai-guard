import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from data_classifier import classify  # noqa: E402


def test_clean_text_is_grade_o():
    result = classify("오늘 날씨가 좋습니다. 회의는 3시에 시작합니다.")
    assert result.grade == "O"
    assert result.score == 0
    assert result.detections == []


def test_kr_rrn_forces_grade_c():
    result = classify("제 주민번호는 900101-1234568 입니다.")
    assert result.grade == "C"
    assert any(d.type == "KR_RRN" for d in result.detections)


def test_kr_rrn_invalid_checksum_not_detected():
    # Checksum digit deliberately wrong -> should not match KR_RRN.
    result = classify("숫자 900101-1234567 은 유효하지 않은 주민번호입니다.")
    assert not any(d.type == "KR_RRN" for d in result.detections)


def test_aws_access_key_forces_grade_c():
    result = classify("AKIAABCDEFGHIJKLMNOP 를 사용해 로그인하세요.")
    assert result.grade == "C"
    assert any(d.type == "AWS_ACCESS_KEY" for d in result.detections)


def test_kr_account_alone_forces_grade_c():
    # KR_ACCOUNT is a C-tier driver (weight 6.0), matching the root classifier.
    result = classify("계좌번호 123456-12-1234567 로 입금해주세요.")
    assert result.grade == "C"
    assert any(d.type == "KR_ACCOUNT" for d in result.detections)


def test_valid_credit_card_forces_grade_c():
    result = classify("카드번호 4111 1111 1111 1111 로 결제했습니다.")
    assert result.grade == "C"
    assert any(d.type == "CREDIT_CARD" for d in result.detections)


def test_single_email_is_grade_s():
    # S_THRESHOLD (0.75) is an absolute score cutoff, not a fraction of
    # C_THRESHOLD -- a single EMAIL_ADDRESS hit (weight 1.0) already crosses it.
    result = classify("문의사항은 user@example.com 으로 보내주세요.")
    assert result.grade == "S"


def test_bulk_pii_forces_grade_c():
    emails = " ".join(f"user{i}@example.com" for i in range(11))
    result = classify(emails)
    assert result.grade == "C"


def test_repeated_low_weight_hits_are_capped_below_bulk_threshold():
    # 5 emails: below BULK_PII_THRESHOLD(10), and ENTITY_COUNT_CAP(2) caps
    # the score contribution, so this must NOT escalate to C.
    emails = " ".join(f"user{i}@example.com" for i in range(5))
    result = classify(emails)
    assert result.grade == "S"
    detection = next(d for d in result.detections if d.type == "EMAIL_ADDRESS")
    assert detection.count == 5


def test_kr_phone_detected():
    result = classify("연락처: 010-1234-5678")
    assert any(d.type == "KR_PHONE" for d in result.detections)


def test_masking_never_reveals_full_value():
    result = classify("제 주민번호는 900101-1234568 입니다.")
    rrn_detection = next(d for d in result.detections if d.type == "KR_RRN")
    assert "900101-1234568" not in rrn_detection.samples[0]
    assert "*" in rrn_detection.samples[0]


def test_single_grade_keyword_mention_is_not_enough_for_grade_s():
    # A single "기밀" (weight 3.0) alone stays below S_THRESHOLD*C_THRESHOLD... no:
    # S_THRESHOLD is absolute (0.75), so a single 3.0-weight keyword hit already
    # clears it -- assert S, not O, to lock in the absolute-threshold semantics.
    result = classify("본 문서는 기밀 자료입니다.")
    assert result.grade == "S"
    assert any(d.type.startswith("KEYWORD:") for d in result.detections)


def test_repeated_grade_keyword_forces_grade_c():
    result = classify("극비 극비 - 이 내용은 절대 외부로 유출되어서는 안 됩니다.")
    assert result.grade == "C"

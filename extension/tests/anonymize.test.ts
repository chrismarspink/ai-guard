import { describe, expect, it } from "vitest";
import { anonymizeText } from "../src/engine/anonymize";
import { classify } from "../src/engine/t1-engine";

describe("anonymizeText", () => {
  it("masks a detected RRN in place and re-classifying the result no longer flags it", () => {
    const text = "제 주민번호는 900101-1234568 입니다.";
    const result = classify(text);
    const anonymized = anonymizeText(text, result);

    expect(anonymized).not.toContain("900101-1234568");
    expect(anonymized).toContain("*");

    const reclassified = classify(anonymized);
    expect(reclassified.grade).toBe("O");
  });

  it("masks multiple distinct entity spans without corrupting surrounding text", () => {
    const text = "연락처는 010-1234-5678 이고 이메일은 user@example.com 입니다.";
    const result = classify(text);
    const anonymized = anonymizeText(text, result);

    expect(anonymized).not.toContain("010-1234-5678");
    expect(anonymized).not.toContain("user@example.com");
    expect(anonymized.startsWith("연락처는")).toBe(true);
    expect(anonymized).toContain("이고 이메일은");
    expect(anonymized.endsWith("입니다.")).toBe(true);
  });

  it("leaves grade-keyword mentions untouched (not PII)", () => {
    const text = "이 문서는 기밀 자료입니다.";
    const anonymized = anonymizeText(text, classify(text));
    expect(anonymized).toBe(text);
  });

  it("is a no-op on clean text", () => {
    const text = "오늘 회의 잘 부탁드립니다.";
    expect(anonymizeText(text, classify(text))).toBe(text);
  });
});

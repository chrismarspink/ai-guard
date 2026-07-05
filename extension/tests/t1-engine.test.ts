import { describe, expect, it } from "vitest";
import { classify } from "../src/engine/t1-engine";

describe("t1-engine classify", () => {
  it("grades clean text as O with no detections", () => {
    const result = classify("오늘 날씨가 좋습니다. 회의는 3시에 시작합니다.");
    expect(result.grade).toBe("O");
    expect(result.score).toBe(0);
    expect(result.detections).toEqual([]);
  });

  it("grades a valid KR RRN as C", () => {
    const result = classify("제 주민번호는 900101-1234568 입니다.");
    expect(result.grade).toBe("C");
    expect(result.detections.some((d) => d.type === "KR_RRN")).toBe(true);
  });

  it("does not detect a KR RRN with a bad checksum", () => {
    const result = classify("숫자 900101-1234567 은 유효하지 않은 주민번호입니다.");
    expect(result.detections.some((d) => d.type === "KR_RRN")).toBe(false);
  });

  it("grades an AWS access key as C", () => {
    const result = classify("AKIAABCDEFGHIJKLMNOP 를 사용해 로그인하세요.");
    expect(result.grade).toBe("C");
    expect(result.detections.some((d) => d.type === "AWS_ACCESS_KEY")).toBe(true);
  });

  it("grades a KR_ACCOUNT match alone as C (C-tier driver)", () => {
    const result = classify("계좌번호 123456-12-1234567 로 입금해주세요.");
    expect(result.grade).toBe("C");
    expect(result.detections.some((d) => d.type === "KR_ACCOUNT")).toBe(true);
  });

  it("grades a valid credit card number as C", () => {
    const result = classify("카드번호 4111 1111 1111 1111 로 결제했습니다.");
    expect(result.grade).toBe("C");
    expect(result.detections.some((d) => d.type === "CREDIT_CARD")).toBe(true);
  });

  it("grades a single email as S (sThreshold is an absolute cutoff, not a ratio)", () => {
    const result = classify("문의사항은 user@example.com 으로 보내주세요.");
    expect(result.grade).toBe("S");
  });

  it("grades bulk PII (11 emails) as C", () => {
    const emails = Array.from({ length: 11 }, (_, i) => `user${i}@example.com`).join(" ");
    const result = classify(emails);
    expect(result.grade).toBe("C");
  });

  it("caps repeated low-weight hits below the bulk threshold at S, not C", () => {
    const emails = Array.from({ length: 5 }, (_, i) => `user${i}@example.com`).join(" ");
    const result = classify(emails);
    expect(result.grade).toBe("S");
    const detection = result.detections.find((d) => d.type === "EMAIL_ADDRESS");
    expect(detection?.count).toBe(5);
  });

  it("detects a KR phone number", () => {
    const result = classify("연락처: 010-1234-5678");
    expect(result.detections.some((d) => d.type === "KR_PHONE")).toBe(true);
  });

  it("does not misclassify a lone mobile phone number as a KR_ACCOUNT (C)", () => {
    const result = classify("연락처: 010-1234-5678");
    expect(result.detections.some((d) => d.type === "KR_ACCOUNT")).toBe(false);
    expect(result.grade).not.toBe("C");
  });

  it("does not false-positive an all-lowercase-hex git SHA as an AWS secret key", () => {
    const result = classify("커밋 356a192b7913b04c54574d18c28d46e6395428ab 를 확인하세요.");
    expect(result.detections.some((d) => d.type === "AWS_SECRET_KEY")).toBe(false);
  });

  it("still detects a secret-like 40-char mixed-case+digit token as C", () => {
    // Assemble the 40-char base64-charset token (lower+upper+digit) at runtime so
    // no contiguous 40-char literal lives in source to trip secret scanners; it
    // still exercises the AWS_SECRET_KEY recognizer's shape without a credential.
    const token = "aB1cD2eF3g".repeat(4); // 40 chars
    const result = classify(`토큰 ${token} 를 확인하세요.`);
    expect(result.detections.some((d) => d.type === "AWS_SECRET_KEY")).toBe(true);
    expect(result.grade).toBe("C");
  });

  it("never reveals the raw value in masked samples", () => {
    const result = classify("제 주민번호는 900101-1234568 입니다.");
    const rrnDetection = result.detections.find((d) => d.type === "KR_RRN");
    expect(rrnDetection).toBeDefined();
    expect(rrnDetection!.samples[0]).not.toContain("900101-1234568");
    expect(rrnDetection!.samples[0]).toContain("*");
  });

  it("grades a single grade-keyword mention as S", () => {
    const result = classify("본 문서는 기밀 자료입니다.");
    expect(result.grade).toBe("S");
    expect(result.detections.some((d) => d.type.startsWith("KEYWORD:"))).toBe(true);
  });

  it("grades a repeated grade-keyword mention as C", () => {
    const result = classify("극비 극비 - 이 내용은 절대 외부로 유출되어서는 안 됩니다.");
    expect(result.grade).toBe("C");
  });

  it("reports exact spans for entity detections so they can be masked in place", () => {
    const text = "제 주민번호는 900101-1234568 입니다.";
    const result = classify(text);
    const rrn = result.detections.find((d) => d.type === "KR_RRN")!;
    const [start, end] = rrn.spans[0];
    expect(text.slice(start, end)).toBe("900101-1234568");
  });

  it("does not report spans for keyword detections (not PII to mask)", () => {
    const result = classify("본 문서는 기밀 자료입니다.");
    const kw = result.detections.find((d) => d.type.startsWith("KEYWORD:"))!;
    expect(kw.spans).toEqual([]);
  });

  it("sums per-detection contributions to the total score", () => {
    const result = classify("제 주민번호는 900101-1234568 입니다.");
    const total = result.detections.reduce((sum, d) => sum + d.contribution, 0);
    expect(Math.round(total * 100) / 100).toBe(result.score);
  });
});

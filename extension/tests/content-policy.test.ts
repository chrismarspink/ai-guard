import { describe, expect, it } from "vitest";
import { decideContent } from "../src/content-scan/content-policy";

const OK = { status: "ok" as const };
const UNSUPPORTED = { status: "unsupported" as const };
const ERROR = { status: "error" as const };
const MODES = ["block", "confirm", "audit"] as const;

describe("decideContent", () => {
  for (const extract of [UNSUPPORTED, ERROR]) {
    for (const mode of MODES) {
      it(`blocks when extract.status is "${extract.status}" and fileMode is "${mode}" (fail-closed, audit override is the caller's job)`, () => {
        expect(decideContent(extract, { grade: "O" }, mode)).toBe("block");
      });
    }
  }

  for (const mode of MODES) {
    it(`allows grade O regardless of fileMode ("${mode}")`, () => {
      expect(decideContent(OK, { grade: "O" }, mode)).toBe("allow");
    });
  }

  // "audit" is not special-cased inside decideContent -- it behaves exactly
  // like "confirm" here, since applying the audit-mode allow-override on top
  // of this raw decision is the caller's responsibility (see content-policy.ts).
  for (const mode of MODES) {
    it(`asks for confirmation on grade S regardless of fileMode ("${mode}")`, () => {
      expect(decideContent(OK, { grade: "S" }, mode)).toBe("confirm");
    });
  }

  it('blocks grade C when fileMode is "block"', () => {
    expect(decideContent(OK, { grade: "C" }, "block")).toBe("block");
  });

  it('asks for confirmation on grade C when fileMode is "confirm"', () => {
    expect(decideContent(OK, { grade: "C" }, "confirm")).toBe("confirm");
  });

  it('asks for confirmation on grade C when fileMode is "audit" (caller applies the allow override)', () => {
    expect(decideContent(OK, { grade: "C" }, "audit")).toBe("confirm");
  });

  it("fails closed when status is ok but no classification was supplied", () => {
    expect(decideContent(OK, null, "confirm")).toBe("block");
  });
});

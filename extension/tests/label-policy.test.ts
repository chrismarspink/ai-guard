import { describe, expect, it } from "vitest";
import { decide } from "../src/mip/label-policy";
import type { MipResult } from "../src/mip/mip-parser";

const map = { allowO: ["good-guid"], denyUnlabeled: true };

describe("label-policy decide", () => {
  it("allows a labeled file whose GUID is in the allowlist", () => {
    const result: MipResult = { labelStatus: "labeled", fileType: "ooxml", labelGuid: "good-guid" };
    expect(decide(result, map)).toBe("allow");
  });

  it("blocks a labeled file whose GUID is not allowlisted", () => {
    const result: MipResult = { labelStatus: "labeled", fileType: "ooxml", labelGuid: "other-guid" };
    expect(decide(result, map)).toBe("block");
  });

  it("blocks unlabeled files when denyUnlabeled is true", () => {
    const result: MipResult = { labelStatus: "unlabeled", fileType: "pdf" };
    expect(decide(result, map)).toBe("block");
  });

  it("asks for confirmation on unlabeled files when denyUnlabeled is false", () => {
    const result: MipResult = { labelStatus: "unlabeled", fileType: "pdf" };
    expect(decide(result, { allowO: [], denyUnlabeled: false })).toBe("confirm");
  });

  it("blocks encrypted, unsupported, and error statuses", () => {
    expect(decide({ labelStatus: "encrypted", fileType: "ole" }, map)).toBe("block");
    expect(decide({ labelStatus: "unsupported", fileType: "other" }, map)).toBe("block");
    expect(decide({ labelStatus: "error", fileType: "pdf" }, map)).toBe("block");
  });
});

// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { showDialog } from "../src/ui/dialog";
import type { Detection } from "../src/engine/t1-engine";

const HOST_ID = "innoecm-ai-guard-dialog-host";

function shadowRoot(): ShadowRoot {
  const host = document.getElementById(HOST_ID);
  if (!host?.shadowRoot) throw new Error("dialog host/shadow root not found");
  return host.shadowRoot;
}

function click(selector: string): void {
  const el = shadowRoot().querySelector(selector);
  if (!(el instanceof HTMLElement)) throw new Error(`button not found: ${selector}`);
  el.click();
}

const RRN_DETECTION: Detection = {
  type: "KR_RRN",
  count: 1,
  weight: 6.0,
  samples: ["90****-*******"],
  spans: [[5, 20]],
  contribution: 6.0,
};

describe("showDialog", () => {
  it("shows the grade badge and translated finding label, and resolves 'send' on the primary button", async () => {
    const promise = showDialog({
      kind: "confirm",
      context: "prompt",
      grade: "C",
      score: 6.0,
      message: "정책 안내 메시지",
      detections: [RRN_DETECTION],
      allowAnonymize: true,
    });

    const root = shadowRoot();
    expect(root.textContent).toContain("기밀 (C)");
    expect(root.textContent).toContain("주민등록번호");
    expect(root.textContent).toContain("감사 로그");

    click("button.primary");
    expect(await promise).toBe("send");
  });

  it("offers an anonymize button only when allowAnonymize is true, resolving 'anonymize'", async () => {
    const promise = showDialog({
      kind: "confirm",
      context: "prompt",
      grade: "S",
      score: 1.0,
      message: "정책 안내 메시지",
      detections: [{ ...RRN_DETECTION, type: "EMAIL_ADDRESS", weight: 1.0, contribution: 1.0 }],
      allowAnonymize: true,
    });

    click("button.anonymize");
    expect(await promise).toBe("anonymize");
  });

  it("does not render an anonymize button when allowAnonymize is false (e.g. file uploads)", async () => {
    const promise = showDialog({
      kind: "confirm",
      context: "file",
      grade: "C",
      score: 6.0,
      message: "정책 안내 메시지",
      detections: [RRN_DETECTION],
      fileName: "직원명부.xlsx",
      allowAnonymize: false,
    });

    expect(shadowRoot().querySelector("button.anonymize")).toBeNull();
    expect(shadowRoot().textContent).toContain("직원명부.xlsx");
    click("button.primary");
    expect(await promise).toBe("send");
  });

  it("block dialogs show a single dismiss button and explain unscannable files honestly", async () => {
    const promise = showDialog({
      kind: "block",
      context: "file",
      grade: "C",
      score: 0,
      message: "정책 안내 메시지",
      detections: [],
      fileName: "scan.pdf",
      allowAnonymize: false,
      unscannable: true,
    });

    const root = shadowRoot();
    expect(root.textContent).toContain("분석 불가");
    expect(root.textContent).not.toContain("기밀 (C)");
    expect(root.querySelectorAll("button").length).toBe(1);

    click("button.primary");
    expect(await promise).toBe("dismiss");
  });
});

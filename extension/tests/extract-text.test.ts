// @vitest-environment happy-dom
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractText } from "../src/content-scan/extract-text";

describe("extractText", () => {
  it("extracts a run of text from a docx-like zip's word/document.xml", async () => {
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>hello &amp; world</w:t></w:r></w:p></w:body>
</w:document>`;
    const zipped = zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "word/document.xml": strToU8(documentXml),
    });
    const file = new File([zipped], "note.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    const result = await extractText(file);
    expect(result.status).toBe("ok");
    expect(result.fileType).toBe("docx");
    expect(result.text).toContain("hello & world");
  });

  it("returns exact text and ok status for a plain .txt File", async () => {
    const file = new File(["plain text content"], "note.txt", { type: "text/plain" });

    const result = await extractText(file);
    expect(result.status).toBe("ok");
    expect(result.text).toBe("plain text content");
  });

  it("reports OLE/CFB magic-number buffers as unsupported", async () => {
    const oleBytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const file = new File([oleBytes], "legacy.doc", { type: "application/octet-stream" });

    const result = await extractText(file);
    expect(result.status).toBe("unsupported");
  });

  it("reports a %PDF magic-number buffer as unsupported", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const file = new File([pdfBytes], "doc.pdf", { type: "application/pdf" });

    const result = await extractText(file);
    expect(result.status).toBe("unsupported");
  });

  it("skips reading the blob and marks oversized files unsupported", async () => {
    const file = new File(["small"], "note.txt", { type: "text/plain" });

    const result = await extractText(file, 1);
    expect(result).toEqual({ text: "", fileType: "unknown", status: "unsupported" });
  });
});

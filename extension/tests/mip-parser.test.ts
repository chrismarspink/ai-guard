// @vitest-environment happy-dom
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseMipLabel } from "../src/mip/mip-parser";

const LABEL_GUID = "5f4f9c8e-1234-4a1b-9c1e-abcdef123456";

function customXmlWithLabel(guid: string, name: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="MSIP_Label_${guid}_Enabled"><vt:lpwstr>true</vt:lpwstr></property>
<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="MSIP_Label_${guid}_Name"><vt:lpwstr>${name}</vt:lpwstr></property>
<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="4" name="MSIP_Label_${guid}_SiteId"><vt:lpwstr>00000000-0000-0000-0000-000000000000</vt:lpwstr></property>
</Properties>`;
}

describe("mip-parser", () => {
  it("extracts label GUID and name from docProps/custom.xml", async () => {
    const zipped = zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "docProps/custom.xml": strToU8(customXmlWithLabel(LABEL_GUID, "공개")),
    });
    const file = new File([zipped], "labeled.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    const result = await parseMipLabel(file);
    expect(result.fileType).toBe("ooxml");
    expect(result.labelStatus).toBe("labeled");
    expect(result.labelGuid).toBe(LABEL_GUID);
    expect(result.labelName).toBe("공개");
  });

  it("reports OLE/CFB magic-number buffers as encrypted", async () => {
    const oleBytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const file = new File([oleBytes], "protected.doc", { type: "application/octet-stream" });

    const result = await parseMipLabel(file);
    expect(result.labelStatus).toBe("encrypted");
    expect(result.fileType).toBe("ole");
  });

  it("reports a zip with no matching label entries as unlabeled", async () => {
    const zipped = zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "word/document.xml": strToU8("<document/>"),
    });
    const file = new File([zipped], "plain.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    const result = await parseMipLabel(file);
    expect(result.labelStatus).toBe("unlabeled");
    expect(result.fileType).toBe("ooxml");
  });

  it("reports unknown file types as unsupported", async () => {
    const file = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], "weird.bin", {
      type: "application/octet-stream",
    });

    const result = await parseMipLabel(file);
    expect(result.labelStatus).toBe("unsupported");
    expect(result.fileType).toBe("other");
  });
});

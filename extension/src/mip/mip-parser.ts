import { unzip } from "fflate";

export type MipFileType = "ooxml" | "pdf" | "ole" | "other";
export type MipLabelStatus = "labeled" | "unlabeled" | "encrypted" | "unsupported" | "error";

export interface MipResult {
  labelStatus: MipLabelStatus;
  fileType: MipFileType;
  labelGuid?: string;
  labelName?: string;
}

const OOXML_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const PDF_SCAN_WINDOW = 512 * 1024;

function matchesMagic(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

// Used only for PDF byte-range scanning, where we deliberately want a raw
// 1-byte-per-char passthrough to regex-match ASCII markers/GUIDs without a
// UTF-8 decode failing on a packet boundary that splits a multi-byte char.
function bytesToLatin1(bytes: Uint8Array): string {
  let out = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return out;
}

function unzipEntries(buf: Uint8Array, wanted: string[]): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(buf, { filter: (file) => wanted.includes(file.name) }, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function parseCustomProps(xmlText: string): { guid?: string; name?: string } {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("custom.xml parse error");

  const properties = Array.from(doc.getElementsByTagName("property"));
  const labelNameRe = /^MSIP_Label_([0-9a-fA-F-]{36})_Name$/;

  for (const prop of properties) {
    const propName = prop.getAttribute("name") ?? "";
    const match = labelNameRe.exec(propName);
    if (!match) continue;
    const valueEl = prop.getElementsByTagName("vt:lpwstr")[0] ?? prop.getElementsByTagName("lpwstr")[0];
    const value = valueEl?.textContent ?? undefined;
    return { guid: match[1], name: value };
  }
  return {};
}

function parseLabelInfo(xmlText: string): { guid?: string; name?: string } {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("LabelInfo.xml parse error");

  const label =
    doc.getElementsByTagName("clbl:label")[0] ?? doc.getElementsByTagName("label")[0];
  if (!label) return {};
  const guid = label.getAttribute("id") ?? undefined;
  const name = label.getAttribute("name") ?? undefined;
  if (!guid) return {};
  return { guid, name };
}

async function parseOoxml(buf: Uint8Array): Promise<MipResult> {
  const entries = await unzipEntries(buf, ["docProps/custom.xml", "docMetadata/LabelInfo.xml"]);

  const customXml = entries["docProps/custom.xml"];
  if (customXml) {
    const { guid, name } = parseCustomProps(bytesToUtf8(customXml));
    if (guid) return { labelStatus: "labeled", fileType: "ooxml", labelGuid: guid, labelName: name };
  }

  const labelInfoXml = entries["docMetadata/LabelInfo.xml"];
  if (labelInfoXml) {
    const { guid, name } = parseLabelInfo(bytesToUtf8(labelInfoXml));
    if (guid) return { labelStatus: "labeled", fileType: "ooxml", labelGuid: guid, labelName: name };
  }

  return { labelStatus: "unlabeled", fileType: "ooxml" };
}

function extractXmpRegion(text: string): string | null {
  const start = text.indexOf("<x:xmpmeta");
  if (start === -1) return null;
  const endTag = "</x:xmpmeta>";
  const endIdx = text.indexOf(endTag, start);
  if (endIdx === -1) return text.slice(start);
  return text.slice(start, endIdx + endTag.length);
}

const GUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const NAME_ATTR_RE = /name="([^"]*)"/;

function scanPdfRegionForLabel(region: string): MipResult | null {
  const xmp = extractXmpRegion(region);
  if (!xmp) return null;
  if (!xmp.toLowerCase().includes("msip_labels")) return null;

  const guidMatch = GUID_RE.exec(xmp);
  if (!guidMatch) return { labelStatus: "unlabeled", fileType: "pdf" };

  const nameMatch = NAME_ATTR_RE.exec(xmp);
  return {
    labelStatus: "labeled",
    fileType: "pdf",
    labelGuid: guidMatch[0],
    labelName: nameMatch ? nameMatch[1] : undefined,
  };
}

async function parsePdf(file: Blob): Promise<MipResult> {
  const size = file.size;
  const headBuf = new Uint8Array(await file.slice(0, Math.min(PDF_SCAN_WINDOW, size)).arrayBuffer());
  const headResult = scanPdfRegionForLabel(bytesToLatin1(headBuf));
  if (headResult) return headResult;

  if (size > PDF_SCAN_WINDOW) {
    const tailStart = Math.max(0, size - PDF_SCAN_WINDOW);
    const tailBuf = new Uint8Array(await file.slice(tailStart, size).arrayBuffer());
    const tailResult = scanPdfRegionForLabel(bytesToLatin1(tailBuf));
    if (tailResult) return tailResult;
  }

  return { labelStatus: "unlabeled", fileType: "pdf" };
}

export async function parseMipLabel(file: Blob): Promise<MipResult> {
  try {
    const headBytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());

    if (matchesMagic(headBytes, OLE_MAGIC)) {
      // OLE/CFB wrapper = password-protected/encrypted document; the label
      // cannot be read at all, so treat it as non-public (fail-closed).
      return { labelStatus: "encrypted", fileType: "ole" };
    }

    if (matchesMagic(headBytes, OOXML_MAGIC)) {
      try {
        const fullBuf = new Uint8Array(await file.arrayBuffer());
        return await parseOoxml(fullBuf);
      } catch {
        return { labelStatus: "error", fileType: "ooxml" };
      }
    }

    if (matchesMagic(headBytes, PDF_MAGIC)) {
      try {
        return await parsePdf(file);
      } catch {
        return { labelStatus: "error", fileType: "pdf" };
      }
    }

    return { labelStatus: "unsupported", fileType: "other" };
  } catch {
    return { labelStatus: "error", fileType: "other" };
  }
}

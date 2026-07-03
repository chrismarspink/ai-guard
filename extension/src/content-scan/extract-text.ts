import { unzip } from "fflate";

export type ExtractStatus = "ok" | "unsupported" | "error";

export interface ExtractResult {
  text: string;
  fileType: string;
  status: ExtractStatus;
}

const TEXT_EXTENSIONS = new Set(["txt", "csv", "md", "log", "json", "tsv"]);

const OOXML_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function matchesMagic(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

function extensionOf(fileName: string): string {
  const lower = fileName.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot === -1 ? "" : lower.slice(dot + 1);
}

function decodeXmlEntities(s: string): string {
  // &amp; must be decoded last, since the other entities are themselves
  // written as &amp;-escaped sequences in well-formed source XML.
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractRuns(xml: string): string[] {
  const re = /<(?:[\w]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w]+:)?t>/g;
  const runs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    runs.push(decodeXmlEntities(m[1]));
  }
  return runs;
}

function extractCellValues(xml: string): string[] {
  const re = /<v>([\s\S]*?)<\/v>/g;
  const values: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    values.push(decodeXmlEntities(m[1]));
  }
  return values;
}

function unzipFiltered(buf: Uint8Array, test: (name: string) => boolean): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(buf, { filter: (file) => test(file.name) }, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

async function extractDocx(buf: Uint8Array): Promise<ExtractResult> {
  const entries = await unzipFiltered(buf, (name) => name === "word/document.xml");
  const doc = entries["word/document.xml"];
  const xml = doc ? new TextDecoder("utf-8").decode(doc) : "";
  return { text: extractRuns(xml).join(" "), fileType: "docx", status: "ok" };
}

async function extractPptx(buf: Uint8Array): Promise<ExtractResult> {
  const slideRe = /^ppt\/slides\/slide\d+\.xml$/;
  const entries = await unzipFiltered(buf, (name) => slideRe.test(name));
  const slideTexts = Object.keys(entries)
    .sort()
    .map((name) => extractRuns(new TextDecoder("utf-8").decode(entries[name])).join(" "));
  return { text: slideTexts.join("\n"), fileType: "pptx", status: "ok" };
}

async function extractXlsx(buf: Uint8Array): Promise<ExtractResult> {
  const sheetRe = /^xl\/worksheets\/sheet\d+\.xml$/;
  const entries = await unzipFiltered(buf, (name) => name === "xl/sharedStrings.xml" || sheetRe.test(name));

  const parts: string[] = [];
  const shared = entries["xl/sharedStrings.xml"];
  if (shared) parts.push(...extractRuns(new TextDecoder("utf-8").decode(shared)));

  for (const name of Object.keys(entries).filter((n) => sheetRe.test(n)).sort()) {
    parts.push(...extractCellValues(new TextDecoder("utf-8").decode(entries[name])));
  }

  return { text: parts.join(" "), fileType: "xlsx", status: "ok" };
}

export async function extractText(file: File, maxBytes = 50 * 1024 * 1024): Promise<ExtractResult> {
  if (file.size > maxBytes) return { text: "", fileType: "unknown", status: "unsupported" };

  const ext = extensionOf(file.name);
  try {
    if (TEXT_EXTENSIONS.has(ext)) {
      return { text: await file.text(), fileType: ext, status: "ok" };
    }

    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());

    if (matchesMagic(head, OLE_MAGIC)) {
      // Legacy/encrypted binary Office container: no in-browser text layer
      // available, so fail closed via the caller's "not ok" -> block path.
      return { text: "", fileType: "ole", status: "unsupported" };
    }

    if (matchesMagic(head, OOXML_MAGIC)) {
      const buf = new Uint8Array(await file.arrayBuffer());
      if (ext === "docx") return await extractDocx(buf);
      if (ext === "pptx") return await extractPptx(buf);
      if (ext === "xlsx") return await extractXlsx(buf);
      return { text: "", fileType: ext || "zip", status: "unsupported" };
    }

    // PDF, HWP/HWPX, images, audio, etc: no in-browser text-layer extraction
    // in v1, mirrors mip-parser.ts's "unsupported" status for unreadable formats.
    return { text: "", fileType: ext || "unknown", status: "unsupported" };
  } catch {
    return { text: "", fileType: ext || "unknown", status: "error" };
  }
}

import type { ClassificationResult, Detection, Grade } from "../engine/t1-engine";

// Remote classifier-svc client. Grades text with the mDeBERTa-backed neural
// tier, which splits large documents into ≤512-token windows server-side, so
// this path scans a whole document rather than a truncated prefix. The result
// is mapped back onto the local ClassificationResult shape so the rest of the
// content-scan pipeline (decideContent, the dialog) is unchanged.

const SHORT: Record<string, Grade> = {
  OPEN: "O", SENSITIVE: "S", CONFIDENTIAL: "C", O: "O", S: "S", C: "C",
};

interface RemoteFinding {
  type: string;
  count: number;
  spans?: [number, number][];
  confidence?: number;
  weight?: number;
}

interface RemoteResult {
  grade: string;
  shortCode?: string;
  findings?: RemoteFinding[];
  stats?: { score?: number };
  tierResults?: { neural?: { chunksScanned?: number; chunksTotal?: number } };
}

export interface RemoteClassification extends ClassificationResult {
  /** Large-document scan coverage reported by the neural tier, when present. */
  chunksScanned?: number;
  chunksTotal?: number;
}

function toDetection(f: RemoteFinding): Detection {
  const weight = f.weight ?? f.confidence ?? 0;
  return {
    type: f.type,
    count: f.count,
    weight,
    // Masked samples are produced locally from the raw text; the server never
    // returns raw values, so remote detections show type + count only.
    samples: [],
    spans: f.spans ?? [],
    contribution: weight * Math.max(1, f.count),
  };
}

function mapRemote(data: RemoteResult): RemoteClassification {
  const grade = SHORT[data.shortCode ?? data.grade] ?? "C"; // unknown → fail closed
  const detections = (data.findings ?? []).map(toDetection);
  const neural = data.tierResults?.neural;
  return {
    grade,
    score: data.stats?.score ?? 0,
    detections,
    chunksScanned: neural?.chunksScanned,
    chunksTotal: neural?.chunksTotal,
  };
}

const NEURAL_OPTS = (cfg: { neuralBackend?: string }) => ({
  useNeural: true,
  neuralBackend: cfg.neuralBackend || "mdeberta",
});

/** POST text to classifier-svc /classify. Throws on network/HTTP error so the
 *  caller can fall back to the local engine. */
export async function classifyTextRemote(
  text: string,
  cfg: { url: string; locale?: string; neuralBackend?: string },
  signal?: AbortSignal,
): Promise<RemoteClassification> {
  const base = cfg.url.replace(/\/+$/, "");
  const res = await fetch(`${base}/classify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, locale: cfg.locale || "ko", options: NEURAL_OPTS(cfg) }),
    signal,
  });
  if (!res.ok) throw new Error(`classifier-svc ${res.status}`);
  return mapRemote((await res.json()) as RemoteResult);
}

// Binary file kinds classifier-svc can extract server-side before grading:
// images (OCR), legacy .hwp (pyhwp/olefile), and audio (STT). Each maps to a
// dedicated endpoint that returns the same classify result shape.
export type BinaryKind = "image" | "hwp" | "audio";

const ENDPOINT: Record<BinaryKind, { path: string; bodyKey: string }> = {
  image: { path: "ocr-classify", bodyKey: "imageBase64" },
  hwp: { path: "hwp-classify", bodyKey: "hwpBase64" },
  audio: { path: "transcribe-classify", bodyKey: "audioBase64" },
};

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("file read failed"));
    r.readAsDataURL(file);
  });
}

/** POST a binary file (image/hwp/audio) to its classifier-svc endpoint, which
 *  extracts text server-side (OCR / pyhwp / Whisper STT) and grades it with the
 *  mDeBERTa neural tier. Throws on network/HTTP error so the caller fails closed. */
export async function classifyFileRemote(
  file: File,
  cfg: { url: string; locale?: string; neuralBackend?: string },
  kind: BinaryKind,
  signal?: AbortSignal,
): Promise<RemoteClassification> {
  const { path, bodyKey } = ENDPOINT[kind];
  const dataUrl = await readDataUrl(file);
  const base = cfg.url.replace(/\/+$/, "");
  const res = await fetch(`${base}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ [bodyKey]: dataUrl, locale: cfg.locale || "ko", options: NEURAL_OPTS(cfg) }),
    signal,
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return mapRemote((await res.json()) as RemoteResult);
}

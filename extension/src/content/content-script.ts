import { anonymizeText } from "../engine/anonymize";
import type { ClassificationResult, Grade } from "../engine/t1-engine";
import { decideContent, type ContentDecision } from "../content-scan/content-policy";
import { extractText } from "../content-scan/extract-text";
import { decide as decideLabel, type LabelDecision } from "../mip/label-policy";
import { parseMipLabel } from "../mip/mip-parser";
import { getPolicy, type Policy } from "../policy/policy-loader";
import { classifyTextRemote, classifyFileRemote, type BinaryKind } from "../content-scan/classifier-client";
import { showDialog, showProgress } from "../ui/dialog";

const CHANNEL = "__innoecm_ai_guard__";

// Generated once per page load and stamped onto <html> so the MAIN-world
// injected script can prove its postMessage calls originate from our own
// bridge and not from the host page or another extension.
const NONCE = crypto.randomUUID();
document.documentElement.dataset.innoecmNonce = NONCE;

interface Verdict {
  action: "allow" | "block";
  /** Set only when the user chose "익명화 후 전송": injected.ts overwrites
   *  the input field with this text before re-dispatching the send action. */
  replacementText?: string;
}

interface BridgeMessage {
  channel: string;
  nonce: string;
  kind: "classifyPrompt" | "checkFile";
  requestId: string;
  payload: { site: string; text?: string; file?: File };
}

function postVerdict(requestId: string, verdict: Verdict): void {
  window.postMessage({ channel: CHANNEL, nonce: NONCE, kind: "verdict", requestId, verdict }, location.origin);
}

function logEvent(event: Record<string, unknown>): void {
  chrome.runtime.sendMessage({ type: "LOG_EVENT", event: { ...event, ts: new Date().toISOString() } });
}

async function classifyText(text: string): Promise<ClassificationResult> {
  return (await chrome.runtime.sendMessage({ type: "CLASSIFY_PROMPT", text })) as ClassificationResult;
}

// Estimate the neural window count so the progress bar advances at a rate that
// reflects document size. Mirrors classifier-svc defaults (384 tokens / 64
// overlap); chars≈tokens is a deliberate over-estimate so the bar stays
// conservative (never claims done early).
function estimateChunks(len: number): number {
  return Math.max(1, Math.ceil((len - 64) / (384 - 64)));
}

// Grade extracted file text. Uses the mDeBERTa-backed classifier-svc when the
// policy configures one (handles large documents via server-side token
// windowing) and shows a determinate progress bar; on any remote failure it
// falls back to the bundled local T1 engine so the upload is still gated.
async function classifyFileText(text: string, policy: Policy, fileName: string): Promise<ClassificationResult> {
  const cfg = policy.classifier;
  const estChunks = estimateChunks(text.length);

  if (!cfg?.url) {
    if (estChunks <= 1) return classifyText(text);
    const p = showProgress("로컬 분석 중", fileName);
    try {
      p.update(0.5, "로컬 분석 중");
      const r = await classifyText(text);
      p.update(1, "분석 완료");
      return r;
    } finally {
      p.done();
    }
  }

  const progress = showProgress("AI 분석 중 (mDeBERTa)", fileName);
  const totalMs = Math.max(1500, estChunks * 700); // ~700ms/window on CPU mDeBERTa
  const start = performance.now();
  const iv = window.setInterval(() => {
    const frac = Math.min(0.9, (performance.now() - start) / totalMs);
    progress.update(frac, "AI 분석 중 (mDeBERTa)",
      estChunks > 1 ? `대용량 문서 · 예상 ${estChunks}개 구간` : undefined);
  }, 150);
  try {
    const r = await classifyTextRemote(text, cfg);
    progress.update(1, "분석 완료",
      r.chunksTotal && r.chunksTotal > 1 ? `${r.chunksScanned}/${r.chunksTotal} 구간 스캔` : undefined);
    return r;
  } catch {
    // Remote classifier unreachable → local engine (still a real gate, not an allow).
    window.clearInterval(iv);
    progress.update(0.5, "로컬 폴백 분석 중");
    const r = await classifyText(text);
    progress.update(1, "분석 완료");
    return r;
  } finally {
    window.clearInterval(iv);
    progress.done();
  }
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "tiff", "tif"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "ogg", "flac", "aac"]);
const MAX_BINARY_BYTES = 50 * 1024 * 1024;

// Which server-side extraction endpoint (if any) a binary file should use.
// .hwpx is a zip handled by the text/OOXML path, so only legacy binary .hwp
// routes to the hwp endpoint.
function binaryKind(file: File): BinaryKind | null {
  const name = file.name.toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (file.type.startsWith("image/") || IMAGE_EXTS.has(ext)) return "image";
  if (file.type.startsWith("audio/") || AUDIO_EXTS.has(ext)) return "audio";
  if (ext === "hwp") return "hwp";
  return null;
}

// Route a binary file (image/hwp/audio) to classifier-svc for server-side
// extraction (OCR / pyhwp / STT) + mDeBERTa grading, with a progress bar.
// Returns null on failure so the caller fails closed (blocks the upload).
async function classifyBinaryFile(
  file: File,
  cfg: NonNullable<Policy["classifier"]>,
  kind: BinaryKind,
): Promise<ClassificationResult | null> {
  if (file.size > MAX_BINARY_BYTES) return null; // too large to base64 → fail closed
  const label = kind === "image" ? "서버 OCR + AI 분석"
    : kind === "audio" ? "서버 STT + AI 분석" : "서버 .hwp 추출 + AI 분석";
  const progress = showProgress(label, file.name);
  // Audio STT scales with duration; give it a far longer estimate than OCR/hwp.
  const kb = file.size / 1024;
  const estMs = kind === "audio" ? Math.max(8000, kb * 20) : Math.max(3000, kb * 4);
  const start = performance.now();
  const iv = window.setInterval(() => {
    progress.update(Math.min(0.9, (performance.now() - start) / estMs), label);
  }, 150);
  try {
    const r = await classifyFileRemote(file, cfg, kind);
    progress.update(1, "분석 완료",
      r.chunksTotal && r.chunksTotal > 1 ? `${r.chunksScanned}/${r.chunksTotal} 구간 스캔` : undefined);
    return r;
  } catch {
    return null; // unreachable/unsupported → fail closed
  } finally {
    window.clearInterval(iv);
    progress.done();
  }
}

function decidePromptAction(grade: Grade, mode: Policy["mode"]["prompt"]): "allow" | "confirm" | "block" {
  if (grade === "O") return "allow";
  if (mode === "audit") return "allow";
  if (grade === "S") return "confirm";
  // grade === "C"
  return mode === "block" ? "block" : "confirm";
}

async function handleClassifyPrompt(requestId: string, site: string, originalText: string): Promise<void> {
  const policy = await getPolicy();
  let text = originalText;
  let result = await classifyText(text);
  let anonymized = false;

  for (;;) {
    const action = decidePromptAction(result.grade, policy.mode.prompt);

    if (action === "allow") {
      if (anonymized) {
        logEvent({
          type: "prompt_anonymized_sent",
          site,
          grade: result.grade,
          score: result.score,
          detections: result.detections,
          action: "user_confirmed",
        });
      } else if (policy.mode.prompt === "audit" && result.grade !== "O") {
        logEvent({ type: "prompt_confirm_sent", site, grade: result.grade, score: result.score, detections: result.detections, action: "allowed" });
      } else {
        // Genuine grade-O pass: logged (2026-07-03) so the dashboard's
        // violation-rate chart has a true denominator, not just a count of
        // flagged prompts. No detections to report -- grade O means none.
        logEvent({ type: "prompt_allowed", site, grade: result.grade, score: result.score, detections: result.detections, action: "allowed" });
      }
      postVerdict(requestId, anonymized ? { action: "allow", replacementText: text } : { action: "allow" });
      return;
    }

    if (action === "confirm") {
      const choice = await showDialog({
        kind: "confirm",
        context: "prompt",
        grade: result.grade,
        score: result.score,
        message: policy.userMessage.confirm,
        detections: result.detections,
        allowAnonymize: !anonymized,
      });

      if (choice === "anonymize") {
        text = anonymizeText(text, result);
        result = await classifyText(text);
        anonymized = true;
        continue; // re-evaluate the loop with the anonymized text's own grade
      }
      if (choice === "send") {
        logEvent({ type: "prompt_confirm_sent", site, grade: result.grade, score: result.score, detections: result.detections, action: "user_confirmed" });
        postVerdict(requestId, { action: "allow" });
        return;
      }
      postVerdict(requestId, { action: "block" });
      return;
    }

    // action === "block"
    await showDialog({
      kind: "block",
      context: "prompt",
      grade: result.grade,
      score: result.score,
      message: policy.userMessage.blocked,
      detections: result.detections,
      allowAnonymize: false,
    });
    logEvent({ type: "prompt_block", site, grade: result.grade, score: result.score, detections: result.detections, action: "blocked" });
    postVerdict(requestId, { action: "block" });
    return;
  }
}

async function handleCheckFile(requestId: string, site: string, file: File): Promise<void> {
  const policy = await getPolicy();
  const cfg = policy.classifier;
  const kind = cfg?.url ? binaryKind(file) : null;

  let extractResult: { status: "ok" | "unsupported" | "error" };
  let classification: ClassificationResult | null;
  if (kind && cfg?.url) {
    // Image/hwp/audio: the server extracts the text (OCR/pyhwp/STT), so a
    // successful remote grade means the content WAS scanned; failure fails closed.
    classification = await classifyBinaryFile(file, cfg, kind);
    extractResult = { status: classification ? "ok" : "unsupported" };
  } else {
    const ex = await extractText(file);
    extractResult = ex;
    classification = ex.status === "ok"
      ? await classifyFileText(ex.text, policy, file.name)
      : null;
  }
  const contentRawDecision = decideContent(extractResult, classification, policy.mode.file);

  let mipResult: Awaited<ReturnType<typeof parseMipLabel>> | null = null;
  let rawDecision: ContentDecision = contentRawDecision;
  if (policy.fileCheck.mipCheck) {
    mipResult = await parseMipLabel(file);
    rawDecision = combineDecisions(contentRawDecision, decideLabel(mipResult, policy.mipLabelMap));
  }
  // else: skip parseMipLabel entirely -- avoid parsing the file twice when
  // the org doesn't use MIP labels (contentScan is the standalone v1 gate).

  const decision = policy.mode.file === "audit" ? "allow" : rawDecision;

  const fileInfo = {
    name: file.name,
    grade: classification?.grade,
    score: classification?.score,
    mipChecked: policy.fileCheck.mipCheck,
    labelGuid: mipResult?.labelGuid,
    labelName: mipResult?.labelName,
  };
  const detections = classification?.detections ?? [];
  const grade = classification?.grade ?? "C"; // unscannable: unused for display (see `unscannable` below), just satisfies the type
  const unscannable = extractResult.status !== "ok";

  if (decision === "allow") {
    if (policy.mode.file === "audit" && rawDecision !== "allow") {
      logEvent({ type: "file_confirm", site, file: fileInfo, action: "allowed" });
    } else {
      // Genuine grade-O pass, same rationale as prompt_allowed above.
      logEvent({ type: "file_allowed", site, file: fileInfo, action: "allowed" });
    }
    postVerdict(requestId, { action: "allow" });
    return;
  }

  if (decision === "confirm") {
    const choice = await showDialog({
      kind: "confirm",
      context: "file",
      grade,
      score: classification?.score ?? 0,
      message: policy.userMessage.confirm,
      detections,
      fileName: file.name,
      allowAnonymize: false,
      unscannable,
    });
    if (choice === "send") {
      logEvent({ type: "file_confirm", site, file: fileInfo, action: "user_confirmed" });
      postVerdict(requestId, { action: "allow" });
    } else {
      postVerdict(requestId, { action: "block" });
    }
    return;
  }

  await showDialog({
    kind: "block",
    context: "file",
    grade,
    score: classification?.score ?? 0,
    message: policy.userMessage.blocked,
    detections,
    fileName: file.name,
    allowAnonymize: false,
    unscannable,
  });
  logEvent({ type: "file_block", site, file: fileInfo, action: "blocked" });
  postVerdict(requestId, { action: "block" });
}

const DECISION_RANK: Record<ContentDecision, number> = { block: 2, confirm: 1, allow: 0 };

function combineDecisions(a: ContentDecision, b: LabelDecision): ContentDecision {
  return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b;
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data as BridgeMessage | undefined;
  if (!data || data.channel !== CHANNEL || data.nonce !== NONCE) return;

  if (data.kind === "classifyPrompt" && typeof data.payload.text === "string") {
    void handleClassifyPrompt(data.requestId, data.payload.site, data.payload.text);
  } else if (data.kind === "checkFile" && data.payload.file instanceof File) {
    void handleCheckFile(data.requestId, data.payload.site, data.payload.file);
  }
});

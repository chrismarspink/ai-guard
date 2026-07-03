import { anonymizeText } from "../engine/anonymize";
import type { ClassificationResult, Grade } from "../engine/t1-engine";
import { decideContent, type ContentDecision } from "../content-scan/content-policy";
import { extractText } from "../content-scan/extract-text";
import { decide as decideLabel, type LabelDecision } from "../mip/label-policy";
import { parseMipLabel } from "../mip/mip-parser";
import { getPolicy, type Policy } from "../policy/policy-loader";
import { showDialog } from "../ui/dialog";

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

  const extractResult = await extractText(file);
  const classification = extractResult.status === "ok" ? await classifyText(extractResult.text) : null;
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

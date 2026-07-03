import type { Detection, Grade } from "../engine/t1-engine";
import { entityLabel } from "../engine/labels";

export type DialogKind = "confirm" | "block";
export type DialogContext = "prompt" | "file";
export type DialogChoice = "edit" | "send" | "dismiss" | "anonymize";

export interface DialogOptions {
  kind: DialogKind;
  context: DialogContext;
  grade: Grade;
  score: number;
  message: string;
  detections: Detection[];
  fileName?: string;
  /** Offer "익명화 후 전송" -- prompt-only, and only before an anonymize
   *  attempt has already been made once (see content-script.ts's loop). */
  allowAnonymize: boolean;
  /** File couldn't be scanned at all (unsupported format/size/parse error),
   *  so `grade`/`detections` are a fail-closed placeholder, not a real
   *  finding -- show that honestly instead of implying PII was detected. */
  unscannable?: boolean;
}

const HOST_ID = "innoecm-ai-guard-dialog-host";

// Mirrors the reference fileTrench UI's GRADE_COLOR scheme so O/S/C reads
// consistently for anyone who's seen that tool.
const GRADE_COLOR: Record<Grade, string> = { O: "#16a34a", S: "#d97706", C: "#dc2626" };
const GRADE_LABEL: Record<Grade, string> = { O: "공개", S: "민감", C: "기밀" };

export function showDialog(opts: DialogOptions): Promise<DialogChoice> {
  return new Promise((resolve) => {
    const existing = document.getElementById(HOST_ID);
    existing?.remove();

    const host = document.createElement("div");
    host.id = HOST_ID;
    // Shadow DOM keeps host-page CSS from bleeding into (or clobbering) our dialog.
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 2147483647;
                 display: flex; align-items: center; justify-content: center; font-family: sans-serif; }
      .box { background: #fff; border-radius: 8px; padding: 24px; width: 440px; max-width: 92vw;
             max-height: 86vh; overflow-y: auto; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }
      .head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
      .grade-badge { display: inline-block; font-size: 13px; font-weight: 700; padding: 3px 10px;
                     border-radius: 4px; color: #fff; }
      .badge { display: inline-block; font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 4px; }
      .badge.block { background: #fdecea; color: #b3261e; }
      .badge.confirm { background: #fff4ce; color: #7a5b00; }
      .filename { font-size: 12px; color: #5f6368; }
      .message { font-size: 14px; line-height: 1.5; color: #202124; margin-bottom: 12px; white-space: pre-wrap; }
      .guidance { font-size: 13px; line-height: 1.5; color: #202124; background: #f8f9fa;
                  border-left: 3px solid #9aa0a6; padding: 8px 10px; margin-bottom: 14px; }
      .section-title { font-size: 12px; font-weight: 700; color: #5f6368; margin: 14px 0 6px; }
      .finding { margin-bottom: 10px; }
      .finding-head { display: flex; align-items: baseline; gap: 6px; font-size: 13px; }
      .finding-type { font-weight: 600; }
      .finding-count { color: #5f6368; font-size: 12px; }
      .finding-samples { font-size: 12px; color: #5f6368; margin-top: 2px; }
      .finding-samples code { background: #f1f3f4; border-radius: 3px; padding: 1px 4px; margin-right: 4px; }
      .bar-track { background: #eee; border-radius: 3px; height: 6px; margin-top: 4px; overflow: hidden; }
      .bar-fill { height: 100%; background: #1a73e8; }
      .audit-notice { font-size: 12px; color: #5f6368; background: #f1f3f4; border-radius: 6px;
                      padding: 8px 10px; margin-top: 14px; }
      .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
      button { font-size: 13px; padding: 8px 16px; border-radius: 6px; border: 1px solid #ccc; cursor: pointer; background: #f1f3f4; }
      button.primary { background: #1a73e8; color: #fff; border-color: #1a73e8; }
      button.anonymize { background: #e6f4ea; color: #1e6b34; border-color: #b7dfc2; }
    `;

    const overlay = document.createElement("div");
    overlay.className = "overlay";

    const box = document.createElement("div");
    box.className = "box";

    const head = document.createElement("div");
    head.className = "head";

    const gradeBadge = document.createElement("span");
    gradeBadge.className = "grade-badge";
    if (opts.unscannable) {
      gradeBadge.style.background = "#5f6368";
      gradeBadge.textContent = "분석 불가";
    } else {
      gradeBadge.style.background = GRADE_COLOR[opts.grade];
      gradeBadge.textContent = `${GRADE_LABEL[opts.grade]} (${opts.grade})`;
    }

    const statusBadge = document.createElement("span");
    statusBadge.className = `badge ${opts.kind}`;
    statusBadge.textContent = opts.kind === "block" ? "차단됨" : "확인 필요";

    head.append(gradeBadge, statusBadge);
    if (opts.fileName) {
      const nameEl = document.createElement("span");
      nameEl.className = "filename";
      nameEl.textContent = opts.fileName;
      head.appendChild(nameEl);
    }

    const messageEl = document.createElement("div");
    messageEl.className = "message";
    messageEl.textContent = opts.message;

    const guidance = document.createElement("div");
    guidance.className = "guidance";
    const subject = opts.context === "prompt" ? "이 프롬프트" : "이 파일";
    guidance.textContent = opts.unscannable
      ? `${subject}은 형식(PDF/암호화 문서 등) 또는 크기 제한으로 내용을 자동 분석할 수 없어, ` +
        `안전을 위해 공개(O) 등급이 아닌 것으로 간주해 차단합니다.`
      : `${subject}은 공개(O) 등급이 아닌 ${GRADE_LABEL[opts.grade]}(${opts.grade}) 등급입니다. ` +
        `조직 정책에 따라 담당자 확인 또는 결재 절차를 거친 뒤 진행해야 합니다.`;

    const findingsTitle = document.createElement("div");
    findingsTitle.className = "section-title";
    findingsTitle.textContent = opts.unscannable ? "검출 항목" : `검출된 항목 (점수 ${opts.score})`;

    const findingsBox = document.createElement("div");
    if (opts.unscannable || opts.detections.length === 0) {
      const empty = document.createElement("div");
      empty.className = "finding-samples";
      empty.textContent = opts.unscannable ? "형식 미지원으로 내용 분석 불가" : "검출된 항목 없음";
      findingsBox.appendChild(empty);
    }
    const maxContribution = Math.max(1, ...opts.detections.map((d) => d.contribution));
    for (const d of opts.detections) {
      const row = document.createElement("div");
      row.className = "finding";

      const rowHead = document.createElement("div");
      rowHead.className = "finding-head";
      const typeEl = document.createElement("span");
      typeEl.className = "finding-type";
      typeEl.textContent = entityLabel(d.type);
      const countEl = document.createElement("span");
      countEl.className = "finding-count";
      countEl.textContent = `${d.count}건`;
      rowHead.append(typeEl, countEl);

      if (d.samples.length > 0 && !d.type.startsWith("KEYWORD:")) {
        const samplesEl = document.createElement("div");
        samplesEl.className = "finding-samples";
        for (const s of d.samples) {
          const code = document.createElement("code");
          code.textContent = s;
          samplesEl.appendChild(code);
        }
        row.append(rowHead, samplesEl);
      } else {
        row.append(rowHead);
      }

      const track = document.createElement("div");
      track.className = "bar-track";
      const fill = document.createElement("div");
      fill.className = "bar-fill";
      fill.style.width = `${Math.max(4, Math.round((d.contribution / maxContribution) * 100))}%`;
      track.appendChild(fill);
      row.appendChild(track);

      findingsBox.appendChild(row);
    }

    const auditNotice = document.createElement("div");
    auditNotice.className = "audit-notice";
    auditNotice.textContent = "⚠ 이 판정 결과와 선택하신 조치는 감사 로그로 기록되어 정책 관리 서버에 전송됩니다.";

    const actions = document.createElement("div");
    actions.className = "actions";

    function finish(choice: DialogChoice): void {
      host.remove();
      resolve(choice);
    }

    if (opts.kind === "block") {
      const ok = document.createElement("button");
      ok.className = "primary";
      ok.textContent = "확인";
      ok.addEventListener("click", () => finish("dismiss"));
      actions.appendChild(ok);
    } else {
      const editBtn = document.createElement("button");
      editBtn.textContent = opts.context === "prompt" ? "수정" : "취소";
      editBtn.addEventListener("click", () => finish("edit"));
      actions.appendChild(editBtn);

      if (opts.context === "prompt" && opts.allowAnonymize) {
        const anonBtn = document.createElement("button");
        anonBtn.className = "anonymize";
        anonBtn.textContent = "개인정보 마스킹 후 전송";
        anonBtn.addEventListener("click", () => finish("anonymize"));
        actions.appendChild(anonBtn);
      }

      const sendBtn = document.createElement("button");
      sendBtn.className = "primary";
      sendBtn.textContent = opts.context === "prompt" ? "그대로 전송" : "그대로 업로드";
      sendBtn.addEventListener("click", () => finish("send"));
      actions.appendChild(sendBtn);
    }

    box.append(head, messageEl, guidance, findingsTitle, findingsBox, auditNotice, actions);
    overlay.appendChild(box);
    shadow.appendChild(style);
    shadow.appendChild(overlay);
    document.documentElement.appendChild(host);
  });
}

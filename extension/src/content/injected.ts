import { globToRegExp, matchAdapter } from "../adapters/adapter-loader";
import chatgpt from "../adapters/chatgpt.json";
import claude from "../adapters/claude.json";
import gemini from "../adapters/gemini.json";
import type { SiteAdapter } from "../adapters/types";

// Adapters are static, versioned JSON, not remote code -- bundling them via
// static import satisfies Chrome Web Store's "no remotely-hosted code" rule
// while still keeping selectors out of hardcoded TS (plan doc risk R1/R7).
const ADAPTERS = [chatgpt, claude, gemini] as unknown as SiteAdapter[];

const CHANNEL = "__innoecm_ai_guard__";

interface Verdict {
  action: "allow" | "block";
  /** Set when the user chose "익명화 후 전송" -- overwrite the input field
   *  with this text before re-dispatching the send action. */
  replacementText?: string;
}

const pendingVerdicts = new Map<string, (verdict: Verdict) => void>();
// Events we synthesize ourselves to re-dispatch an approved action must skip
// our own capture-phase guard, or every allowed send would loop forever.
const bypassEvents = new WeakSet<Event>();

function currentNonce(): string {
  return document.documentElement.dataset.innoecmNonce ?? "";
}

function requestVerdict(kind: "classifyPrompt" | "checkFile", payload: Record<string, unknown>): Promise<Verdict> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    pendingVerdicts.set(requestId, resolve);
    window.postMessage(
      { channel: CHANNEL, nonce: currentNonce(), kind, requestId, payload },
      location.origin,
    );
  });
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.channel !== CHANNEL || data.kind !== "verdict") return;
  if (data.nonce !== currentNonce()) return;
  const resolve = pendingVerdicts.get(data.requestId);
  if (!resolve) return;
  pendingVerdicts.delete(data.requestId);
  resolve(data.verdict);
});

function closestMatch(el: EventTarget | null, selector: string): Element | null {
  if (!(el instanceof Element)) return null;
  return el.closest(selector);
}

function extractPromptText(adapter: SiteAdapter): string {
  const el = document.querySelector(adapter.selectors.input);
  if (!el) return "";
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
  return (el as HTMLElement).innerText ?? "";
}

// Used only for the "익명화 후 전송" flow: overwrite the input with the
// masked text before re-dispatching send. execCommand is deprecated but is
// still the most reliable cross-framework way to make a contenteditable
// mutation look like genuine user input -- setting .value/.textContent
// directly does not fire the native "input" event React et al. listen for.
function setPromptText(adapter: SiteAdapter, text: string): void {
  const el = document.querySelector(adapter.selectors.input);
  if (!el) return;

  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  const target = el as HTMLElement;
  target.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  const applied = document.execCommand("insertText", false, text);
  if (!applied) {
    target.textContent = text;
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }
}

function installSendHooks(adapter: SiteAdapter): void {
  async function guardSend(redispatch: () => void): Promise<void> {
    const text = extractPromptText(adapter);
    // Some sites' send buttons stay clickable even with an empty composer
    // (Claude/Gemini don't always set the native `disabled` attribute). An
    // empty submit is a no-op in the host app and not a "prompt" worth a
    // classify round-trip or an audit-log entry -- just let it through.
    if (text.trim().length === 0) {
      redispatch();
      return;
    }
    const verdict = await requestVerdict("classifyPrompt", { site: adapter.id, text });
    if (verdict.action !== "allow") return;
    if (verdict.replacementText !== undefined && verdict.replacementText !== text) {
      setPromptText(adapter, verdict.replacementText);
      // Give the page's own framework a tick to process the synthetic
      // "input" event before send re-dispatches, or it may read the stale value.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    redispatch();
  }

  document.addEventListener(
    "click",
    (event) => {
      if (bypassEvents.has(event)) return;
      const button = closestMatch(event.target, adapter.selectors.sendButton);
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void guardSend(() => {
        const clone = new MouseEvent("click", { bubbles: true, cancelable: true });
        bypassEvents.add(clone);
        button.dispatchEvent(clone);
      });
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (bypassEvents.has(event)) return;
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      const input = closestMatch(event.target, adapter.selectors.input);
      if (!input) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void guardSend(() => {
        const clone = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" });
        bypassEvents.add(clone);
        input.dispatchEvent(clone);
      });
    },
    true,
  );
}

function installFileHooks(adapter: SiteAdapter): void {
  async function guardFiles(files: FileList, redispatch: () => void): Promise<void> {
    const verdicts = await Promise.all(
      Array.from(files).map((file) => requestVerdict("checkFile", { site: adapter.id, file })),
    );
    if (verdicts.every((v) => v.action === "allow")) redispatch();
  }

  document.addEventListener(
    "drop",
    (event) => {
      if (bypassEvents.has(event)) return;
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const dataTransfer = event.dataTransfer;
      const target = event.target;
      void guardFiles(files, () => {
        const clone = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer });
        bypassEvents.add(clone);
        target?.dispatchEvent(clone);
      });
    },
    true,
  );

  document.addEventListener(
    "paste",
    (event) => {
      if (bypassEvents.has(event)) return;
      const files = event.clipboardData?.files;
      if (!files || files.length === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const clipboardData = event.clipboardData;
      const target = event.target;
      void guardFiles(files, () => {
        const clone = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData });
        bypassEvents.add(clone);
        target?.dispatchEvent(clone);
      });
    },
    true,
  );

  const fileInputSelector = adapter.selectors.fileInput;
  if (fileInputSelector) {
    document.addEventListener(
      "change",
      (event) => {
        if (bypassEvents.has(event)) return;
        const input = closestMatch(event.target, fileInputSelector);
        if (!(input instanceof HTMLInputElement) || !input.files || input.files.length === 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const files = input.files;
        void guardFiles(files, () => {
          const clone = new Event("change", { bubbles: true, cancelable: true });
          bypassEvents.add(clone);
          input.dispatchEvent(clone);
        });
      },
      true,
    );
  }
}

function extractFilesFromBody(body: unknown): File[] {
  if (body instanceof FormData) {
    return Array.from(body.values()).filter((v): v is File => v instanceof File);
  }
  if (typeof File !== "undefined" && body instanceof File) return [body];
  return [];
}

function installNetworkHooks(adapter: SiteAdapter): void {
  const pattern = adapter.endpoints?.uploadUrlPattern;
  if (!pattern) return;
  const uploadUrlRegExp = globToRegExp(pattern);

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    const body = init?.body;
    if (uploadUrlRegExp.test(url) && body) {
      const files = extractFilesFromBody(body);
      if (files.length > 0) {
        const verdicts = await Promise.all(files.map((file) => requestVerdict("checkFile", { site: adapter.id, file })));
        if (!verdicts.every((v) => v.action === "allow")) {
          throw new DOMException("Blocked by innoecm-ai-guard policy", "AbortError");
        }
      }
    }
    return originalFetch.call(window, input, init);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    (this as unknown as { __innoecmUrl?: string }).__innoecmUrl = typeof url === "string" ? url : url.toString();
    return (originalOpen as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function patchedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = (this as unknown as { __innoecmUrl?: string }).__innoecmUrl;
    if (url && uploadUrlRegExp.test(url) && body) {
      const files = extractFilesFromBody(body);
      if (files.length > 0) {
        // XHR.send() has no async contract, so we defer the real send until
        // the verdict resolves; a block simply means the original send is
        // never called (best-effort last line of defense, per plan doc §2.1).
        void Promise.all(files.map((file) => requestVerdict("checkFile", { site: adapter.id, file }))).then((verdicts) => {
          if (verdicts.every((v) => v.action === "allow")) originalSend.call(this, body);
        });
        return;
      }
    }
    return originalSend.call(this, body ?? null);
  };
}

const adapter = matchAdapter(location.href, ADAPTERS);
if (adapter) {
  installSendHooks(adapter);
  installFileHooks(adapter);
  installNetworkHooks(adapter);
}

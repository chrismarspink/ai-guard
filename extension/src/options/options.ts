import { getPolicy } from "../policy/policy-loader";

const ACCOUNT_CONSENT_KEY = "accountConsent";

const consentEl = document.getElementById("consent") as HTMLInputElement;
const statusEl = document.getElementById("status") as HTMLElement;
const orgOffEl = document.getElementById("org-off") as HTMLElement;

function renderStatus(consent: boolean): void {
  statusEl.textContent = consent
    ? "현재: 계정 수집 동의함 (기기 정보 + 계정 이메일 수집)"
    : "현재: 계정 미수집 (기기 정보만 수집)";
  statusEl.className = `status ${consent ? "on" : "off"}`;
}

async function init(): Promise<void> {
  const [{ [ACCOUNT_CONSENT_KEY]: stored }, policy] = await Promise.all([
    chrome.storage.local.get(ACCOUNT_CONSENT_KEY),
    getPolicy(),
  ]);
  const consent = stored === true;
  consentEl.checked = consent;
  renderStatus(consent);
  // If the org disabled account collection, keep the toggle usable but tell the
  // user their consent won't take effect.
  orgOffEl.hidden = policy.accountCollection !== "off";
}

consentEl.addEventListener("change", async () => {
  await chrome.storage.local.set({ [ACCOUNT_CONSENT_KEY]: consentEl.checked });
  renderStatus(consentEl.checked);
});

void init();

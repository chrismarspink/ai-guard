import { BUILD_INFO } from "../build-info";
import { classify } from "../engine/t1-engine";
import { EVENT_FLUSH_RETRY_ALARM, enqueue, flush } from "../lib/event-queue";
import { getPolicy, onPolicyChange, SERVER_POLICY_CACHE_KEY, type Policy } from "../policy/policy-loader";

// Logged on every service-worker start so the running build (version + date) is
// visible in the extension's service-worker devtools console.
console.info(`[innoecm-ai-guard] v${BUILD_INFO.version} build ${BUILD_INFO.buildId} (${BUILD_INFO.buildDate})`);

export const DEFAULT_SERVER_BASE_URL = "https://chrismarspink-ai-guard-console.hf.space";

const HEARTBEAT_ALARM = "innoecm-heartbeat";
const FLUSH_ALARM = "innoecm-event-flush";
const INSTALL_CREDENTIALS_KEY = "installCredentials";

export interface InstallCredentials {
  installId: string;
  token: string;
}

function serverBaseUrl(policy: Policy): string {
  return policy.serverBaseUrl ?? DEFAULT_SERVER_BASE_URL;
}

function authHeaders(creds: InstallCredentials): Record<string, string> {
  return { Authorization: `Bearer ${creds.token}`, "X-Install-Id": creds.installId };
}

// The enrollment secret (P4) is read from managed (GPO/MDM) storage, not the
// server policy: registration is the bootstrap step that runs *before* any
// server policy is fetched, so the credential has to be available offline.
async function getEnrollSecret(): Promise<string | undefined> {
  try {
    const managed = await chrome.storage.managed.get("enrollSecret");
    const secret = (managed as { enrollSecret?: unknown }).enrollSecret;
    return typeof secret === "string" && secret ? secret : undefined;
  } catch {
    return undefined;
  }
}

async function registerInstall(baseUrl: string): Promise<InstallCredentials | null> {
  try {
    const enrollSecret = await getEnrollSecret();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (enrollSecret) headers["X-Enroll-Secret"] = enrollSecret;
    const res = await fetch(`${baseUrl}/api/v1/install/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({ version: chrome.runtime.getManifest().version }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { installId: string; token: string };
    const creds: InstallCredentials = { installId: body.installId, token: body.token };
    await chrome.storage.local.set({ [INSTALL_CREDENTIALS_KEY]: creds });
    return creds;
  } catch {
    return null;
  }
}

// The server never re-issues a lost token (only bcrypt hashes are stored), so
// a stored-but-now-invalid credential (e.g. a dev DB reset) must be dropped
// and re-registered from scratch rather than retried as-is.
async function getInstallCredentials(baseUrl: string): Promise<InstallCredentials | null> {
  const { [INSTALL_CREDENTIALS_KEY]: existing } = await chrome.storage.local.get(INSTALL_CREDENTIALS_KEY);
  if (existing && typeof existing.installId === "string" && typeof existing.token === "string") {
    return existing as InstallCredentials;
  }
  return registerInstall(baseUrl);
}

async function forgetInstallCredentials(): Promise<void> {
  await chrome.storage.local.remove(INSTALL_CREDENTIALS_KEY);
}

let cachedProfileEmail: string | null = null;

// "identity.email" (not full "identity"/OAuth) only asks Chrome for the
// signed-in profile's account info, no consent screen needed. Called with no
// `accountStatus` override, getProfileUserInfo only returns an email for a
// Chrome-managed (enterprise) profile -- personal/unmanaged profiles get ""
// -- which is the right default for a workplace DLP tool: it shouldn't pull
// a user's personal Gmail out of an unmanaged browser just because they
// sideloaded this extension. This is *who sent this event*, cached for the
// life of the service worker since it can't change mid-session.
export async function getProfileEmail(): Promise<string> {
  if (cachedProfileEmail !== null) return cachedProfileEmail;
  try {
    const info = await new Promise<{ email: string; id: string }>((resolve) => {
      chrome.identity.getProfileUserInfo((result) => resolve(result));
    });
    cachedProfileEmail = info.email || "";
  } catch {
    cachedProfileEmail = "";
  }
  return cachedProfileEmail;
}

let cachedPlatform: string | null = null;

// Static for the life of the service worker, same reasoning as
// cachedProfileEmail below -- no point re-asking chrome.runtime every heartbeat.
async function getPlatform(): Promise<string> {
  if (cachedPlatform !== null) return cachedPlatform;
  try {
    cachedPlatform = (await chrome.runtime.getPlatformInfo()).os;
  } catch {
    cachedPlatform = "";
  }
  return cachedPlatform;
}

export async function sendHeartbeat(): Promise<void> {
  const policy = await getPolicy();
  const baseUrl = serverBaseUrl(policy);
  const creds = await getInstallCredentials(baseUrl);
  if (!creds) return; // server unreachable / registration failed -- retried next alarm tick

  const [platform, email] = await Promise.all([getPlatform(), getProfileEmail()]);
  try {
    const res = await fetch(`${baseUrl}/api/v1/install/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(creds) },
      body: JSON.stringify({
        version: chrome.runtime.getManifest().version,
        enabled: true,
        platform,
        userAgent: navigator.userAgent,
        user: email || undefined,
      }),
    });
    if (res.status === 401) await forgetInstallCredentials();
  } catch {
    // Best-effort: a missed heartbeat is itself a compliance signal the
    // policy server cross-checks against osquery (plan doc §2.4).
  }
}

async function fetchAndCachePolicy(): Promise<void> {
  const policy = await getPolicy();
  const baseUrl = serverBaseUrl(policy);
  const creds = await getInstallCredentials(baseUrl);
  if (!creds) return;

  const { serverPolicyCacheEtag } = await chrome.storage.local.get("serverPolicyCacheEtag");
  try {
    const res = await fetch(`${baseUrl}/api/v1/policy`, {
      headers: {
        ...authHeaders(creds),
        ...(typeof serverPolicyCacheEtag === "string" ? { "If-None-Match": serverPolicyCacheEtag } : {}),
      },
    });
    if (res.status === 401) {
      await forgetInstallCredentials();
      return;
    }
    if (res.status === 304) return; // cache already fresh
    if (!res.ok) return;

    const fetched = (await res.json()) as Policy;
    const etag = res.headers.get("etag");
    await chrome.storage.local.set({
      [SERVER_POLICY_CACHE_KEY]: fetched,
      ...(etag ? { serverPolicyCacheEtag: etag } : {}),
    });
  } catch {
    // Offline / server down: keep serving whatever's already cached.
  }
}

async function scheduleHeartbeatAlarm(): Promise<void> {
  const policy = await getPolicy();
  await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: policy.heartbeatMin });
}

async function initialize(): Promise<void> {
  await scheduleHeartbeatAlarm();
  await chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 5 });
  await sendHeartbeat();
  await fetchAndCachePolicy();
}

chrome.runtime.onInstalled.addListener(() => void initialize());
chrome.runtime.onStartup.addListener(() => void initialize());

onPolicyChange(() => void scheduleHeartbeatAlarm());

async function flushEvents(): Promise<void> {
  const policy = await getPolicy();
  const baseUrl = serverBaseUrl(policy);
  const creds = await getInstallCredentials(baseUrl);
  if (!creds) return;
  const unauthorized = await flush(baseUrl, authHeaders(creds));
  if (unauthorized) await forgetInstallCredentials();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    void sendHeartbeat();
    void fetchAndCachePolicy();
    return;
  }
  if (alarm.name === FLUSH_ALARM || alarm.name === EVENT_FLUSH_RETRY_ALARM) {
    void flushEvents();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return undefined;

  if (message.type === "CLASSIFY_PROMPT") {
    sendResponse(classify(message.text));
    return false;
  }

  if (message.type === "LOG_EVENT") {
    void (async () => {
      const email = await getProfileEmail();
      const event = { ...message.event };
      if (email && !event.user) event.user = email;
      await enqueue(event);
      await flushEvents();
      sendResponse({ queued: true });
    })();
    return true;
  }

  // MIP_CHECK is not handled here on purpose: file classification needs the
  // File/Blob object itself, which cannot be structured-cloned from a
  // content script to the service worker. The ISOLATED content script calls
  // mip-parser.ts directly where it has File API access (see content-script.ts).

  return undefined;
});

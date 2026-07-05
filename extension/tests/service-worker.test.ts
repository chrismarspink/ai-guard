import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// service-worker.ts registers chrome.runtime/alarms listeners at import time,
// so the mock must cover everything touched during module load, not just
// what getProfileEmail() itself needs.
function installChromeMock(
  profileInfo: { email: string; id: string },
  opts: {
    platform?: string;
    installCredentials?: { installId: string; token: string };
    accountConsent?: boolean;
  } = {},
) {
  const local: Record<string, unknown> = {};
  if (opts.installCredentials) local.installCredentials = opts.installCredentials;
  if (opts.accountConsent) local.accountConsent = true;
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: () => ({ version: "0.1.0-test" }),
      getPlatformInfo: () => Promise.resolve({ os: opts.platform ?? "win" }),
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} },
    },
    alarms: {
      create: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      onAlarm: { addListener: () => {} },
    },
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: local[key] }),
        set: (obj: Record<string, unknown>) => {
          Object.assign(local, obj);
          return Promise.resolve();
        },
        remove: (key: string) => {
          delete local[key];
          return Promise.resolve();
        },
        onChanged: { addListener: () => {} },
      },
      managed: { get: () => Promise.resolve({}) },
      onChanged: { addListener: () => {} },
    },
    identity: {
      // Supports both the legacy (callback) and current (details, callback)
      // signatures -- the service worker calls it with { accountStatus }.
      getProfileUserInfo: (
        detailsOrCb: unknown,
        maybeCb?: (info: { email: string; id: string }) => void,
      ) => {
        const cb = (typeof detailsOrCb === "function" ? detailsOrCb : maybeCb) as
          (info: { email: string; id: string }) => void;
        cb(profileInfo);
      },
    },
  });
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (test-agent)" });
}

describe("getProfileEmail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("returns the managed profile's email when available", async () => {
    installChromeMock({ email: "user@company.example", id: "abc" });
    const { getProfileEmail } = await import("../src/background/service-worker");
    expect(await getProfileEmail()).toBe("user@company.example");
  });

  it("returns an empty string for an unmanaged profile (no email)", async () => {
    installChromeMock({ email: "", id: "" });
    const { getProfileEmail } = await import("../src/background/service-worker");
    expect(await getProfileEmail()).toBe("");
  });

  it("caches the result across calls instead of re-querying chrome.identity", async () => {
    let calls = 0;
    installChromeMock({ email: "user@company.example", id: "abc" });
    const original = (globalThis as any).chrome.identity.getProfileUserInfo;
    (globalThis as any).chrome.identity.getProfileUserInfo = (details: any, cb: (info: any) => void) => {
      calls += 1;
      original(details, cb);
    };
    const { getProfileEmail } = await import("../src/background/service-worker");
    await getProfileEmail();
    await getProfileEmail();
    expect(calls).toBe(1);
  });
});

describe("sendHeartbeat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("includes the account email only after the user consents", async () => {
    installChromeMock(
      { email: "user@company.example", id: "abc" },
      { platform: "mac", installCredentials: { installId: "install-1", token: "tok" }, accountConsent: true },
    );
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const { sendHeartbeat } = await import("../src/background/service-worker");
    await sendHeartbeat();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.platform).toBe("mac");
    expect(body.userAgent).toBe("Mozilla/5.0 (test-agent)");
    expect(body.user).toBe("user@company.example");
  });

  it("always sends device info but omits the account without consent", async () => {
    installChromeMock(
      { email: "user@company.example", id: "abc" },
      { platform: "mac", installCredentials: { installId: "install-1", token: "tok" } }, // no consent
    );
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const { sendHeartbeat } = await import("../src/background/service-worker");
    await sendHeartbeat();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.platform).toBe("mac");            // device: always
    expect(body.userAgent).toBe("Mozilla/5.0 (test-agent)");
    expect(body.user).toBeUndefined();            // account: gated on consent
  });
});

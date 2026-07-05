import defaultPolicy from "./default-policy.json";

export interface PolicySite {
  id: string;
  urls: string[];
  adapterVersion: string;
}

export interface Policy {
  policyVersion: string;
  mode: { prompt: "block" | "confirm" | "audit"; file: "block" | "confirm" | "audit" };
  sites: PolicySite[];
  gradeProfile: string;
  mipLabelMap: { allowO: string[]; denyUnlabeled: boolean };
  // 2026-07-02 product decision (deliberate deviation from the original
  // MIP-primary plan doc): contentScan (whole-file text through the T1
  // engine, only grade "O" passes) is v1's default primary file gate,
  // because it works without an org-wide MIP label rollout. mipCheck is an
  // optional secondary layer, off by default, for orgs that already label.
  fileCheck: { contentScan: boolean; mipCheck: boolean };
  userMessage: { blocked: string; confirm: string };
  heartbeatMin: number;
  logMasking: boolean;
  serverBaseUrl?: string;
  // Optional neural classifier (classifier-svc). When set, file content is
  // graded by the mDeBERTa-backed service, which handles large documents via
  // server-side token windowing. Falls back to the bundled local T1 engine
  // when unset or unreachable, so uploads are never left ungated.
  classifier?: { url: string; locale?: string; neuralBackend?: string };
}

// Bundled fallback used whenever no enterprise (managed) policy has been
// pushed -- normal and expected for unmanaged/dev installs.
const DEFAULT_POLICY = defaultPolicy as Policy;

function isPolicyShaped(value: unknown): value is Policy {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as Policy).sites) &&
    (value as Policy).sites.length > 0
  );
}

export const SERVER_POLICY_CACHE_KEY = "serverPolicyCache";

// Precedence: managed (GPO-pushed enterprise policy) > server-fetched cache
// (see background/service-worker.ts's fetchAndCachePolicy -- this is what
// makes admin-console policy edits actually reach installed extensions,
// since managed storage requires a separate GPO/MDM push) > bundled default.
export async function getPolicy(): Promise<Policy> {
  try {
    // Managed schema mirrors Policy's top-level keys 1:1, so an unmanaged
    // install resolves to `{}` here and we fall back further down.
    const managed = await chrome.storage.managed.get(null);
    if (isPolicyShaped(managed)) return managed as Policy;
  } catch {
    // Throws when no managed policy schema is registered at all.
  }

  const { [SERVER_POLICY_CACHE_KEY]: cached } = await chrome.storage.local.get(SERVER_POLICY_CACHE_KEY);
  if (isPolicyShaped(cached)) return cached as Policy;

  return DEFAULT_POLICY;
}

export function onPolicyChange(cb: (policy: Policy) => void): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "managed") {
      void getPolicy().then(cb);
      return;
    }
    // "local" holds unrelated keys too (event queue, install credentials) --
    // only react when the server-fetched policy cache specifically changed.
    if (areaName === "local" && SERVER_POLICY_CACHE_KEY in changes) {
      void getPolicy().then(cb);
    }
  });
}

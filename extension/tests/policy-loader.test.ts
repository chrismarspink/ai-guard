import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPolicy, SERVER_POLICY_CACHE_KEY } from "../src/policy/policy-loader";
import defaultPolicy from "../src/policy/default-policy.json";

function installChromeMock(managed: Record<string, unknown>, local: Record<string, unknown>) {
  vi.stubGlobal("chrome", {
    storage: {
      managed: {
        get: (_keys: null) => Promise.resolve(managed),
      },
      local: {
        get: (key: string) => Promise.resolve({ [key]: local[key] }),
      },
    },
  });
}

describe("policy-loader getPolicy precedence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the bundled default when nothing else is configured", async () => {
    installChromeMock({}, {});
    const policy = await getPolicy();
    expect(policy.policyVersion).toBe(defaultPolicy.policyVersion);
  });

  it("uses the server-fetched cache when no managed policy is pushed", async () => {
    const serverPolicy = { ...defaultPolicy, policyVersion: "from-server" };
    installChromeMock({}, { [SERVER_POLICY_CACHE_KEY]: serverPolicy });
    const policy = await getPolicy();
    expect(policy.policyVersion).toBe("from-server");
  });

  it("prefers managed (GPO-pushed) policy over the server cache", async () => {
    const managedPolicy = { ...defaultPolicy, policyVersion: "from-managed" };
    const serverPolicy = { ...defaultPolicy, policyVersion: "from-server" };
    installChromeMock(managedPolicy, { [SERVER_POLICY_CACHE_KEY]: serverPolicy });
    const policy = await getPolicy();
    expect(policy.policyVersion).toBe("from-managed");
  });

  it("ignores a malformed server cache entry and falls back to default", async () => {
    installChromeMock({}, { [SERVER_POLICY_CACHE_KEY]: { not: "a policy" } });
    const policy = await getPolicy();
    expect(policy.policyVersion).toBe(defaultPolicy.policyVersion);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueue, flush } from "../src/lib/event-queue";

function installChromeMock() {
  const local: Record<string, unknown> = {};
  const alarms = new Map<string, unknown>();
  vi.stubGlobal("chrome", {
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
      },
    },
    alarms: {
      create: (name: string, opts: unknown) => {
        alarms.set(name, opts);
        return Promise.resolve();
      },
      clear: (name: string) => {
        alarms.delete(name);
        return Promise.resolve();
      },
    },
  });
  return { local, alarms };
}

const AUTH = { Authorization: "Bearer test-token", "X-Install-Id": "install-1" };

describe("event-queue flush", () => {
  let mock: ReturnType<typeof installChromeMock>;

  beforeEach(() => {
    mock = installChromeMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does nothing when the queue is empty", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const unauthorized = await flush("http://server", AUTH);
    expect(unauthorized).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs one event at a time, not a batch wrapper", async () => {
    await enqueue({ type: "prompt_block", action: "blocked" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal("fetch", fetchMock);

    await flush("http://server", AUTH);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://server/api/v1/events");
    const body = JSON.parse(opts.body);
    expect(body.type).toBe("prompt_block");
    expect(body.events).toBeUndefined(); // regression guard: no {events:[...]} wrapper
    expect(opts.headers.Authorization).toBe("Bearer test-token");
    expect(opts.headers["X-Install-Id"]).toBe("install-1");
  });

  it("clears the queue once every event is accepted", async () => {
    await enqueue({ type: "prompt_block", action: "blocked" });
    await enqueue({ type: "file_block", action: "blocked" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 201 }));

    await flush("http://server", AUTH);

    expect(mock.local.eventQueue).toEqual([]);
  });

  it("keeps unsent events (including the one that failed) and schedules a retry on server error", async () => {
    await enqueue({ type: "prompt_block", action: "blocked" });
    await enqueue({ type: "file_block", action: "blocked" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const unauthorized = await flush("http://server", AUTH);

    expect(unauthorized).toBe(false);
    expect((mock.local.eventQueue as unknown[]).length).toBe(2);
    expect(mock.alarms.has("innoecm-event-flush-retry")).toBe(true);
  });

  it("stops and reports unauthorized on 401 without scheduling a retry alarm", async () => {
    await enqueue({ type: "prompt_block", action: "blocked" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    const unauthorized = await flush("http://server", AUTH);

    expect(unauthorized).toBe(true);
    expect((mock.local.eventQueue as unknown[]).length).toBe(1);
    expect(mock.alarms.has("innoecm-event-flush-retry")).toBe(false);
  });

  it("keeps the queue and schedules a retry when the network request throws", async () => {
    await enqueue({ type: "prompt_block", action: "blocked" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    const unauthorized = await flush("http://server", AUTH);

    expect(unauthorized).toBe(false);
    expect((mock.local.eventQueue as unknown[]).length).toBe(1);
    expect(mock.alarms.has("innoecm-event-flush-retry")).toBe(true);
  });
});

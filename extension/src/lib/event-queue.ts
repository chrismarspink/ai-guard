export interface QueuedEvent {
  type: string;
  ts?: string;
  [key: string]: unknown;
}

const STORAGE_KEY = "eventQueue";
const RETRY_STATE_KEY = "eventFlushRetryMinutes";
export const EVENT_FLUSH_RETRY_ALARM = "innoecm-event-flush-retry";
const MAX_RETRY_MINUTES = 10;

async function readQueue(): Promise<QueuedEvent[]> {
  const { [STORAGE_KEY]: queue } = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(queue) ? queue : [];
}

async function writeQueue(queue: QueuedEvent[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: queue });
}

export async function enqueue(event: QueuedEvent): Promise<void> {
  const queue = await readQueue();
  queue.push({ ...event, ts: event.ts ?? new Date().toISOString() });
  await writeQueue(queue);
}

async function scheduleRetry(): Promise<void> {
  const { [RETRY_STATE_KEY]: lastMinutes } = await chrome.storage.local.get(RETRY_STATE_KEY);
  const nextMinutes = Math.min(typeof lastMinutes === "number" ? lastMinutes * 2 : 1, MAX_RETRY_MINUTES);
  await chrome.storage.local.set({ [RETRY_STATE_KEY]: nextMinutes });
  await chrome.alarms.create(EVENT_FLUSH_RETRY_ALARM, { delayInMinutes: nextMinutes });
}

async function clearRetry(): Promise<void> {
  await chrome.storage.local.remove(RETRY_STATE_KEY);
  await chrome.alarms.clear(EVENT_FLUSH_RETRY_ALARM);
}

/**
 * POST /api/v1/events accepts one event per call (see server/app/api/events.py's
 * EventIn) -- there is no batch endpoint, so queued events are sent one at a
 * time here. Returns `true` if the server rejected the auth headers (401),
 * so the caller knows to drop and re-register install credentials.
 */
export async function flush(serverBaseUrl: string, authHeaders: Record<string, string>): Promise<boolean> {
  const queue = await readQueue();
  if (queue.length === 0) {
    await clearRetry();
    return false;
  }

  const remaining = [...queue];
  while (remaining.length > 0) {
    const event = remaining[0];
    let res: Response;
    try {
      res = await fetch(`${serverBaseUrl}/api/v1/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(event),
      });
    } catch {
      await writeQueue(remaining);
      await scheduleRetry();
      return false;
    }

    if (res.status === 401) {
      await writeQueue(remaining);
      return true;
    }
    if (!res.ok) {
      await writeQueue(remaining);
      await scheduleRetry();
      return false;
    }

    remaining.shift();
  }

  await writeQueue(remaining);
  await clearRetry();
  return false;
}

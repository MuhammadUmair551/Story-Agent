import { recordActiveRun } from "./story-agent.telemetry.js";

export type StoryAgentAdmission =
  | Readonly<{ kind: "accepted"; release: () => void }>
  | Readonly<{ kind: "queued" }>
  | Readonly<{ kind: "rate_limited"; retryAfterMs: number }>;

export type StoryAgentCapacity = Readonly<{
  acquire: (clientKey: string) => StoryAgentAdmission;
  acquireBackground: () => Readonly<{ kind: "accepted"; release: () => void }> | Readonly<{ kind: "queued" }>;
}>;

type Clock = Readonly<{ now: () => number }>;
type ClientWindow = { startedAt: number; count: number; lastSeenAt: number };
type CapacityDependencies = Readonly<{
  maxConcurrentRuns: number;
  maxRequestsPerWindow: number;
  requestWindowMs: number;
  maxTrackedClients: number;
  clock: Clock;
}>;

const normalizedKey = (value: string): string => value.trim().slice(0, 128) || "unknown";

/**
 * Lightweight per-process backpressure. Durable queued work is coordinated by
 * MongoDB; this feature deliberately has no load-balancing responsibility.
 */
export const createStoryAgentCapacity = ({
  maxConcurrentRuns,
  maxRequestsPerWindow,
  requestWindowMs,
  maxTrackedClients,
  clock
}: CapacityDependencies): StoryAgentCapacity => {
  let activeRuns = 0;
  const clients = new Map<string, ClientWindow>();

  const pruneExpiredClients = (now: number): void => {
    for (const [key, entry] of clients) {
      if (now - entry.lastSeenAt >= requestWindowMs) clients.delete(key);
    }
  };

  return Object.freeze({
    acquire: (clientKey): StoryAgentAdmission => {
      const now = clock.now();
      const key = normalizedKey(clientKey);
      let window = clients.get(key);
      if (window === undefined) {
        if (clients.size >= maxTrackedClients) pruneExpiredClients(now);
        if (clients.size >= maxTrackedClients) return Object.freeze({ kind: "rate_limited", retryAfterMs: requestWindowMs });
        window = { startedAt: now, count: 0, lastSeenAt: now };
        clients.set(key, window);
      }
      if (now - window.startedAt >= requestWindowMs) {
        window.startedAt = now;
        window.count = 0;
      }
      window.lastSeenAt = now;
      if (window.count >= maxRequestsPerWindow) {
        return Object.freeze({ kind: "rate_limited", retryAfterMs: Math.max(1, requestWindowMs - (now - window.startedAt)) });
      }
      window.count += 1;
      if (activeRuns >= maxConcurrentRuns) return Object.freeze({ kind: "queued" });
      activeRuns += 1;
      recordActiveRun(1);
      let released = false;
      return Object.freeze({
        kind: "accepted",
        release: (): void => {
          if (released) return;
          released = true;
          activeRuns -= 1;
          recordActiveRun(-1);
        }
      });
    },
    acquireBackground: () => {
      if (activeRuns >= maxConcurrentRuns) return Object.freeze({ kind: "queued" });
      activeRuns += 1;
      recordActiveRun(1);
      let released = false;
      return Object.freeze({
        kind: "accepted",
        release: (): void => {
          if (released) return;
          released = true;
          activeRuns -= 1;
          recordActiveRun(-1);
        }
      });
    }
  });
};

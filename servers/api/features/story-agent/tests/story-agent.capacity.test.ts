import test from "node:test";
import assert from "node:assert/strict";
import { createStoryAgentCapacity } from "../story-agent.capacity.js";

const createCapacity = (overrides: Partial<Readonly<{ maxConcurrentRuns: number; maxRequestsPerWindow: number; requestWindowMs: number; maxTrackedClients: number }>> = {}) => {
  let now = 0;
  const capacity = createStoryAgentCapacity({
    maxConcurrentRuns: 1,
    maxRequestsPerWindow: 2,
    requestWindowMs: 1_000,
    maxTrackedClients: 2,
    clock: { now: () => now },
    ...overrides
  });
  return { capacity, advance: (milliseconds: number): void => { now += milliseconds; } };
};

void test("caps concurrent model runs and sends overflow to the durable queue", () => {
  const { capacity } = createCapacity();
  const first = capacity.acquire("127.0.0.1");
  const second = capacity.acquire("127.0.0.2");

  assert.equal(first.kind, "accepted");
  assert.equal(second.kind, "queued");
  first.release();
  assert.equal(capacity.acquire("127.0.0.2").kind, "accepted");
});

void test("rate limits a noisy client without blocking another client", () => {
  const { capacity } = createCapacity({ maxConcurrentRuns: 2 });
  const first = capacity.acquire("127.0.0.1");
  if (first.kind === "accepted") first.release();
  const second = capacity.acquire("127.0.0.1");
  if (second.kind === "accepted") second.release();
  const limited = capacity.acquire("127.0.0.1");

  assert.equal(limited.kind, "rate_limited");
  assert.equal(capacity.acquire("127.0.0.2").kind, "accepted");
});

void test("opens a new client window after the configured interval", () => {
  const { capacity, advance } = createCapacity({ maxConcurrentRuns: 2, maxRequestsPerWindow: 1 });
  const first = capacity.acquire("client");
  if (first.kind === "accepted") first.release();
  assert.equal(capacity.acquire("client").kind, "rate_limited");
  advance(1_000);
  assert.equal(capacity.acquire("client").kind, "accepted");
});

void test("bounds client tracking memory under key-flooding traffic", () => {
  const { capacity } = createCapacity({ maxConcurrentRuns: 3, maxRequestsPerWindow: 1, maxTrackedClients: 1 });
  const first = capacity.acquire("one");
  if (first.kind === "accepted") first.release();
  assert.equal(capacity.acquire("two").kind, "rate_limited");
});

void test("background queue work shares the live model concurrency budget", () => {
  const { capacity } = createCapacity();
  const live = capacity.acquire("client");
  assert.equal(live.kind, "accepted");
  assert.equal(capacity.acquireBackground().kind, "queued");
  live.release();
  const background = capacity.acquireBackground();
  assert.equal(background.kind, "accepted");
  background.release();
});

void test("stays bounded under a burst of concurrent submissions", () => {
  const { capacity } = createCapacity({ maxConcurrentRuns: 3, maxRequestsPerWindow: 100, maxTrackedClients: 200 });
  const admissions = Array.from({ length: 100 }, (_, index) => capacity.acquire(`client-${String(index)}`));
  const accepted = admissions.filter((admission) => admission.kind === "accepted");
  const queued = admissions.filter((admission) => admission.kind === "queued");

  assert.equal(accepted.length, 3);
  assert.equal(queued.length, 97);
  for (const admission of accepted) admission.release();
  assert.equal(capacity.acquire("next-client").kind, "accepted");
});

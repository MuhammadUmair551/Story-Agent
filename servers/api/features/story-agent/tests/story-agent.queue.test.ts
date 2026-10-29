/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-condition */
import test from "node:test";
import assert from "node:assert/strict";
import type { Logger } from "@workspace/logging";
import { createStoryAgentQueue } from "../story-agent.queue.js";
import type { StoryAgentRepository, StoryAgentRunDocument } from "../story-agent.repository.js";
import type { StoryAgentPipelineResult } from "../story-agent.service.js";

const logger: Logger = { info: (): void => undefined, warn: (): void => undefined, error: (): void => undefined };
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const pipeline = (status: StoryAgentPipelineResult["status"]): StoryAgentPipelineResult => ({ status, attempts: 1, usage, providers: [], stages: [], validationErrors: [], ...(status === "draft" ? { stories: [] } : {}), ...(status === "queued" ? { reason: "providers_unavailable" } : {}) });
const queuedRun = (queueAttempts = 0): StoryAgentRunDocument => ({ runId: "run-1", status: "queued", requirement: "Create stories", usage, providers: [], attempts: 0, stages: [], validationErrors: [], queueAttempts, nextAttemptAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T01:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });

const repository = (run: StoryAgentRunDocument | null, updates: Array<{ status: string; extra: unknown }>): StoryAgentRepository => ({
  saveRun: async () => undefined,
  updateRunStatus: async (_id, status, extra) => { updates.push({ status, extra }); },
  getRun: async () => null,
  listRuns: async () => [],
  saveDraft: async () => undefined,
  getDraftByRun: async () => null,
  countQueuedRuns: async () => 0,
  claimQueuedRun: async () => run,
  ensureIndexes: async () => undefined
});

void test("processes a claimed run once and saves its draft", async () => {
  const updates: Array<{ status: string; extra: unknown }> = [];
  const queue = createStoryAgentQueue({ repository: repository(queuedRun(), updates), service: { run: async () => pipeline("draft") }, logger, clock: { now: () => 0 }, intervalMs: 120_000 });
  await queue.processNext();
  assert.equal(updates[0]?.status, "draft");
});

void test("queue monitoring failure does not prevent processing persisted work", async () => {
  const updates: Array<{ status: string; extra: unknown }> = [];
  const queue = createStoryAgentQueue({
    repository: { ...repository(queuedRun(), updates), getQueueStats: async () => { throw new Error("monitoring unavailable"); } },
    service: { run: async () => pipeline("draft") }, logger, clock: { now: () => 0 }, intervalMs: 120_000
  });
  await queue.processNext();
  assert.equal(updates[0]?.status, "draft");
});

void test("reschedules providers-unavailable runs", async () => {
  const updates: Array<{ status: string; extra: unknown }> = [];
  const queue = createStoryAgentQueue({ repository: repository(queuedRun(), updates), service: { run: async () => pipeline("queued") }, logger, clock: { now: () => 0 }, intervalMs: 120_000 });
  await queue.processNext();
  assert.equal(updates[0]?.status, "queued");
  assert.match(String((updates[0]?.extra as { nextAttemptAt?: string }).nextAttemptAt), /1970-01-01T00:02:00/);
});

void test("expires a run after five queue attempts", async () => {
  const updates: Array<{ status: string; extra: unknown }> = [];
  const queue = createStoryAgentQueue({ repository: repository(queuedRun(5), updates), service: { run: async () => pipeline("draft") }, logger, clock: { now: () => 0 }, intervalMs: 120_000 });
  await queue.processNext();
  assert.equal(updates[0]?.status, "failed");
  assert.equal((updates[0]?.extra as { reason?: string }).reason, "expired");
});

void test("preserves generated stories and clarification questions when queued work resolves", async () => {
  const updates: Array<{ status: string; extra: unknown }> = [];
  const queue = createStoryAgentQueue({
    repository: repository(queuedRun(), updates),
    service: { run: async () => ({ status: "questions", questions: ["Who is the actor?"], attempts: 1, usage, providers: ["gemini"], stages: [], validationErrors: [] }) },
    logger,
    clock: { now: () => 0 },
    intervalMs: 120_000
  });

  await queue.processNext();
  assert.equal(updates[0]?.status, "questions");
  assert.deepEqual((updates[0]?.extra as { questions?: string[] }).questions, ["Who is the actor?"]);

  const draftQueue = createStoryAgentQueue({
    repository: repository(queuedRun(), updates),
    service: { run: async () => ({ status: "draft", stories: [{ title: "Cart story", intent: "Add items", epic: "Cart", size: "S", acceptanceCriteria: ["An item can be added."], states: [], dependsOn: [], openQuestions: [], sliceRationale: "Adds the feature." }], attempts: 1, usage, providers: ["gemini"], stages: [], validationErrors: [] }) },
    logger,
    clock: { now: () => 0 },
    intervalMs: 120_000
  });

  await draftQueue.processNext();
  assert.equal(updates[1]?.status, "draft");
  assert.deepEqual((updates[1]?.extra as { stories?: unknown[] }).stories, [{ title: "Cart story", intent: "Add items", epic: "Cart", size: "S", acceptanceCriteria: ["An item can be added."], states: [], dependsOn: [], openQuestions: [], sliceRationale: "Adds the feature." }]);
});

void test("does not overlap queue processing while a provider run is still pending", async () => {
  const updates: Array<{ status: string; extra: unknown }> = [];
  let claims = 0;
  let runs = 0;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const base = repository(queuedRun(), updates);
  const queue = createStoryAgentQueue({
    repository: { ...base, claimQueuedRun: async () => { claims += 1; return queuedRun(); } },
    service: { run: async () => { runs += 1; await pending; return pipeline("draft"); } },
    logger,
    clock: { now: () => 0 },
    intervalMs: 120_000
  });

  const first = queue.processNext();
  const second = queue.processNext();
  release?.();
  await Promise.all([first, second]);

  assert.equal(claims, 1);
  assert.equal(runs, 1);
});

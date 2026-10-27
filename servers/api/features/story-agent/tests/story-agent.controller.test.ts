/* eslint-disable @typescript-eslint/require-await */
import test from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { createStoryAgentCapacity } from "../story-agent.capacity.js";
import { createStoryAgentController } from "../story-agent.controller.js";
import type { StoryAgentRepository } from "../story-agent.repository.js";
import type { StoryAgentPipelineResult } from "../story-agent.service.js";

const pipeline: StoryAgentPipelineResult = { status: "draft", stories: [{ title: "A customer adds a product", intent: "Add a product", epic: "Cart", size: "S", acceptanceCriteria: ["The cart contains the product."], states: [], dependsOn: [], openQuestions: [], sliceRationale: "Proves an add action." }], attempts: 2, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, providers: ["fake"], stages: [], validationErrors: [] };
const repository = (saved: unknown[]): StoryAgentRepository => ({ saveRun: async (document) => { saved.push(document); }, updateRunStatus: async () => undefined, getRun: async () => null, listRuns: async () => [], saveDraft: async (document) => { saved.push(document); }, getDraftByRun: async () => null, countQueuedRuns: async () => 0, claimQueuedRun: async () => null, ensureIndexes: async () => undefined });
const request = (): Request => ({ body: { requirement: "Create a cart story" }, socket: { remoteAddress: "test-client" } } as unknown as Request);
const response = (): Readonly<{ response: Pick<Response, "status" | "json">; values: { status?: number; body?: unknown } }> => {
  const values: { status?: number; body?: unknown } = {};
  const result: Pick<Response, "status" | "json"> = { status: (status) => { values.status = status; return result as Response; }, json: (body) => { values.body = body; return result as Response; } };
  return { response: result, values };
};
const unexpectedNext = (() => assert.fail("Unexpected next call.")) as NextFunction;

void test("rate-limited requests return 429 without saving a run or invoking the model", async () => {
  const saved: unknown[] = [];
  let calls = 0;
  const controller = createStoryAgentController({ repository: repository(saved), service: { run: async () => { calls += 1; return pipeline; } }, capacity: createStoryAgentCapacity({ maxConcurrentRuns: 1, maxRequestsPerWindow: 1, requestWindowMs: 60_000, maxTrackedClients: 10, clock: { now: () => 0 } }), clock: { now: () => 0 }, createRunId: () => "run-1" });
  const first = response();
  await controller.createRun(request(), first.response, unexpectedNext);
  const second = response();
  await controller.createRun(request(), second.response, unexpectedNext);

  assert.equal(first.values.status, 200);
  assert.equal(second.values.status, 429);
  assert.deepEqual(second.values.body, { error: "Too many Story Agent requests. Please try again shortly.", retryAfterMs: 60_000 });
  assert.equal(calls, 1);
  assert.equal(saved.length, 2);
});

void test("capacity overflow persists a queued run without calling an additional model", async () => {
  const saved: unknown[] = [];
  let calls = 0;
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const controller = createStoryAgentController({ repository: repository(saved), service: { run: async () => { calls += 1; await wait; return pipeline; } }, capacity: createStoryAgentCapacity({ maxConcurrentRuns: 1, maxRequestsPerWindow: 3, requestWindowMs: 60_000, maxTrackedClients: 10, clock: { now: () => 0 } }), clock: { now: () => 0 }, createRunId: () => `run-${String(saved.length)}` });
  const first = response();
  const running = controller.createRun(request(), first.response, unexpectedNext);
  const queued = response();
  await controller.createRun({ ...request(), socket: { remoteAddress: "another-client" } } as Request, queued.response, unexpectedNext);
  release?.();
  await running;

  assert.equal(calls, 1);
  assert.equal(queued.values.status, 202);
  assert.equal((queued.values.body as { status: string }).status, "queued");
  assert.equal((saved[0] as { reason?: string }).reason, "capacity_queued");
});

void test("controller safely queues a concurrent burst without multiplying provider work", async () => {
  const saved: unknown[] = [];
  let calls = 0;
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const controller = createStoryAgentController({
    repository: repository(saved),
    service: { run: async () => { calls += 1; await wait; return pipeline; } },
    capacity: createStoryAgentCapacity({ maxConcurrentRuns: 1, maxRequestsPerWindow: 100, requestWindowMs: 60_000, maxTrackedClients: 100, clock: { now: () => 0 } }),
    clock: { now: () => 0 },
    createRunId: () => `run-${String(saved.length)}`
  });
  const responses = Array.from({ length: 25 }, () => response());
  const pending = responses.map(({ response: currentResponse }, index) => controller.createRun({ ...request(), socket: { remoteAddress: `client-${String(index)}` } } as Request, currentResponse, unexpectedNext));
  await Promise.resolve();
  release?.();
  await Promise.all(pending);

  assert.equal(calls, 1);
  assert.equal(saved.length, 26);
  assert.equal(responses.filter(({ values }) => values.status === 202).length, 24);
  assert.equal(responses.filter(({ values }) => values.status === 200).length, 1);
});

void test("concurrent queue overflow cannot exceed the durable queue limit", async () => {
  const saved: unknown[] = [];
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const base = repository(saved);
  const controller = createStoryAgentController({
    repository: { ...base, countQueuedRuns: async () => saved.filter((document) => (document as { status?: string }).status === "queued").length },
    service: { run: async () => { await wait; return pipeline; } },
    capacity: createStoryAgentCapacity({ maxConcurrentRuns: 1, maxRequestsPerWindow: 100, requestWindowMs: 60_000, maxTrackedClients: 100, clock: { now: () => 0 } }),
    clock: { now: () => 0 },
    createRunId: () => `run-${String(saved.length)}`
  });
  const responses = Array.from({ length: 25 }, () => response());
  const pending = responses.map(({ response: currentResponse }, index) => controller.createRun({ ...request(), socket: { remoteAddress: `client-${String(index)}` } } as Request, currentResponse, unexpectedNext));
  await Promise.resolve();
  release?.();
  await Promise.all(pending);

  assert.equal(responses.filter(({ values }) => values.status === 202).length, 20);
  assert.equal(responses.filter(({ values }) => values.status === 503).length, 4);
  assert.equal(responses.filter(({ values }) => values.status === 200).length, 1);
  assert.equal(saved.filter((document) => (document as { status?: string }).status === "queued").length, 20);
});

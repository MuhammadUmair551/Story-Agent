import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import type { LlmCompletion, MongoPersistence, MongoDocument, MongoCollection } from "../../../integrations/index.js";
import { createStoryAgentProviderRouter } from "../story-agent.router.js";
import { createStoryAgentService, flattenPlan } from "../story-agent.service.js";
import { withStoryContext } from "../story-agent.metadata.js";
import { parseGeneratedOutput } from "../story-agent.output.js";
import { createStoryAgentRepository } from "../story-agent.repository.js";
import { createStoryAgentController } from "../story-agent.controller.js";
import { createStoryAgentFeature } from "../index.js";
import { createStoryAgentCapacity } from "../story-agent.capacity.js";
import type { StoryAgentPipelineInput, StoryAgentPipelineResult } from "../story-agent.service.js";
import { createStoryAgentQueue } from "../story-agent.queue.js";
import { emptyAccounting, retryDelayMs, type StoryAgentAccounting } from "../story-agent.execution.js";
import { createMemoryPersistence } from "./story-agent.memory.js";
import { withStoryApi } from "./story-agent.http-fixture.js";
import { plan } from "./story-agent.fixture.js";

const budget = { maxCalls: 6, maxTotalTokens: 12000, timeoutMs: 60000, contextTokenLimit: 1000, maxStories: 10 };
const clear = JSON.stringify({ needsClarification: false, questions: [], assumptions: [] });
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const bad = structuredClone(plan); Reflect.deleteProperty(bad.initiative.epics[0]?.features[0] ?? {}, "outcome");
const completion = (provider: string, text: string): LlmCompletion => ({ provider, model: "fixture", text, usage });
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const recovery = (secondaryValid = true, overrides: Partial<typeof budget> = {}) => {
  const calls: Record<string, number> = {}; const prompts: string[] = [];
  const route = createStoryAgentProviderRouter({
    config: { providers: ["primary", "secondary"].map(name => ({ name, model: "fixture", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only", timeoutMs: 1000 })), routes: { fast: ["primary"], generate: ["primary", "secondary"], tools: [] }, cooldownMs: 1000 },
    createClient: provider => ({ capabilities: { strictJsonSchema: true }, complete: input => {
      calls[provider.name] = (calls[provider.name] ?? 0) + 1; const prompt = input.messages[0]?.content ?? ""; prompts.push(prompt);
      return Promise.resolve(completion(provider.name, prompt.includes("BLOCKING ambiguity") ? clear : JSON.stringify({ plan: provider.name === "secondary" && secondaryValid ? plan : bad })));
    } }), logger, clock: { now: () => 0 }
  });
  return { service: createStoryAgentService({ route, now: () => 0, budget: { ...budget, ...overrides } }), calls, prompts };
};
void test("precise repair retains context then uses an independent capable provider after repeated invalid content", async () => {
  const fixture = recovery(); const result = await fixture.service.run({ requirement: "Readers resume chapters.", context: "Original fixture context" });
  assert.equal(result.status, "draft"); assert.deepEqual(fixture.calls, { primary: 3, secondary: 1 });
  assert.equal(result.attempts, 4); assert.equal(result.accounting?.contentFailures.primary, 2);
  assert.match(fixture.prompts[2] ?? "", /initiative.epics.0.features.0.outcome/);
  assert.match(fixture.prompts[2] ?? "", /Original fixture context/);
});
void test("all-provider malformed output exhausts bounded recovery with a precise failure and no partial draft", async () => {
  const fixture = recovery(false); const result = await fixture.service.run({ requirement: "Readers resume chapters." });
  assert.equal(result.status, "failed"); assert.equal(result.reason, "validation_failed");
  assert.equal(result.diagnostic?.category, "missing_required_field"); assert.equal(result.attempts, 4);
  assert.equal(result.plan, undefined); assert.equal(result.stories, undefined);
  assert.deepEqual(fixture.calls, { primary: 3, secondary: 1 });
});

const refinementRecovery = (output: (attempt: number) => Pick<LlmCompletion, "text" | "finishReason">) => {
  const prompts: string[] = [];
  const route = createStoryAgentProviderRouter({
    config: { providers: ["primary", "secondary"].map(name => ({ name, model: "fixture", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only", timeoutMs: 1000 })), routes: { fast: [], generate: ["primary", "secondary"], tools: [] }, cooldownMs: 1000 },
    createClient: provider => ({ capabilities: { strictJsonSchema: true }, complete: input => {
      prompts.push(input.messages[0]?.content ?? "");
      return Promise.resolve({ ...completion(provider.name, ""), ...output(prompts.length) });
    } }), logger, clock: { now: () => 0 }
  });
  return { service: createStoryAgentService({ route, now: () => 0, budget }), prompts };
};
const repairErrors = (prompt: string): unknown => JSON.parse(prompt.match(/<validation-errors-data>\s*(.*?)\s*<\/validation-errors-data>/s)?.[1] ?? "null") as unknown;
const refinementOriginal = () => withStoryContext("refinement-fixture", plan, flattenPlan(plan));
const storyPath = "initiative.epics.0.features.0.stories.0";
const wrongOutcome = structuredClone(plan); Reflect.set(wrongOutcome.initiative.epics[0]?.features[0] ?? {}, "outcome", 42);
const missingStories = structuredClone(plan); Reflect.deleteProperty(missingStories.initiative.epics[0]?.features[0] ?? {}, "stories");
for (const fixture of [
  { label: "invalid JSON", output: { text: '{"plan": nope}' }, category: "invalid_json" },
  { label: "truncated JSON", output: { text: '{"plan":{"initiative":' }, category: "truncated_json" },
  { label: "completion-limit truncation", output: { text: JSON.stringify({ plan }), finishReason: "length" as const }, category: "truncated_json" },
  { label: "missing nested outcome", output: { text: JSON.stringify({ plan: bad }) }, category: "missing_required_field" },
  { label: "missing nested stories", output: { text: JSON.stringify({ plan: missingStories }) }, category: "missing_required_field" },
  { label: "wrong field type", output: { text: JSON.stringify({ plan: wrongOutcome }) }, category: "invalid_field_type" },
  { label: "unsupported wrapper", output: { text: JSON.stringify({ deliveryPlan: plan }) }, category: "unsupported_response_shape" }
]) void test(`refinement preserves precise ${fixture.label} errors in both repairs and final diagnostics`, async () => {
  const decoded = parseGeneratedOutput(fixture.output); if (decoded.kind !== "invalid") assert.fail();
  assert.equal(decoded.category, fixture.category);
  const original = refinementOriginal(); const before = structuredClone(original);
  const recovery = refinementRecovery(() => fixture.output);
  const result = await recovery.service.run({ requirement: "Readers resume chapters.", refinement: { original, artifactPath: storyPath, instructions: "Clarify title" } });
  assert.equal(result.status, "failed"); assert.equal(result.plan, undefined); assert.equal(recovery.prompts.length, 3);
  for (const prompt of recovery.prompts.slice(1)) assert.deepEqual(repairErrors(prompt), decoded.errors);
  assert.deepEqual(result.validationErrors, decoded.errors); assert.equal(result.diagnostic?.category, fixture.category);
  assert.deepEqual(result.diagnostic.issues, decoded.issues); assert.deepEqual(original, before);
});
for (const identity of [undefined, "story:unknown", "duplicate"] as const) void test(`parsed refinement still rejects ${identity ?? "missing"} story identity with precise repair feedback`, async () => {
  const original = refinementOriginal(); const candidate = structuredClone(original);
  const stories = candidate.initiative.epics[0]?.features[0]?.stories; assert.ok(stories?.[0] && stories[1]);
  if (identity === undefined) Reflect.deleteProperty(stories[0], "artifactId");
  else Reflect.set(stories[0], "artifactId", identity === "duplicate" ? stories[1].artifactId : identity);
  const output = { text: JSON.stringify({ plan: candidate }) }; assert.equal(parseGeneratedOutput(output).kind, "plan");
  const recovery = refinementRecovery(() => output);
  const result = await recovery.service.run({ requirement: "Readers resume chapters.", refinement: { original, artifactPath: "initiative", instructions: "Clarify title" } });
  assert.equal(result.status, "failed"); assert.equal(result.plan, undefined); assert.equal(recovery.prompts.length, 3);
  assert.match(result.validationErrors.join(" "), /identity|artifactId/);
  assert.deepEqual(repairErrors(recovery.prompts[1] ?? ""), result.validationErrors);
  assert.deepEqual(result.diagnostic?.issues?.map(issue => issue.message), result.validationErrors);
});
void test("refinement repairs malformed output successfully while preserving omitted metadata and stable identity", async () => {
  const original = refinementOriginal(); const before = structuredClone(original); const candidate = structuredClone(original);
  const story = candidate.initiative.epics[0]?.features[0]?.stories[0]; assert.ok(story);
  Reflect.set(story, "title", "A reader returns to the saved chapter"); Reflect.deleteProperty(story, "metadata");
  const changes = [{ path: `${storyPath}.title`, explanation: "Clarifies the story title.", reason: "Name the saved reading outcome." }];
  const recovery = refinementRecovery(attempt => ({ text: attempt === 1 ? '{"plan": nope}' : JSON.stringify({ plan: candidate, changes }) }));
  const result = await recovery.service.run({ requirement: "Readers resume chapters.", refinement: { original, artifactPath: storyPath, instructions: "Clarify title" } });
  assert.equal(result.status, "draft"); assert.equal(recovery.prompts.length, 2); assert.equal(result.quality?.status, "passed");
  assert.deepEqual(result.refinementChanges, changes);
  assert.deepEqual(result.plan?.initiative.epics[0]?.features[0]?.stories[0], { ...before.initiative.epics[0]?.features[0]?.stories[0], title: story.title });
  assert.deepEqual(result.plan.initiative.epics[0].features[0].stories[1], before.initiative.epics[0]?.features[0]?.stories[1]);
  assert.deepEqual(original, before);
});
void test("invalid generation persists failure metadata and never persists a partial draft", async () => {
  await withStoryApi(recovery(false).service, async ({ request, repository }) => {
    const response = await request("/runs", "POST", { requirement: "Readers resume chapters." });
    assert.equal(response.status, 500);
    const body = await response.json() as { runId: string; diagnostic: { category: string; stage: string; retryable: boolean; httpStatus: number } };
    assert.ok(body.runId); assert.equal(body.diagnostic.category, "missing_required_field"); assert.equal(body.diagnostic.httpStatus, 500); assert.equal(body.diagnostic.retryable, false);
    assert.equal(await repository.getDraftByRun(body.runId), null);
    assert.equal((await repository.getRun(body.runId))?.accounting?.physicalAttempts, 4);
  });
});
for (const status of ["queued", "failed"] as const) void test(`${status} history without a plan cannot report passed quality or retained refinements`, async () => {
  await withStoryApi(recovery().service, async ({ repository, request }) => {
    await repository.saveRun({ runId: "unusable", status, requirement: "Fixture", plan, stories: flattenPlan(plan), quality: { status: "passed", checks: [] }, attempts: 0, usage, providers: [], stages: [], validationErrors: [], createdAt: "now", updatedAt: "now" });
    const body = await (await request("/runs/unusable")).json() as { run: { quality: { status: string }; plan?: unknown; refinements?: unknown } };
    assert.equal(body.run.quality.status, "not_evaluated"); assert.equal(body.run.plan, undefined); assert.equal(body.run.refinements, undefined);
    const list = await (await request("/runs")).json() as { runs: { quality: { status: string }; plan?: unknown; stories?: unknown; refinements?: unknown }[] };
    assert.equal(list.runs[0]?.quality.status, "not_evaluated"); assert.equal(list.runs[0].plan, undefined);
    assert.equal(list.runs[0].stories, undefined); assert.equal(list.runs[0].refinements, undefined);
  });
});

const failingService = (now: () => number, onCall: (provider: string) => void, maxCalls = 6, checkpoints?: StoryAgentAccounting[]) => {
  const route = createStoryAgentProviderRouter({ config: { providers: ["first", "second"].map(name => ({ name, model: "fixture", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only", timeoutMs: 1000 })), routes: { fast: ["first", "second"], generate: ["first", "second"], tools: [] }, cooldownMs: 1 },
    createClient: provider => ({ complete: () => { onCall(provider.name); return Promise.reject(Object.assign(new Error("private-transport-body"), { kind: "retryable", code: "provider_rate_limited", status: 429 })); } }), logger, clock: { now } });
  const service = createStoryAgentService({ route, now, budget: { ...budget, maxCalls } });
  return (accounting = emptyAccounting()) => service.run({ requirement: "Readers resume chapters.", execution: { runId: "budget", accounting, checkpoint: snapshot => { checkpoints?.push(snapshot); return Promise.resolve(); } } });
};
void test("physical failed HTTP attempts and fallback consume the same total budget", async () => {
  const calls: string[] = []; const run = failingService(() => 0, provider => { calls.push(provider); }, 1);
  const result = await run(); assert.equal(result.reason, "over_budget"); assert.equal(result.attempts, 1); assert.deepEqual(calls, ["first"]);
});
void test("queue continuation cannot reset previously consumed provider attempts", async () => {
  let now = 0; const calls: string[] = []; const run = failingService(() => now, provider => { calls.push(provider); }, 4);
  const first = await run(); assert.equal(first.status, "queued"); assert.equal(first.accounting?.physicalAttempts, 2);
  now = 120000;
  const second = await run(first.accounting); assert.equal(second.accounting?.physicalAttempts, 4);
  const third = await run(second.accounting); assert.equal(third.reason, "over_budget"); assert.equal(calls.length, 4);
});
void test("deadline exhaustion prevents the next fallback request", async () => {
  let now = 0; const calls: string[] = [];
  const run = failingService(() => now, provider => { calls.push(provider); now = 60000; });
  const result = await run(); assert.equal(result.reason, "over_budget"); assert.deepEqual(calls, ["first"]);
});
void test("durable timeout reservation precedes physical transport and is refunded only after settlement", async () => {
  const snapshots: StoryAgentAccounting[] = []; let checked = false;
  const run = failingService(() => 0, () => { assert.equal(snapshots.at(-1)?.elapsedMs, 1000); assert.ok((snapshots.at(-1)?.physicalAttempts ?? 0) > 0); checked = true; }, 2, snapshots);
  await run(); assert.ok(checked); assert.equal(snapshots.at(-1)?.elapsedMs, 0);
});
void test("checkpoint latency consumes the deadline before any physical request starts", async () => {
  let now = 0; let calls = 0;
  const route = createStoryAgentProviderRouter({ config: { providers: [{ name: "fixture", model: "fixture", baseUrl: "https://fixture.invalid", apiKey: "fixture-only", timeoutMs: 1000 }], routes: { fast: ["fixture"], generate: [], tools: [] }, cooldownMs: 1 },
    createClient: () => ({ complete: () => { calls++; return Promise.resolve(completion("fixture", clear)); } }), logger, clock: { now: () => now } });
  const service = createStoryAgentService({ route, now: () => now, budget });
  const result = await service.run({ requirement: "Readers resume chapters.", execution: { runId: "slow-checkpoint", checkpoint: () => { now = 60000; return Promise.resolve(); } } });
  assert.equal(calls, 0); assert.equal(result.reason, "over_budget");
});
void test("rejected admission releases a half-open trial without a physical request or extra cooldown", async () => {
  let now = 0; let calls = 0;
  const route = createStoryAgentProviderRouter({ config: { providers: [{ name: "fixture", model: "fixture", baseUrl: "https://fixture.invalid", apiKey: "fixture-only", timeoutMs: 1000 }], routes: { fast: ["fixture"], generate: [], tools: [] }, cooldownMs: 100 },
    createClient: () => ({ complete: () => { calls++; return calls <= 2 ? Promise.reject(Object.assign(new Error("safe fixture failure"), { kind: "retryable", code: "provider_rate_limited", status: 429 })) : Promise.resolve(completion("fixture", clear)); } }), logger, clock: { now: () => now } });
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(() => route.complete({ profile: "fast", messages: [] }));
  now = 100;
  await assert.rejects(() => route.complete({ profile: "fast", messages: [], beforeAttempt: () => Promise.reject(Object.assign(new Error("Budget exhausted"), { code: "over_budget" })) }), /Budget exhausted/);
  assert.equal(calls, 2);
  assert.equal((await route.complete({ profile: "fast", messages: [] })).provider, "fixture"); assert.equal(calls, 3);
});
void test("queue backoff is exponential, jittered and bounded", () => {
  assert.equal(retryDelayMs(120000, 1, () => 0), 120000);
  assert.equal(retryDelayMs(120000, 2, () => 0.5), 264000);
  assert.equal(retryDelayMs(120000, 100, () => 1), 720000);
});
void test("stale leases cannot publish drafts or overwrite a newer successful result", async () => {
  const repository = createStoryAgentRepository(createMemoryPersistence().db); await repository.ensureIndexes();
  await repository.saveRun({ runId: "leased", status: "queued", requirement: "Fixture", attempts: 0, usage, providers: [], stages: [], validationErrors: [], leaseId: "old", candidateLeaseId: "old", lockedUntil: "2026-01-01T00:00:00.000Z", nextAttemptAt: "2026-01-01T00:00:00.000Z", createdAt: "now", updatedAt: "now" });
  await repository.claimQueuedRun("2026-01-01T00:01:00.000Z", "2026-01-01T00:06:00.000Z", "new");
  await assert.rejects(() => repository.saveDraft({ runId: "leased", leaseId: "old", stories: [], plan, createdAt: "now" }), /lease/);
  await repository.updateRunStatus("leased", "queued", { candidateLeaseId: "new" }, "new");
  await repository.saveDraft({ runId: "leased", leaseId: "new", stories: [], plan, createdAt: "now" });
  await repository.updateRunStatus("leased", "draft", { plan, resultLeaseId: "new", leaseId: null }, "new");
  await assert.rejects(() => repository.updateRunStatus("leased", "failed", {}, "old"), /lease/);
  assert.equal((await repository.getRun("leased"))?.status, "draft"); assert.deepEqual((await repository.getDraftByRun("leased"))?.plan, plan);
});
void test("legacy queued work with unknowable budgets fails honestly without regenerating", async () => {
  const repository = createStoryAgentRepository(createMemoryPersistence().db); await repository.ensureIndexes();
  await repository.saveRun({ runId: "old", status: "queued", reason: "providers_unavailable", requirement: "Fixture", attempts: 2, usage, providers: ["fixture"], stages: [], validationErrors: [], nextAttemptAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "now" });
  let calls = 0;
  await createStoryAgentQueue({ repository, service: { run: () => { calls++; throw new Error("Must not call"); } }, logger, clock: { now: () => Date.parse("2026-01-01T00:00:00.000Z") }, intervalMs: 120000 }).processNext();
  assert.equal(calls, 0); assert.equal((await repository.getRun("old"))?.reason, "budget_history_unavailable");
});
void test("correlated routing logs contain safe identifiers but no prompt or upstream body", async () => {
  const logs: string[] = [];
  const route = createStoryAgentProviderRouter({ config: { providers: [{ name: "fixture", model: "fixture", baseUrl: "https://fixture.invalid", apiKey: "private-key", timeoutMs: 10 }], routes: { fast: ["fixture"], generate: [], tools: [] }, cooldownMs: 1 },
    createClient: () => ({ complete: () => Promise.reject(Object.assign(new Error("private-body"), { kind: "auth", status: 401, code: "provider_auth_failed" })) }),
    logger: { warn: (message, fields) => { logs.push(JSON.stringify({ message, ...fields })); } }, clock: { now: () => 0 } });
  await assert.rejects(() => route.complete({ profile: "fast", stage: "clarify", messages: [{ role: "user", content: "private-prompt" }], execution: { runId: "run-fixture", requestId: "request-fixture", traceId: "trace-fixture", leaseId: "lease-fixture" }, beforeAttempt: () => Promise.resolve({ timeoutMs: 10, attempt: 1 }) }));
  const text = logs.join(" "); for (const value of ["run-fixture", "request-fixture", "trace-fixture", "lease-fixture", "clarify", "providerAttempt"]) assert.ok(text.includes(value));
  assert.doesNotMatch(text, /private-key|private-body|private-prompt/);
});
void test("owner-scoped repeated request IDs are idempotent and cannot cross accounts", async () => {
  const memory = createMemoryPersistence(); let calls = 0;
  const feature = createStoryAgentFeature({ db: memory.db, logger, clock: { now: () => 0 }, queueIntervalMs: 120000, maxConcurrentRuns: 2, maxRequestsPerWindow: 100, requestWindowMs: 60000, maxTrackedClients: 100,
    routerConfig: { providers: [{ name: "fixture", model: "fixture", baseUrl: "https://fixture.invalid", apiKey: "fixture-only", timeoutMs: 100 }], routes: { fast: ["fixture"], generate: ["fixture"], tools: [] }, cooldownMs: 1 },
    llm: { createClient: () => ({ complete: input => { calls++; return Promise.resolve(completion("fixture", input.messages[0]?.content.includes("BLOCKING ambiguity") ? clear : JSON.stringify({ plan }))); } }) } });
  await feature.ensureIndexes();
  const request = { headers: { "x-request-id": "same-request" }, body: { requirement: "Readers resume chapters." }, socket: { remoteAddress: "fixture" } } as unknown as Request;
  const invoke = async (owner: string, requirement = request.body as unknown) => {
    let body: unknown; let status = 0;
    const response = { status: (value: number) => { status = value; return response; }, json: (value: unknown) => { body = value; return response; } };
    await createStoryAgentController(feature.scope(owner)).createRun({ ...request, body: requirement } as Request, response as unknown as Response, error => { throw error; });
    return { status, body: body as { runId: string } };
  };
  const first = await invoke("a"); const replay = await invoke("a"); assert.equal(first.status, 200); assert.equal(replay.body.runId, first.body.runId); assert.equal(calls, 2);
  assert.equal((await invoke("a", { requirement: "A different requirement" })).status, 409); assert.equal(calls, 2);
  const other = await invoke("b"); assert.notEqual(other.body.runId, first.body.runId); assert.equal(calls, 4);
});

const controllerFixture = async (run: (input: StoryAgentPipelineInput) => Promise<StoryAgentPipelineResult>) => {
  const repository = createStoryAgentRepository(createMemoryPersistence().db); await repository.ensureIndexes();
  const controller = createStoryAgentController({ repository, service: { run }, ownerId: "fixture-owner", logger, clock: { now: () => 0 },
    capacity: createStoryAgentCapacity({ maxConcurrentRuns: 2, maxRequestsPerWindow: 100, requestWindowMs: 60000, maxTrackedClients: 100, clock: { now: () => 0 } }) });
  return { repository, invoke: async () => {
    let body: unknown; let status = 0; const response = { status: (code: number) => { status = code; return response; }, json: (value: unknown) => { body = value; return response; } };
    await controller.createRun({ headers: { "x-request-id": "concurrent-request" }, body: { requirement: "Readers resume chapters." }, socket: { remoteAddress: "fixture" } } as unknown as Request, response as unknown as Response, error => { throw error; });
    return { status, body: body as { runId: string; status: string; diagnostic?: { retryable: boolean } } };
  } };
};
void test("concurrent duplicate submissions acknowledge the same reservation without another model execution", async () => {
  let release: (() => void) | undefined; let enter: (() => void) | undefined; let executions = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { enter = resolve; });
  const service = recovery().service;
  const fixture = await controllerFixture(async input => { executions++; enter?.(); await waiting; return await service.run(input); });
  const first = fixture.invoke(); await entered;
  const replay = await fixture.invoke(); assert.equal(replay.status, 202); assert.equal(executions, 1);
  release?.(); const completed = await first; assert.equal(completed.status, 200); assert.equal(completed.body.runId, replay.body.runId); assert.equal(executions, 1);
});
void test("interrupted persisted work retains its identity and counts toward queue capacity", async () => {
  const fixture = await controllerFixture(() => Promise.reject(new Error("private-internal-diagnostic")));
  const result = await fixture.invoke(); assert.equal(result.status, 503); assert.equal(result.body.status, "queued"); assert.ok(result.body.runId); assert.equal(result.body.diagnostic?.retryable, true);
  assert.equal(await fixture.repository.countQueuedRuns(), 1); assert.doesNotMatch(JSON.stringify(result.body), /private-internal-diagnostic/);
});
void test("an unpersisted attempt reservation cannot send a provider request", async () => {
  let calls = 0;
  const route = createStoryAgentProviderRouter({ config: { providers: [{ name: "fixture", baseUrl: "https://fixture.invalid", model: "fixture", apiKey: "fixture-only", timeoutMs: 100 }], routes: { fast: ["fixture"], generate: ["fixture"], tools: [] }, cooldownMs: 100 },
    createClient: () => ({ complete: () => { calls++; return Promise.resolve(completion("fixture", clear)); } }), logger, clock: { now: () => 0 } });
  const service = createStoryAgentService({ route, now: () => 0, budget });
  await assert.rejects(() => service.run({ requirement: "Readers resume chapters.", execution: { runId: "blocked", checkpoint: () => Promise.reject(Object.assign(new Error("Fixture checkpoint failure"), { code: "checkpoint_failed" })) } }));
  assert.equal(calls, 0);
});
void test("a queue claim with an exhausted cumulative budget never starts another transport", async () => {
  const repository = createStoryAgentRepository(createMemoryPersistence().db); await repository.ensureIndexes();
  await repository.saveRun({ runId: "spent", status: "queued", requirement: "Fixture", usage, providers: [], attempts: 6, accounting: { ...emptyAccounting(), physicalAttempts: 6 }, stages: [], validationErrors: [], nextAttemptAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "now" });
  const fixture = recovery();
  await createStoryAgentQueue({ repository, service: fixture.service, logger, clock: { now: () => Date.parse("2026-01-01T00:00:00.000Z") }, intervalMs: 120000 }).processNext();
  assert.deepEqual(fixture.calls, {}); assert.equal((await repository.getRun("spent"))?.reason, "over_budget"); assert.equal((await repository.getRun("spent"))?.attempts, 6);
});
void test("invalid stored output is not mistaken for a valid durable recovery draft", async () => {
  const repository = createStoryAgentRepository(createMemoryPersistence().db); await repository.ensureIndexes();
  await repository.saveRun({ runId: "invalid-stored", status: "queued", requirement: "Fixture", usage, providers: [], attempts: 0, accounting: emptyAccounting(), stages: [], validationErrors: [], nextAttemptAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "now" });
  await repository.saveDraft({ runId: "invalid-stored", stories: [], createdAt: "now" });
  const fixture = recovery();
  await createStoryAgentQueue({ repository, service: fixture.service, logger, clock: { now: () => Date.parse("2026-01-01T00:00:00.000Z") }, intervalMs: 120000 }).processNext();
  assert.equal((await repository.getRun("invalid-stored"))?.status, "draft"); assert.deepEqual((await repository.getDraftByRun("invalid-stored"))?.plan, plan); assert.equal(fixture.calls.secondary, 1);
});

void test("an old draft write cannot replace newer output when the lease changes between collection reads", async () => {
  const memory = createMemoryPersistence(); let interleave: (() => Promise<void>) | undefined;
  const db: MongoPersistence = { getCollection: <T extends MongoDocument>(name: string): MongoCollection<T> => {
    const collection = memory.db.getCollection<T>(name);
    return name === "story_agent_drafts" ? { ...collection, findOne: async filter => { if (interleave) await interleave(); return await collection.findOne(filter); } } : collection;
  } };
  const repository = createStoryAgentRepository(db); await repository.ensureIndexes();
  await repository.saveRun({ runId: "interleaved", status: "queued", requirement: "Fixture", attempts: 0, usage, providers: [], stages: [], validationErrors: [], leaseId: "old", candidateLeaseId: "old", lockedUntil: "2026-01-01T00:00:00.000Z", nextAttemptAt: "2026-01-01T00:00:00.000Z", createdAt: "now", updatedAt: "now" });
  interleave = async () => {
    interleave = undefined;
    await repository.claimQueuedRun("2026-01-01T00:01:00.000Z", "2026-01-01T00:06:00.000Z", "new");
    await repository.updateRunStatus("interleaved", "queued", { candidateLeaseId: "new" }, "new");
    await repository.saveDraft({ runId: "interleaved", leaseId: "new", stories: [], plan, createdAt: "new" });
    await repository.updateRunStatus("interleaved", "draft", { plan, resultLeaseId: "new", leaseId: null }, "new");
  };
  const oldPlan = { initiative: { ...plan.initiative, title: "Obsolete output" } };
  await assert.rejects(() => repository.saveDraft({ runId: "interleaved", leaseId: "old", stories: [], plan: oldPlan, createdAt: "old" }), /newer|lease/);
  assert.deepEqual((await memory.db.getCollection("story_agent_drafts").findOne({ runId: "interleaved" }))?.plan, plan);
  assert.deepEqual((await repository.getDraftByRun("interleaved"))?.plan, plan);
});

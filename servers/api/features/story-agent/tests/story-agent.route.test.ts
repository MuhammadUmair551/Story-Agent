/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-confusing-void-expression */
import { createServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Logger } from "@workspace/logging";
import type { MongoDocument, MongoPersistence } from "../../../integrations/index.js";
import { createErrorHandler } from "../../../middleware/index.js";
import { createStoryAgentRoutes } from "../routes/story-agent.route.js";
import { createStoryAgentCapacity } from "../story-agent.capacity.js";
import type { StoryAgentRepository } from "../story-agent.repository.js";
import type { StoryAgentPipelineResult } from "../story-agent.service.js";
import { createProjectRepository } from "../story-agent.projects.repository.js";
import { createIntelligenceRepository } from "../story-agent.intelligence.repository.js";
import { createMemoryPersistence } from "./story-agent.memory.js";
import { createStoryAgentFeature } from "../index.js";

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const story = { title: "A writer creates stories", intent: "Plan", epic: "Planning", size: "S" as const, acceptanceCriteria: ["Stories appear"], states: [], dependsOn: [], openQuestions: [], sliceRationale: "Proves creation." };
const logger: Logger = { info: (): void => undefined, warn: (): void => undefined, error: (): void => undefined };
const db: MongoPersistence = { getCollection: () => { throw new Error("Route test does not use Mongo directly."); } };
const additionalRepositories = () => {
  const memory = createMemoryPersistence();
  return { projects: createProjectRepository(memory.db), reviews: createIntelligenceRepository(memory.db) };
};
const capacity = () => createStoryAgentCapacity({ maxConcurrentRuns: 100, maxRequestsPerWindow: 100, requestWindowMs: 60_000, maxTrackedClients: 100, clock: { now: () => 0 } });

const result = (status: StoryAgentPipelineResult["status"]): StoryAgentPipelineResult => ({
  status, attempts: 1, usage, providers: ["gemini"], stages: [], validationErrors: [],
  ...(status === "draft" ? { stories: [story] } : {}),
  ...(status === "questions" ? { questions: ["Who is the actor?"] } : {}),
  ...(status === "failed" ? { reason: "provider_failed" } : {}),
  ...(status === "queued" ? { reason: "providers_unavailable" } : {})
});

const createRepository = (saved: unknown[]): StoryAgentRepository => ({
  saveRun: async (document) => { saved.push(document); },
  updateRunStatus: async () => undefined,
  getRun: async () => null,
  listRuns: async () => [],
  saveDraft: async (document) => { saved.push(document); },
  getDraftByRun: async () => null,
  countQueuedRuns: async () => 0,
  claimQueuedRun: async () => null,
  deleteRun: async () => "missing", saveRefinements: async () => false, ensureIndexes: async () => undefined
});

const closeServer = async (server: ReturnType<typeof createServer>): Promise<void> => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
};

const request = async (pipeline: StoryAgentPipelineResult, admission = capacity()): Promise<Readonly<{ response: Response; saved: unknown[] }>> => {
  const saved: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.use(createStoryAgentRoutes({
    db,
    ...additionalRepositories(),
    logger,
    clock: { now: () => 0 },
    repository: createRepository(saved),
    service: { run: async () => pipeline },
    capacity: admission
  }));
  app.use(createErrorHandler({ logger }));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/story-agent/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requirement: "Create stories" }) });
    return { response, saved };
  } finally { await closeServer(server); }
};

void test("POST saves and returns a draft", async () => {
  const outcome = await request(result("draft"));
  assert.equal(outcome.response.status, 200);
  assert.equal((await outcome.response.json() as { status: string }).status, "draft");
  assert.equal(outcome.saved.length, 2);
  assert.deepEqual((outcome.saved[0] as { stories?: unknown[] }).stories, [story]);
});

void test("POST persists question payloads for history restoration", async () => {
  const saved: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.use(createStoryAgentRoutes({
    db,
    ...additionalRepositories(),
    logger,
    clock: { now: () => 0 },
    repository: createRepository(saved),
    service: { run: async () => ({ status: "questions", attempts: 1, usage, providers: ["gemini"], stages: [], validationErrors: [], questions: ["Who is the actor?"] }) },
    capacity: capacity()
  }));
  app.use(createErrorHandler({ logger }));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let response: Response;
  try { response = await fetch(`http://127.0.0.1:${String(address.port)}/story-agent/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requirement: "Create stories" }) }); }
  finally { await closeServer(server); }
  assert.equal(response.status, 200);
  assert.deepEqual((saved[0] as { questions?: string[] }).questions, ["Who is the actor?"]);
});

void test("POST saves queued runs and returns 202", async () => {
  const outcome = await request(result("queued"));
  assert.equal(outcome.response.status, 202);
  assert.equal((await outcome.response.json() as { status: string }).status, "queued");
  assert.equal(outcome.saved.length, 1);
});

void test("POST saves failed runs and returns 500", async () => {
  const outcome = await request(result("failed"));
  assert.equal(outcome.response.status, 500);
  assert.equal((await outcome.response.json() as { status: string }).status, "failed");
  assert.equal(outcome.saved.length, 1);
});

void test("POST returns the first validation error instead of an opaque validation failure", async () => {
  const outcome = await request({ ...result("failed"), reason: "validation_failed", validationErrors: ["At most 10 stories are allowed."] });

  assert.equal(outcome.response.status, 500);
  assert.equal((await outcome.response.json() as { error: string }).error, "At most 10 stories are allowed.");
});

void test("POST rejects invalid request bodies", async () => {
  const saved: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.use(createStoryAgentRoutes({ db, ...additionalRepositories(), logger, clock: { now: () => 0 }, repository: createRepository(saved), service: { run: async () => result("draft") }, capacity: capacity() }));
  app.use(createErrorHandler({ logger }));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let response: Response;
  try { response = await fetch(`http://127.0.0.1:${String(address.port)}/story-agent/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requirement: "" }) }); }
  finally { await closeServer(server); }
  assert.equal(response.status, 400);
  assert.equal(saved.length, 0);
});

void test("POST rate limits repeated expensive requests before invoking the model", async () => {
  const admission = createStoryAgentCapacity({ maxConcurrentRuns: 1, maxRequestsPerWindow: 1, requestWindowMs: 60_000, maxTrackedClients: 10, clock: { now: () => 0 } });
  const first = await request(result("draft"), admission);
  const second = await request(result("draft"), admission);

  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 429);
  assert.equal((await second.response.json() as { retryAfterMs: number }).retryAfterMs, 60_000);
  assert.equal(second.saved.length, 0);
});

void test("feature composition creates repositories once and route/index setup reuses them", async (context) => {
  for (const [key, value] of Object.entries({ NODE_ENV: "test", API_HOST: "127.0.0.1", API_PORT: "4000", PORT: "4000", WEB_ORIGIN: "http://localhost:3000", LOG_LEVEL: "silent" })) {
    const previous = process.env[key];
    context.after(() => { if (previous === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = previous; });
    process.env[key] = value;
  }
  const memory = createMemoryPersistence(); const lookups: string[] = [];
  const feature = createStoryAgentFeature({ db: { getCollection: <T extends MongoDocument>(name: string) => { lookups.push(name); return memory.db.getCollection<T>(name); } }, llm: { createClient: () => { throw new Error("Composition must not call a provider."); } }, logger, clock: { now: () => 0 }, queueIntervalMs: 1000, maxConcurrentRuns: 10, maxRequestsPerWindow: 100, requestWindowMs: 60000, maxTrackedClients: 100 });
  const composedLookups = [...lookups];
  assert.ok(composedLookups.includes("story_agent_projects"));
  createStoryAgentRoutes(feature.routeDependencies);
  await feature.ensureIndexes();
  createStoryAgentRoutes(feature.routeDependencies);
  assert.deepEqual(lookups, composedLookups);
  assert.ok(memory.indexes.includes("story_agent_projects:projectId:true"));
});

void test("project routes use the injected repository without touching the route Mongo dependency", async () => {
  const dependencies = additionalRepositories();
  const app = express(); app.use(express.json());
  app.use(createStoryAgentRoutes({ db, ...dependencies, logger, clock: { now: () => 0 }, repository: createRepository([]), service: { run: async () => result("draft") }, capacity: capacity() }));
  app.use(createErrorHandler({ logger }));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/story-agent/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Reading", rules: { glossary: [], roles: [], naming: [], rules: [], acceptanceCriteria: { format: "checklist", instructions: "", examples: [] } } }) });
    assert.equal(response.status, 200);
    assert.equal((await dependencies.projects.list())[0]?.name, "Reading");
  } finally { await closeServer(server); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { createStoryAgentRepository, type StoryAgentDraftDocument, type StoryAgentRunDocument } from "../story-agent.repository.js";

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const run = (runId: string, createdAt: string): StoryAgentRunDocument => ({
  runId, status: "draft", requirement: "Create stories", usage, providers: [], attempts: 1, stages: [], validationErrors: [], createdAt, updatedAt: createdAt
});

import { createMemoryPersistence } from "./story-agent.memory.js";

void test("saves, retrieves, updates, lists, and indexes runs", async () => {
  const persistence = createMemoryPersistence();
  const repository = createStoryAgentRepository(persistence.db);
  await repository.saveRun(run("run-1", "2026-01-01T00:00:00.000Z"));
  await repository.saveRun(run("run-2", "2026-01-02T00:00:00.000Z"));
  await repository.updateRunStatus("run-1", "queued", { reason: "providers_unavailable" });

  assert.equal((await repository.getRun("run-1"))?.status, "queued");
  assert.equal((await repository.getRun("run-1"))?.reason, "providers_unavailable");
  assert.deepEqual((await repository.listRuns({ limit: 1, skip: 0 })).map(({ runId }) => runId), ["run-2"]);
  await repository.ensureIndexes();
  assert.deepEqual(persistence.indexes, [
    "story_agent_runs:runId:true",
    "story_agent_runs:createdAt:undefined",
    "story_agent_runs:status,nextAttemptAt,lockedUntil,createdAt:undefined",
    "story_agent_drafts:runId:true"
  ]);
});

void test("saves and retrieves drafts by run id", async () => {
  const persistence = createMemoryPersistence();
  const repository = createStoryAgentRepository(persistence.db);
  const draft: StoryAgentDraftDocument = { runId: "run-1", stories: [], createdAt: "2026-01-01T00:00:00.000Z" };

  await repository.saveDraft(draft);

  assert.deepEqual(await repository.getDraftByRun("run-1"), draft);
});

void test("counts queued runs without materializing the queue", async () => {
  const persistence = createMemoryPersistence();
  const repository = createStoryAgentRepository(persistence.db);
  await repository.saveRun({ ...run("queued", "2026-01-01T00:00:00.000Z"), status: "queued" });
  await repository.saveRun(run("draft", "2026-01-02T00:00:00.000Z"));

  assert.equal(await repository.countQueuedRuns(), 1);
});

void test("persists run metadata needed to restore history state", async () => {
  const persistence = createMemoryPersistence();
  const repository = createStoryAgentRepository(persistence.db);
  const document: StoryAgentRunDocument = {
    runId: "run-2",
    status: "questions",
    requirement: "Create checkout stories",
    questions: ["Who is the actor?"],
    usage,
    providers: ["gemini"],
    attempts: 1,
    stages: [],
    validationErrors: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };

  await repository.saveRun(document);

  const saved = await repository.getRun("run-2");
  assert.deepEqual(saved?.questions, ["Who is the actor?"]);
  assert.equal(saved.requirement, "Create checkout stories");
});

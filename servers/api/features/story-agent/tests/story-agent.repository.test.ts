import test from "node:test";
import assert from "node:assert/strict";
import type { MongoCollection, MongoDocument, MongoPersistence } from "../../../integrations/index.js";
import { createStoryAgentRepository, type StoryAgentDraftDocument, type StoryAgentRunDocument } from "../story-agent.repository.js";

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const run = (runId: string, createdAt: string): StoryAgentRunDocument => ({
  runId, status: "draft", requirement: "Create stories", usage, providers: [], attempts: 1, stages: [], validationErrors: [], createdAt, updatedAt: createdAt
});

const matches = <TDocument extends MongoDocument>(document: TDocument, filter: Partial<TDocument>): boolean =>
  Object.entries(filter).every(([key, value]) => document[key] === value);

const createMemoryPersistence = (): Readonly<{ db: MongoPersistence; indexes: string[] }> => {
  const documents = new Map<string, MongoDocument[]>();
  const indexes: string[] = [];
  const collection = <TDocument extends MongoDocument>(name: string): MongoCollection<TDocument> => ({
    insertOne: (document) => {
      const items = documents.get(name) ?? [];
      items.push(document);
      documents.set(name, items);
      return Promise.resolve({ insertedId: items.length });
    },
    findOne: (filter) => Promise.resolve((documents.get(name) ?? []).find((document) => matches(document, filter)) as TDocument | undefined ?? null),
    find: (filter, options) => {
      const items = (documents.get(name) ?? []).filter((document) => matches(document, filter));
      const sorted = options?.sort ? [...items].sort((left, right) => {
        const [key, direction] = Object.entries(options.sort ?? {})[0] ?? ["", 1];
        return String(left[key]).localeCompare(String(right[key])) * direction;
      }) : items;
      return Promise.resolve(sorted.slice(options?.skip ?? 0, (options?.skip ?? 0) + (options?.limit ?? sorted.length)) as TDocument[]);
    },
    countDocuments: (filter) => Promise.resolve((documents.get(name) ?? []).filter((document) => matches(document, filter)).length),
    updateOne: (filter, update) => {
      const item = (documents.get(name) ?? []).find((document) => matches(document, filter));
      if (!item) return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });
      Object.assign(item, update.$set ?? {});
      return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
    },
    findOneAndUpdate: (filter, update) => {
      const item = (documents.get(name) ?? []).find((document) => matches(document, filter as Partial<TDocument>));
      if (!item) return Promise.resolve(null);
      Object.assign(item, update.$set ?? {});
      const mutable = item as Record<string, unknown>;
      for (const [key, amount] of Object.entries(update.$inc ?? {})) mutable[key] = Number(mutable[key] ?? 0) + (amount ?? 0);
      return Promise.resolve(item as TDocument);
    },
    createIndex: (spec, options) => {
      indexes.push(`${name}:${Object.keys(spec).join(",")}:${String(options?.unique)}`);
      return Promise.resolve(options?.name ?? "index");
    }
  });
  return { db: { getCollection: collection }, indexes };
};

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

import test from "node:test";
import assert from "node:assert/strict";
import type { Logger } from "@workspace/logging";
import { createMongoDbIntegration, type MongoClient, type MongoCollection, type MongoDatabase, type MongoDocument } from "../integrations/index.js";

void test("keeps persistence optional when MongoDB is not configured", async (): Promise<void> => {
  const messages: string[] = [];
  const logger: Logger = {
    info: (message): void => { messages.push(message); },
    warn: (): void => undefined,
    error: (): void => undefined
  };
  const integration = createMongoDbIntegration({ logger });

  await integration.connect();
  await integration.disconnect();

  assert.deepEqual(messages, ["MongoDB connection is not configured; starting without persistence."]);
});

void test("composes the server-owned MongoDB integration when configured", async (): Promise<void> => {
  const calls: string[] = [];
  const client: MongoClient = {
    connect: (uri): Promise<MongoDatabase> => {
      calls.push(`connect:${uri}`);
      return Promise.resolve({ collection: () => ({
        insertOne: () => Promise.resolve({ insertedId: "unused" }),
        findOne: () => Promise.resolve(null),
        find: () => Promise.resolve([]),
        countDocuments: () => Promise.resolve(0),
        updateOne: () => Promise.resolve({ matchedCount: 0, modifiedCount: 0 }),
        findOneAndUpdate: () => Promise.resolve(null),
        createIndex: () => Promise.resolve("unused")
      }) });
    },
    disconnect: (): Promise<void> => {
      calls.push("disconnect");
      return Promise.resolve();
    }
  };
  const logger: Logger = {
    info: (message): void => { calls.push(`log:${message}`); },
    warn: (): void => undefined,
    error: (): void => undefined
  };
  const integration = createMongoDbIntegration({
    uri: "mongodb://example.test/workspace",
    client,
    logger
  });

  await integration.connect();
  await integration.disconnect();

  assert.deepEqual(calls, [
    "connect:mongodb://example.test/workspace",
    "log:MongoDB connection established.",
    "disconnect"
  ]);
});

void test("exposes typed collections to feature dependencies after connecting", async (): Promise<void> => {
  type RunDocument = MongoDocument & Readonly<{ runId: string; status: string }>;
  const calls: string[] = [];
  const collection: MongoCollection<RunDocument> = {
    insertOne: (document) => {
      calls.push(`insert:${document.runId}`);
      return Promise.resolve({ insertedId: document.runId });
    },
    findOne: (filter) => {
      calls.push(`find:${String(filter.runId)}`);
      return Promise.resolve(null);
    },
    find: (filter, options) => {
      calls.push(`find:${String(filter.status)}:${String(options?.skip)}:${String(options?.limit)}`);
      return Promise.resolve([{ runId: "run-2", status: "draft" }]);
    },
    countDocuments: (filter) => {
      calls.push(`count:${String(filter.status)}`);
      return Promise.resolve(1);
    },
    updateOne: (filter, update) => {
      calls.push(`update:${String(filter.runId)}:${String(update.$set?.status)}`);
      return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
    },
    findOneAndUpdate: () => Promise.resolve(null),
    createIndex: (spec, options) => {
      calls.push(`index:${String(spec.runId)}:${String(options?.unique)}`);
      return Promise.resolve("runId_unique");
    }
  };
  const client: MongoClient = {
    connect: (): Promise<MongoDatabase> => Promise.resolve({
      collection: <TDocument extends MongoDocument>(name: string): MongoCollection<TDocument> => {
        calls.push(`collection:${name}`);
        return collection as unknown as MongoCollection<TDocument>;
      }
    }),
    disconnect: (): Promise<void> => Promise.resolve()
  };
  const logger: Logger = { info: (): void => undefined, warn: (): void => undefined, error: (): void => undefined };
  const database = createMongoDbIntegration({ uri: "mongodb://example.test/workspace", client, logger });

  await database.connect();
  const runs = database.getCollection<RunDocument>("story_agent_runs");
  await runs.insertOne({ runId: "run-1", status: "draft" });
  await runs.findOne({ runId: "run-1" });
  assert.deepEqual(await runs.find({ status: "draft" }, { sort: { runId: -1 }, skip: 1, limit: 2 }), [{ runId: "run-2", status: "draft" }]);
  assert.equal(await runs.countDocuments({ status: "draft" }), 1);
  assert.deepEqual(await runs.updateOne({ runId: "run-1" }, { $set: { status: "questions" } }), { matchedCount: 1, modifiedCount: 1 });
  assert.equal(await runs.createIndex({ runId: 1 }, { unique: true, name: "runId_unique" }), "runId_unique");

  assert.deepEqual(calls, [
    "collection:story_agent_runs",
    "insert:run-1",
    "find:run-1",
    "find:draft:1:2",
    "count:draft",
    "update:run-1:questions",
    "index:1:true"
  ]);
});

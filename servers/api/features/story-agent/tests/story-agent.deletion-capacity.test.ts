import test from "node:test";
import assert from "node:assert/strict";
import { createStoryAgentRepository } from "../story-agent.repository.js";
import { createMemoryPersistence } from "./story-agent.memory.js";

const queued = (runId: string, createdAt = "2026-11-08T00:00:00.000Z") => ({ runId, status: "queued" as const, requirement: "Resume a chapter", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, providers: [], attempts: 0, stages: [], validationErrors: [], createdAt, updatedAt: createdAt, nextAttemptAt: createdAt, lockedUntil: null });

void test("failed deletion markers consume neither admission depth nor oldest queue statistics", async () => {
  const memory = createMemoryPersistence(); const repository = createStoryAgentRepository(memory.db);
  memory.failures.deleteDraft = true;
  for (let index = 0; index < 20; index += 1) {
    const id = `pending-${String(index)}`; await repository.saveRun(queued(id));
    await assert.rejects(repository.deleteRun(id, "2026-11-08T00:01:00.000Z"), /Storage unavailable/);
  }
  memory.failures.deleteDraft = false;
  assert.equal(await repository.countQueuedRuns(), 0);
  assert.deepEqual(await repository.getQueueStats?.(), { depth: 0 });
  assert.equal(await repository.claimQueuedRun("2026-11-08T00:02:00.000Z", "2026-11-08T00:07:00.000Z"), null);
  await repository.saveRun(queued("normal", "2026-11-08T00:02:00.000Z"));
  assert.deepEqual(await repository.getQueueStats?.(), { depth: 1, oldestCreatedAt: "2026-11-08T00:02:00.000Z" });
  assert.equal((await repository.claimQueuedRun("2026-11-08T00:03:00.000Z", "2026-11-08T00:08:00.000Z"))?.runId, "normal");
  // A genuine queued run with an active processing lease still occupies capacity.
  assert.equal(await repository.countQueuedRuns(), 1);
  assert.equal(await repository.deleteRun("normal", "2026-11-08T00:04:00.000Z"), "busy");
  assert.equal(await repository.countQueuedRuns(), 1);
});

void test("cleanup retry removes only its artifacts and leaves eligible queue counts unchanged", async () => {
  const memory = createMemoryPersistence(); const repository = createStoryAgentRepository(memory.db);
  await repository.saveRun(queued("pending")); await repository.saveDraft({ runId: "pending", stories: [], createdAt: "now" });
  await repository.saveRun(queued("unrelated")); await repository.saveDraft({ runId: "unrelated", stories: [], createdAt: "now" });
  memory.failures.deleteDraft = true;
  await assert.rejects(repository.deleteRun("pending", "2026-11-08T00:01:00.000Z"), /Storage unavailable/);
  assert.equal(await repository.countQueuedRuns(), 1);
  memory.failures.deleteDraft = false;
  assert.equal(await repository.deleteRun("pending", "2026-11-08T00:02:00.000Z"), "deleted");
  assert.equal(await repository.getRun("pending"), null); assert.equal(await repository.getDraftByRun("pending"), null);
  assert.equal(await repository.countQueuedRuns(), 1); assert.ok(await repository.getDraftByRun("unrelated"));
  assert.equal(await repository.deleteRun("pending", "2026-11-08T00:03:00.000Z"), "missing");
  assert.equal(await repository.countQueuedRuns(), 1);
});

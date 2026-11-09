import { createServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Logger } from "@workspace/logging";
import { createStoryAgentRoutes } from "../routes/story-agent.route.js";
import { createStoryAgentService, flattenPlan } from "../story-agent.service.js";
import { createStoryAgentRepository } from "../story-agent.repository.js";
import { createStoryAgentCapacity } from "../story-agent.capacity.js";
import { createErrorHandler } from "../../../middleware/index.js";
import { createMemoryPersistence } from "./story-agent.memory.js";
import { plan } from "./story-agent.fixture.js";
import { artifactValue } from "../story-agent.refinement.js";
import { createProjectRepository } from "../story-agent.projects.repository.js";
import { createIntelligenceRepository } from "../story-agent.intelligence.repository.js";

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

const withApi = async (run: (input: Readonly<{ request: (path: string, method?: string, body?: unknown) => Promise<Response>; memory: ReturnType<typeof createMemoryPersistence>; repository: ReturnType<typeof createStoryAgentRepository> }>) => Promise<void>, providerFailure = false): Promise<void> => {
  const memory = createMemoryPersistence(); const repository = createStoryAgentRepository(memory.db);
  for (const id of ["one", "two"]) {
    await repository.saveRun({ runId: id, plan, stories: flattenPlan(plan), status: "draft", requirement: "Readers resume and clear a saved chapter", usage, providers: [], attempts: 1, stages: [], validationErrors: [], createdAt: "2026-11-08", updatedAt: "2026-11-08" });
    await repository.saveDraft({ runId: id, plan, stories: flattenPlan(plan), createdAt: "2026-11-08" });
  }
  const service = createStoryAgentService({ now: () => 0, budget: { maxCalls: 6, maxTotalTokens: 1000, timeoutMs: 10000, contextTokenLimit: 6000, maxStories: 10 }, route: { complete: (input) => {
    const data = input.messages[0]?.content.match(/<refinement-data>(.*?)<\/refinement-data>/s)?.[1];
    const parsed: unknown = data ? JSON.parse(data) : undefined;
    const original = typeof parsed === "object" && parsed !== null && "original" in parsed ? parsed.original as typeof plan : plan;
    const path = typeof parsed === "object" && parsed !== null && "artifactPath" in parsed && typeof parsed.artifactPath === "string" ? parsed.artifactPath : "initiative";
    const proposed = structuredClone(original); const target = artifactValue(proposed, path);
    if (typeof target !== "object" || target === null || !("title" in target) || typeof target.title !== "string") throw new Error("Unexpected test artifact.");
    target.title = path === "initiative" ? "Resume reading confidently" : `${target.title} clarified`;
    return providerFailure ? Promise.reject(new Error("Provider unavailable")) : Promise.resolve({ text: JSON.stringify(!data && input.messages[0]?.content.includes("needsClarification") ? { needsClarification: false, questions: [], assumptions: [] } : { plan: proposed, changes: [{ path: `${path}.title`, explanation: "Names the intended reader outcome.", reason: "Clarify the benefit of preserving a reading position." }] }), provider: "fake", model: "test", usage }); } } });
  const app = express(); app.use(express.json()); app.use(createStoryAgentRoutes({ db: memory.db, logger, clock: { now: () => 0 }, repository, projects: createProjectRepository(memory.db), reviews: createIntelligenceRepository(memory.db), service, capacity: createStoryAgentCapacity({ maxConcurrentRuns: 10, maxRequestsPerWindow: 100, requestWindowMs: 60000, maxTrackedClients: 100, clock: { now: () => 0 } }) })); app.use(createErrorHandler({ logger }));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  try {
    await run({ memory, repository, request: async (path, method = "GET", body) => await fetch(`http://127.0.0.1:${String(address.port)}/story-agent/runs${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }) });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); }); }
};

void test("HTTP refinement review, reject, accept, history restore and stale decisions preserve originals", async () => {
  await withApi(async ({ request, repository }) => {
    await repository.updateRunStatus("one", "draft", { stories: flattenPlan(plan).map((story) => ({ ...story, states: ["ready"], dependsOn: ["Saved chapter"], openQuestions: ["Which retention period?"], sliceRationale: "Existing thin slice rationale." })) });
    const propose = () => request("/one/refinements", "POST", { artifactPath: "initiative", instructions: "Clarify the benefit in the title", version: 0 });
    const response = await propose(); assert.equal(response.status, 200);
    const payload = await response.json() as { proposal: { id: string }; version: number };
    assert.equal(payload.version, 1);
    assert.equal((await request("/one/refinements", "POST", { artifactPath: "initiative", instructions: "Again", version: 0 })).status, 409);
    const before = await (await request("/one")).json() as { run: { plan: typeof plan; refinements: unknown[] } };
    assert.deepEqual(before.run.plan, plan); assert.equal(before.run.refinements.length, 1);
    const decisionPath = `/one/refinements/${payload.proposal.id}/decision`;
    assert.equal((await request(decisionPath, "POST", { decision: "reject", version: 1 })).status, 200);
    assert.equal((await request(decisionPath, "POST", { decision: "accept", version: 1 })).status, 409);
    assert.deepEqual((await repository.getRun("one"))?.plan, plan);
    const second = await request("/one/refinements", "POST", { artifactPath: "initiative", instructions: "Clarify the benefit", version: 2 }); assert.equal(second.status, 200);
    const next = await second.json() as { proposal: { id: string } };
    assert.equal((await request(`/one/refinements/${next.proposal.id}/decision`, "POST", { decision: "accept", version: 3 })).status, 200);
    const after = await (await request("/one")).json() as { run: { plan: typeof plan; stories: { states: string[]; dependsOn: string[]; openQuestions: string[]; sliceRationale: string }[] }; draft: { plan: typeof plan } };
    assert.equal(after.run.plan.initiative.title, "Resume reading confidently"); assert.deepEqual(after.run.plan, after.draft.plan);
    const revisedStory = after.run.stories[0]; assert.ok(revisedStory);
    assert.deepEqual(revisedStory.states, ["ready"]); assert.deepEqual(revisedStory.dependsOn, ["Saved chapter"]); assert.deepEqual(revisedStory.openQuestions, ["Which retention period?"]); assert.equal(revisedStory.sliceRationale, "Existing thin slice rationale.");
    assert.deepEqual((await repository.getRun("one"))?.plan, plan); assert.deepEqual((await repository.getDraftByRun("one"))?.plan, plan);
    const list = await (await request("")).json() as { runs: { runId: string; plan: typeof plan }[] };
    assert.equal(list.runs.find((item) => item.runId === "one")?.plan.initiative.title, "Resume reading confidently");
    assert.equal(list.runs.find((item) => item.runId === "two")?.plan.initiative.title, plan.initiative.title);
  });
});

void test("HTTP deletion isolates records, returns missing/busy errors and propagates storage failures", async () => {
  await withApi(async ({ request, memory, repository }) => {
    memory.failures.deleteDraft = true;
    assert.equal((await request("/one", "DELETE")).status, 500); assert.ok(await repository.getRun("one"));
    memory.failures.deleteDraft = false;
    assert.equal((await request("/one", "DELETE")).status, 200);
    assert.equal((await request("/one", "DELETE")).status, 404); assert.equal((await request("/one")).status, 404);
    assert.equal((await request("/two")).status, 200); assert.ok(await repository.getDraftByRun("two"));
    await repository.updateRunStatus("two", "queued", { lockedUntil: "2099-01-01" });
    assert.equal((await request("/two", "DELETE")).status, 409);
  });
});

void test("HTTP rejects malformed refinement paths, invalid decisions and missing history safely", async () => {
  await withApi(async ({ request }) => {
    assert.equal((await request("/missing/refinements", "POST", { artifactPath: "initiative", instructions: "Clarify", version: 0 })).status, 404);
    for (const path of ["__proto__", "initiative.epics.999", "initiative.title"]) {
      assert.equal((await request("/one/refinements", "POST", { artifactPath: path, instructions: "Clarify", version: 0 })).status, 400);
    }
    assert.equal((await request("/one/refinements/missing/decision", "POST", { decision: "accept", version: 0 })).status, 404);
    assert.equal((await request("/one/refinements/missing/decision", "POST", { decision: "overwrite", version: 0 })).status, 400);
  });
});

void test("HTTP provider failures preserve the original and create no proposal", async () => {
  await withApi(async ({ request, repository }) => {
    const response = await request("/one/refinements", "POST", { artifactPath: "initiative", instructions: "Clarify benefit", version: 0 });
    assert.equal(response.status, 503);
    const saved = await repository.getRun("one");
    assert.ok(saved); assert.deepEqual(saved.plan, plan); assert.equal(saved.refinements, undefined);
    assert.equal((await request("/two")).status, 200);
  }, true);
});

void test("HTTP concurrent proposals cannot overwrite each other", async () => {
  await withApi(async ({ request, repository }) => {
    const responses = await Promise.all([0, 1].map(() => request("/one/refinements", "POST", { artifactPath: "initiative", instructions: "Clarify benefit", version: 0 })));
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    assert.equal((await repository.getRun("one"))?.refinements?.length, 1);
  });
});

void test("HTTP generation admits after failed deletion markers but retains real queue limits", async () => {
  await withApi(async ({ request, memory, repository }) => {
    const base = await repository.getRun("one"); assert.ok(base);
    memory.failures.deleteDraft = true;
    for (let index = 0; index < 20; index += 1) {
      const runId = `pending-${String(index)}`;
      await repository.saveRun({ ...base, runId, status: "queued", lockedUntil: null, nextAttemptAt: "2026-01-01" });
      assert.equal((await request(`/${runId}`, "DELETE")).status, 500);
    }
    memory.failures.deleteDraft = false;
    assert.equal(await repository.countQueuedRuns(), 0);
    assert.equal((await request("", "POST", { requirement: "Readers resume a chapter" })).status, 200);
    for (let index = 0; index < 20; index += 1) await repository.saveRun({ ...base, runId: `real-${String(index)}`, status: "queued", lockedUntil: index === 0 ? "2099-01-01" : null });
    assert.equal(await repository.countQueuedRuns(), 20);
    assert.equal((await request("", "POST", { requirement: "Readers resume a chapter" })).status, 503);
  });
});

void test("HTTP title and later subtree refinements preserve context through accept, restore and history", async () => {
  await withApi(async ({ request, repository }) => {
    await repository.updateRunStatus("one", "draft", { stories: flattenPlan(plan).map((story) => ({ ...story, states: ["ready"], dependsOn: ["Saved chapter"], openQuestions: ["Retention period?"], sliceRationale: "Original context" })) });
    const path = "initiative.epics.0.features.0.stories.0";
    for (const [artifactPath, version] of [[path, 0], ["initiative.epics.0.features.0", 2]] as const) {
      const result = await request("/one/refinements", "POST", { artifactPath, instructions: "Clarify title", version }); assert.equal(result.status, 200);
      const proposal = await result.json() as { proposal: { id: string; original: typeof plan; proposed: typeof plan } };
      const before = proposal.proposal.original.initiative.epics[0]?.features[0]?.stories[0]?.metadata;
      assert.deepEqual(before?.states, ["ready"]);
      assert.deepEqual(proposal.proposal.proposed.initiative.epics[0]?.features[0]?.stories[0]?.metadata, before);
      assert.equal((await request(`/one/refinements/${proposal.proposal.id}/decision`, "POST", { decision: "accept", version: version + 1 })).status, 200);
    }
    const restored = await (await request("/one")).json() as { run: { stories: { title: string; states: string[]; dependsOn: string[]; openQuestions: string[]; sliceRationale: string }[] } };
    const story = restored.run.stories[0]; assert.ok(story);
    assert.match(story.title, /clarified$/); assert.deepEqual(story.states, ["ready"]); assert.deepEqual(story.dependsOn, ["Saved chapter"]); assert.deepEqual(story.openQuestions, ["Retention period?"]); assert.equal(story.sliceRationale, "Original context");
    assert.equal((await repository.getRun("one"))?.refinements?.filter((item) => item.status === "accepted").length, 2);
    assert.equal((await repository.getRun("two"))?.refinements, undefined);
  });
});

void test("HTTP rejects ambiguous legacy context mapping before invoking refinement", async () => {
  await withApi(async ({ request, repository }) => {
    const run = await repository.getRun("one"); assert.ok(run?.stories);
    await repository.updateRunStatus("one", "draft", { stories: run.stories.map((story) => ({ ...story, title: "Unlinked legacy title" })) });
    const result = await request("/one/refinements", "POST", { artifactPath: "initiative", instructions: "Clarify title", version: 0 });
    assert.equal(result.status, 409);
    assert.match(JSON.stringify(await result.json()), /unambiguously|Original content/);
    assert.equal((await repository.getRun("one"))?.refinements, undefined);
  });
});

void test("HTTP old proposals without identity can be rejected but cannot silently drop context on acceptance", async () => {
  await withApi(async ({ request, repository }) => {
    await repository.saveRefinements("one", 0, [{ id: "old", artifactPath: "initiative", status: "pending", original: plan, proposed: plan, changes: [], quality: { status: "passed", checks: [] }, createdAt: "now" }], "now");
    assert.equal((await request("/one/refinements/old/decision", "POST", { decision: "accept", version: 1 })).status, 409);
    assert.equal((await request("/one/refinements/old/decision", "POST", { decision: "reject", version: 1 })).status, 200);
    assert.deepEqual((await repository.getRun("one"))?.plan, plan);
  });
});

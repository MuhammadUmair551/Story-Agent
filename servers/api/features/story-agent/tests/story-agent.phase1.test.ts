import test from "node:test";
import assert from "node:assert/strict";
import { createStoryAgentService, flattenPlan, validatePlan, validateStories } from "../story-agent.service.js";
import { explainQuality, planArtifacts } from "../story-agent.quality.js";
import { activePlan, artifactValue, refinementChanges } from "../story-agent.refinement.js";
import { createStoryAgentRepository } from "../story-agent.repository.js";
import { createMemoryPersistence } from "./story-agent.memory.js";

import { withStoryContext } from "../story-agent.metadata.js";
import { plan } from "./story-agent.fixture.js";

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const budget = { maxCalls: 6, maxTotalTokens: 1000, timeoutMs: 10000, contextTokenLimit: 6000, maxStories: 10 };
const document = (runId: string) => ({ runId, plan, stories: flattenPlan(plan), status: "draft" as const, requirement: "Readers resume or clear a saved chapter", usage, providers: [], attempts: 2, stages: [], validationErrors: [], createdAt: "2026-11-08T00:00:00.000Z", updatedAt: "2026-11-08T00:00:00.000Z" });

void test("quality preserves existing blocking validation and supplies actionable hierarchy-aware feedback", () => {
  const errors = validatePlan(plan, [], 10);
  assert.deepEqual(errors, []);
  const report = explainQuality(plan, errors);
  assert.equal(report.status, "passed");
  assert.equal(new Set(report.checks.map((check) => check.level)).size, 5);
  assert.ok(report.checks.every((check) => check.issue && check.reason && check.impact && check.suggestedFix));
  assert.ok(report.checks.some((check) => check.level === "story" && check.dimension === "ambiguity" && check.status === "warning"));
  assert.ok(report.checks.every((check) => check.level !== "initiative" || check.dimension !== "independence"));
  assert.ok(report.checks.every((check) => check.dimension !== "requirement_coverage" || check.status === "needs_review"));
  const duplicate = [...flattenPlan(plan), ...flattenPlan(plan)];
  assert.match(validateStories(duplicate, [], 10).join(" "), /Duplicate generated title/);
  assert.match(validatePlan(plan, ["A reader resumes a chapter"], 10).join(" "), /Duplicate existing title/);
  assert.match(validatePlan(plan, [], 1).join(" "), /At most 1 stories/);
  assert.equal(explainQuality(undefined, ["At most 1 stories are allowed."]).checks[0]?.status, "failed");
});

void test("refines each hierarchy level through the existing pipeline and preserves all unselected artifacts", async () => {
  const original = withStoryContext("test", plan, flattenPlan(plan));
  for (const artifact of planArtifacts(original)) {
    const candidate = structuredClone(original);
    const target = artifactValue(candidate, artifact.path) as Record<string, unknown>;
    target.title = `${artifact.title} clarified`;
    // Deliberately change an unrelated field; server projection must preserve it.
    if (artifact.path !== "initiative") (candidate.initiative as { outcome: string }).outcome = "Unrelated provider edit";
    let calls = 0;
    const service = createStoryAgentService({ now: () => 0, budget, route: { complete: (input) => {
      calls += 1; assert.match(input.messages[0]?.content ?? "", /refinement-data/);
      assert.match(input.messages[0]?.content ?? "", /quality-findings-data/);
      return Promise.resolve({ text: JSON.stringify({ plan: candidate, changes: [{ path: `${artifact.path}.title`, explanation: "Clarified the artifact title.", reason: "Resolve ambiguity by naming the outcome explicitly." }] }), provider: "fake", model: "test", usage });
    } } });
    const result = await service.run({ requirement: "Readers resume or clear a saved chapter", refinement: { original, artifactPath: artifact.path, instructions: "Clarify the title" } });
    assert.equal(result.status, "draft"); assert.equal(calls, 1);
    assert.equal(artifactValue(result.plan, `${artifact.path}.title`), `${artifact.title} clarified`);
    assert.equal(result.plan?.initiative.outcome, plan.initiative.outcome);
    assert.deepEqual(result.refinementChanges?.map((change) => change.path), [`${artifact.path}.title`]);
    assert.equal(plan.initiative.title, "Reader continuity");
  }
});

void test("refinement repairs missing explanations and never returns an unexplained draft", async () => {
  let calls = 0;
  const original = withStoryContext("test", plan, flattenPlan(plan));
  const candidate = { initiative: { ...original.initiative, title: "Changed title" } };
  const service = createStoryAgentService({ now: () => 0, budget, route: { complete: () => {
    calls += 1;
    return Promise.resolve({ text: JSON.stringify({ plan: candidate }), provider: "fake", model: "test", usage });
  } } });
  const result = await service.run({ requirement: "Readers resume their chapter", refinement: { original, artifactPath: "initiative", instructions: "Clarify the title" } });
  assert.equal(calls, 3); assert.equal(result.status, "failed"); assert.equal(result.plan, undefined);
  assert.match(result.validationErrors.join(" "), /explain every changed field/);
});

void test("individual deletion removes only its owned draft/run and handles a missing entry", async () => {
  const { db } = createMemoryPersistence(); const repository = createStoryAgentRepository(db);
  for (const id of ["one", "two"]) { await repository.saveRun(document(id)); await repository.saveDraft({ runId: id, stories: flattenPlan(plan), plan, createdAt: "now" }); }
  assert.equal(await repository.deleteRun("one", "2026-11-08T00:00:00.000Z"), "deleted");
  assert.equal(await repository.getRun("one"), null); assert.equal(await repository.getDraftByRun("one"), null);
  assert.ok(await repository.getRun("two")); assert.ok(await repository.getDraftByRun("two"));
  assert.equal(await repository.deleteRun("one", "now"), "missing");
});

void test("failed deletion remains retryable and queued/leased work cannot recreate deleted artifacts", async () => {
  const memory = createMemoryPersistence(); const repository = createStoryAgentRepository(memory.db);
  await repository.saveRun({ ...document("one"), status: "queued", nextAttemptAt: "2026-01-01", lockedUntil: null });
  await repository.saveDraft({ runId: "one", stories: [], createdAt: "now" });
  memory.failures.deleteDraft = true;
  await assert.rejects(repository.deleteRun("one", "2026-11-08"), /Storage unavailable/);
  assert.ok((await repository.getRun("one"))?.deletingAt);
  assert.equal(await repository.claimQueuedRun("2026-11-09", "2026-11-10"), null);
  memory.failures.deleteDraft = false;
  assert.equal(await repository.deleteRun("one", "2026-11-09"), "deleted");
  await repository.saveRun({ ...document("busy"), status: "queued", lockedUntil: "2026-11-10" });
  assert.equal(await repository.deleteRun("busy", "2026-11-09"), "busy");
  assert.ok(await repository.getRun("busy"));
});

void test("revision decisions use optimistic versions, retain originals and never activate rejected proposals", async () => {
  const { db } = createMemoryPersistence(); const repository = createStoryAgentRepository(db);
  await repository.saveRun(document("one"));
  const proposed = { initiative: { ...plan.initiative, title: "Improved continuity" } };
  const proposal = { id: "proposal", artifactPath: "initiative", original: plan, proposed, status: "pending" as const, changes: refinementChanges(plan, proposed, "initiative"), quality: explainQuality(proposed, []), createdAt: "now" };
  assert.equal(await repository.saveRefinements("one", 0, [proposal], "now"), true);
  assert.equal(await repository.saveRefinements("one", 0, [proposal], "now"), false);
  assert.deepEqual(activePlan((await repository.getRun("one")) ?? {}), plan);
  assert.equal(await repository.saveRefinements("one", 1, [{ ...proposal, status: "rejected" }], "later"), true);
  assert.deepEqual(activePlan((await repository.getRun("one")) ?? {}), plan);
  assert.equal(await repository.saveRefinements("one", 2, [{ ...proposal, status: "accepted" }], "later"), true);
  const saved = await repository.getRun("one"); assert.ok(saved);
  assert.deepEqual(activePlan(saved), proposed); assert.deepEqual(saved.plan, plan); assert.deepEqual(saved.refinements?.[0]?.original, plan);
});

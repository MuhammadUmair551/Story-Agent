import test from "node:test";
import assert from "node:assert/strict";
import type { StoryAgentAnalysis, StoryAgentPlan } from "@workspace/types";
import { intelligencePrompt, titleMatchFindings, validateIntelligence, type IntelligenceInput } from "../story-agent.intelligence.js";
import { createStoryAgentService, flattenPlan } from "../story-agent.service.js";
import { planArtifacts } from "../story-agent.quality.js";
import { artifactValue } from "../story-agent.refinement.js";
import { withStoryContext } from "../story-agent.metadata.js";
import { withStoryApi } from "./story-agent.http-fixture.js";
import { plan } from "./story-agent.fixture.js";

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const budget = { maxCalls: 6, maxTotalTokens: 1000, timeoutMs: 10000, contextTokenLimit: 6000, maxStories: 10 };
const originalRequirement = "Readers resume and clear a saved chapter.";
const updatedRequirement = "Readers resume and clear a saved chapter offline; previously saved progress must remain available.";
const storyPath = "initiative.epics.0.features.0.stories.0";
const input: IntelligenceInput = { runId: "one", requirement: originalRequirement, plan, backlog: [{ runId: "two", requirement: "Continue the last chapter", plan: { initiative: { ...plan.initiative, title: "Other wording" } } }] };
const rawFinding = (artifactPath = storyPath) => ({ kind: "duplicate_behavior", artifactPath, reason: "Both entries resume the same saved chapter despite their different initiative names.", suggestedUpdate: "Clarify the distinct reader outcome or propose merging the repeated resume responsibility.", evidence: [{ runId: "one", artifactPath, quote: "Continue reading" }, { runId: "two", artifactPath: storyPath, quote: "Continue reading" }], dependencies: [{ runId: "two", artifactPath: storyPath }] });

void test("semantic review accepts supported behavioral duplicates and affected dependency evidence", () => {
  const findings = validateIntelligence({ findings: [rawFinding()] }, input);
  const finding = findings[0]; assert.ok(finding); assert.equal(finding.method, "semantic_review"); assert.equal(finding.dependencies[0]?.runId, "two");
  assert.ok(titleMatchFindings(input).every((finding) => finding.method === "title_match" && /does not prove/.test(finding.reason)));
});

void test("semantic output rejects invented paths, unsupported quotes, dependencies and duplicate findings", () => {
  const finding = rawFinding();
  for (const item of [{ ...finding, artifactPath: "initiative.epics.99" }, { ...finding, evidence: [{ runId: "one", artifactPath: storyPath, quote: "Invented behavior" }] }, { ...finding, dependencies: [{ runId: "missing", artifactPath: storyPath }] }, { ...finding, evidence: [{ runId: "two", artifactPath: storyPath, quote: "Continue reading" }] }]) assert.throws(() => validateIntelligence({ findings: [item] }, input));
  assert.throws(() => validateIntelligence({ findings: [finding, finding] }, input), /repeated/);
  assert.throws(() => intelligencePrompt(input, 1), /context budget/);
});

void test("dependency evidence may quote retained story metadata, not only display titles", () => {
  const contextual = withStoryContext("one", plan, flattenPlan(plan).map((story) => ({ ...story, dependsOn: ["Saved chapter synchronization"] })));
  const finding = { ...rawFinding(), kind: "affected", evidence: [{ runId: "one", artifactPath: storyPath, quote: "Saved chapter synchronization" }, { runId: "two", artifactPath: storyPath, quote: "Continue reading" }] };
  assert.equal(validateIntelligence({ findings: [finding] }, { ...input, plan: contextual })[0]?.kind, "affected");
});

void test("analysis reuses bounded provider calls and fails closed for invalid output and budgets", async () => {
  let calls = 0;
  const invalid = createStoryAgentService({ budget, now: () => 0, route: { complete: () => { calls += 1; return Promise.resolve({ text: JSON.stringify({ findings: [{ ...rawFinding(), evidence: [] }] }), provider: "fake", model: "test", usage }); } } });
  const result = await invalid.analyze(input); assert.equal(result.status, "failed"); assert.equal(calls, 2);
  const overBudget = createStoryAgentService({ budget: { ...budget, maxTotalTokens: 1 }, now: () => 0, route: { complete: () => Promise.resolve({ text: JSON.stringify({ findings: [] }), provider: "fake", model: "test", usage }) } });
  assert.deepEqual(await overBudget.analyze(input), { status: "failed", reason: "over_budget" });
  assert.deepEqual(await invalid.analyze({ ...input, requirement: "x".repeat(25000) }), { status: "failed", reason: "context_limit" }); assert.equal(calls, 2);
});

void test("analysis correction instructions also count toward the complete prompt limit", async () => {
  const service = (sent: string[], contextCharacters = 24000) => createStoryAgentService({ budget: { ...budget, maxPromptCharacters: contextCharacters }, now: () => 0, route: { complete: (request) => {
    sent.push(request.messages[0]?.content ?? ""); return Promise.resolve({ provider: "fake", model: "test", usage, text: sent.length === 1 ? "invalid JSON" : JSON.stringify({ findings: [] }) });
  } } });
  const baseline: string[] = []; assert.equal((await service(baseline).analyze(input)).status, "completed");
  const corrected = baseline[1]; assert.ok(corrected);
  const sent: string[] = []; assert.deepEqual(await service(sent, corrected.length - 1).analyze(input), { status: "failed", reason: "context_limit" }); assert.equal(sent.length, 1);
  const boundary: string[] = []; assert.equal((await service(boundary, corrected.length).analyze(input)).status, "completed"); assert.equal(boundary[1]?.length, corrected.length);
});

const providerState = () => ({ calls: 0, fail: false, invalid: false, duringAnalysis: undefined as (() => Promise<void>) | undefined });
const serviceFor = (state: ReturnType<typeof providerState>) => createStoryAgentService({ budget, now: () => 0, route: { complete: async (request) => {
  const prompt = request.messages[0]?.content ?? "";
  if (prompt.includes("<intelligence-data>")) {
    state.calls += 1;
    if (state.fail) throw new Error("Provider unavailable");
    const json: unknown = JSON.parse(prompt.match(/<intelligence-data>(.*?)<\/intelligence-data>/s)?.[1] ?? "null");
    assert.ok(typeof json === "object" && json !== null && "plan" in json && "runId" in json);
    const data = json as IntelligenceInput;
    await state.duringAnalysis?.();
    const paths = ["initiative", "initiative.epics.0", "initiative.epics.0.features.0", storyPath, `${storyPath}.tasks.0`];
    const kinds = ["affected", "stale", "incomplete", "contradiction", "terminology"];
    const findings = data.updatedRequirement ? paths.map((artifactPath, index) => ({ kind: kinds[index], artifactPath, reason: `The offline requirement affects this ${planArtifacts(data.plan).find((artifact) => artifact.path === artifactPath)?.level ?? "artifact"}; review persisted progress and dependencies.`, suggestedUpdate: "Clarify how the selected artifact preserves saved progress while offline.", evidence: [{ runId: data.runId, artifactPath, quote: data.updatedRequirement }], dependencies: [] })) : [{ ...rawFinding(), evidence: [{ runId: data.runId, artifactPath: storyPath, quote: "Continue reading" }, ...data.backlog.map((run) => ({ runId: run.runId, artifactPath: storyPath, quote: "Continue reading" }))], dependencies: data.backlog.map((run) => ({ runId: run.runId, artifactPath: storyPath })) }];
    return { text: JSON.stringify({ findings: state.invalid ? [{ ...rawFinding(), artifactPath: "initiative.epics.99" }] : findings }), provider: "fake", model: "test", usage };
  }
  const json: unknown = JSON.parse(prompt.match(/<refinement-data>(.*?)<\/refinement-data>/s)?.[1] ?? "null");
  assert.ok(typeof json === "object" && json !== null && "original" in json && "artifactPath" in json);
  const data = json as { original: StoryAgentPlan; artifactPath: string };
  const proposed = structuredClone(data.original); const target = artifactValue(proposed, data.artifactPath);
  assert.ok(typeof target === "object" && target !== null && "title" in target && typeof target.title === "string"); target.title += " offline";
  return { text: JSON.stringify({ plan: proposed, changes: [{ path: `${data.artifactPath}.title`, explanation: "Clarifies offline behavior for the selected artifact.", reason: "Apply the reviewed requirement change." }] }), provider: "fake", model: "test", usage };
} } });

type ApiInput = Parameters<Parameters<typeof withStoryApi>[1]>[0];
const seed = async (repository: ApiInput["repository"]): Promise<void> => {
  for (const [runId, projectId] of [["one", "reading"], ["two", "reading"], ["three", "unrelated"]] as const) {
    await repository.saveRun({ runId, projectId, requirement: originalRequirement, plan, stories: flattenPlan(plan), status: "draft", usage, attempts: 1, providers: [], stages: [], validationErrors: [], createdAt: "now", updatedAt: "now" });
    await repository.saveDraft({ runId, plan, stories: flattenPlan(plan), createdAt: "now" });
  }
};

void test("HTTP backlog review scopes the project, preserves plans and stores exact comparison evidence", async () => {
  const state = providerState();
  await withStoryApi(serviceFor(state), async ({ request, repository }) => {
    await seed(repository);
    const response = await request("/runs/one/analyses", "POST", { kind: "backlog", version: 0 }); assert.equal(response.status, 200);
    const { analysis } = await response.json() as { analysis: StoryAgentAnalysis };
    assert.deepEqual(analysis.compared.map((run) => run.runId), ["two"]); assert.ok(analysis.findings.some((finding) => finding.kind === "duplicate_behavior" && finding.method === "semantic_review"));
    assert.deepEqual((await repository.getRun("one"))?.plan, plan); assert.equal((await repository.getRun("two"))?.analyses, undefined); assert.equal((await repository.getRun("three"))?.analyses, undefined);
    assert.equal((await request("/runs/one/analyses", "POST", { kind: "backlog", version: 0 })).status, 409);
  });
});

void test("HTTP impact covers every hierarchy level, requires decisions and restores accepted requirement history", async () => {
  const state = providerState();
  await withStoryApi(serviceFor(state), async ({ request, repository }) => {
    await seed(repository);
    let version = 0;
    for (const decision of ["reject", "accept"] as const) {
      const response = await request("/runs/one/analyses", "POST", { kind: "impact", updatedRequirement, version }); assert.equal(response.status, 200);
      const { analysis } = await response.json() as { analysis: StoryAgentAnalysis }; version += 1;
      assert.equal(new Set(analysis.findings.map((finding) => planArtifacts(plan).find((artifact) => artifact.path === finding.artifactPath)?.level)).size, 5);
      const finding = analysis.findings.find((finding) => finding.artifactPath === storyPath); assert.ok(finding);
      const proposed = await request("/runs/one/refinements", "POST", { artifactPath: storyPath, instructions: finding.suggestedUpdate, analysisId: analysis.id, findingId: finding.id, version }); assert.equal(proposed.status, 200); version += 1;
      const { proposal } = await proposed.json() as { proposal: { id: string; requirementChange: { original: string; proposed: string } } };
      assert.deepEqual(proposal.requirementChange, { original: originalRequirement, proposed: updatedRequirement });
      const before = await (await request("/runs/one")).json() as { run: { requirement: string; plan: StoryAgentPlan } }; assert.equal(before.run.requirement, originalRequirement); assert.deepEqual(before.run.plan, plan);
      assert.equal((await request(`/runs/one/refinements/${proposal.id}/decision`, "POST", { decision, version })).status, 200); version += 1;
      const after = await (await request("/runs/one")).json() as { run: { requirement: string; plan: StoryAgentPlan } };
      assert.equal(after.run.requirement, decision === "accept" ? updatedRequirement : originalRequirement);
      if (decision === "accept") { assert.equal(after.run.plan.initiative.title, plan.initiative.title); assert.match(after.run.plan.initiative.epics[0]?.features[0]?.stories[0]?.title ?? "", /offline$/); assert.deepEqual(after.run.plan.initiative.epics[0]?.features[0]?.stories[1]?.title, plan.initiative.epics[0]?.features[0]?.stories[1]?.title); }
      assert.equal((await request(`/runs/one/refinements/${proposal.id}/decision`, "POST", { decision, version: version - 1 })).status, 409);
    }
    const stored = await repository.getRun("one"); assert.ok(stored); assert.equal(stored.requirement, originalRequirement); assert.deepEqual(stored.plan, plan); assert.deepEqual((await repository.getDraftByRun("one"))?.plan, plan);
    assert.equal(stored.analyses?.length, 2); assert.equal(stored.refinements?.length, 2);
    const list = await (await request("/runs")).json() as { runs: { runId: string; requirement: string; analyses?: unknown }[] }; assert.equal(list.runs.find((run) => run.runId === "one")?.requirement, updatedRequirement); assert.equal(list.runs.find((run) => run.runId === "one")?.analyses, undefined);
    assert.equal((await request("/runs/one", "DELETE")).status, 200); assert.equal(await repository.getRun("one"), null); assert.ok(await repository.getRun("two")); assert.ok(await repository.getDraftByRun("two"));
  });
});

void test("HTTP evidence changes block stale proposal acceptance and rejection remains available", async () => {
  const state = providerState();
  await withStoryApi(serviceFor(state), async ({ request, repository }) => {
    await seed(repository);
    const response = await request("/runs/one/analyses", "POST", { kind: "backlog", version: 0 });
    const { analysis } = await response.json() as { analysis: StoryAgentAnalysis }; const finding = analysis.findings[0]; assert.ok(finding);
    const proposed = await request("/runs/one/refinements", "POST", { artifactPath: finding.artifactPath, instructions: finding.suggestedUpdate, analysisId: analysis.id, findingId: finding.id, version: 1 }); assert.equal(proposed.status, 200);
    const { proposal } = await proposed.json() as { proposal: { id: string } };
    await repository.updateRunStatus("two", "draft", { refinementVersion: 1 });
    assert.equal((await request(`/runs/one/refinements/${proposal.id}/decision`, "POST", { decision: "accept", version: 2 })).status, 409);
    assert.equal((await request(`/runs/one/refinements/${proposal.id}/decision`, "POST", { decision: "reject", version: 2 })).status, 200);
    assert.deepEqual((await repository.getRun("one"))?.plan, plan);
  });
});

void test("HTTP provider failures and changing comparison sources never save partial analysis", async () => {
  for (const mode of ["fail", "invalid", "changed"] as const) {
    const state = providerState(); state.fail = mode === "fail"; state.invalid = mode === "invalid";
    await withStoryApi(serviceFor(state), async ({ request, repository }) => {
      await seed(repository);
      if (mode === "changed") state.duringAnalysis = async () => { await repository.updateRunStatus("two", "draft", { refinementVersion: 1 }); };
      assert.equal((await request("/runs/one/analyses", "POST", { kind: "backlog", version: 0 })).status, mode === "changed" ? 409 : 503);
      assert.equal((await repository.getRun("one"))?.analyses, undefined); assert.deepEqual((await repository.getRun("one"))?.plan, plan);
    });
  }
});

void test("HTTP comparison selection, context limits and legacy unscoped history are explicit", async () => {
  const state = providerState();
  await withStoryApi(serviceFor(state), async ({ request, repository }) => {
    await seed(repository);
    for (const body of [{ kind: "impact", version: 0 }, { kind: "impact", updatedRequirement: originalRequirement, version: 0 }, { kind: "backlog", compareRunIds: ["three"], version: 0 }, { kind: "backlog", compareRunIds: ["missing"], version: 0 }]) assert.equal((await request("/runs/one/analyses", "POST", body)).status, 400);
    assert.equal(state.calls, 0);
    const base = await repository.getRun("one"); assert.ok(base);
    for (let i = 0; i < 26; i += 1) await repository.saveRun({ ...base, runId: `extra-${String(i)}` });
    assert.equal((await request("/runs/one/analyses", "POST", { kind: "backlog", version: 0 })).status, 400);
    await repository.updateRunStatus("one", "draft", { projectId: undefined });
    const response = await request("/runs/one/analyses", "POST", { kind: "backlog", version: 0 }); assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { analysis: StoryAgentAnalysis }).analysis.compared, []);
  });
});

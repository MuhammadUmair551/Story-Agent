import test from "node:test";
import assert from "node:assert/strict";
import type { StoryAgentAnalysis, StoryAgentPlan } from "@workspace/types";
import { evidenceCatalog, evidencePrompt, exactTitleFindings, retainFindingDecisions, validateEvidence } from "../story-agent.evidence.js";
import type { IntelligenceInput } from "../story-agent.intelligence.js";
import { createStoryAgentService, flattenPlan } from "../story-agent.service.js";
import { artifactValue } from "../story-agent.refinement.js";
import { plan } from "./story-agent.fixture.js";
import { withStoryApi } from "./story-agent.http-fixture.js";
import { createIntelligenceRepository } from "../story-agent.intelligence.repository.js";

const levels = [
  ["initiative", "outcome"], ["initiative.epics.0", "objective"], ["initiative.epics.0.features.0", "outcome"],
  ["initiative.epics.0.features.0.stories.0", "intent"], ["initiative.epics.0.features.0.stories.0.tasks.0", "description"]
] as const;
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const budget = { maxCalls: 6, maxTotalTokens: 12000, timeoutMs: 60000, contextTokenLimit: 6000, maxStories: 10 };
const replace = (original: StoryAgentPlan, path: string, fields: Readonly<Record<string, string>>): StoryAgentPlan => {
  const result = structuredClone(original); const value = artifactValue(result, path);
  assert.ok(typeof value === "object" && value !== null); Object.assign(value, fields); return result;
};
const inputFor = (other = plan): IntelligenceInput => ({ runId: "one", requirement: "Readers resume saved chapters", plan, backlog: [{ runId: "two", requirement: "Readers resume saved chapters", plan: other }], evidenceVersion: 2 });
const output = (input: IntelligenceInput, findings: readonly unknown[] = []) => ({ findings, reviewedArtifacts: evidenceCatalog(input).map((item) => ({ runId: item.reference.runId, artifactPath: item.reference.artifactPath })), truncated: false });
const pair = (input: IntelligenceInput, path: string, field: string, kind: "duplicate_behavior" | "contradiction" | "terminology" = "duplicate_behavior") => {
  const quote = (runId: string) => evidenceCatalog(input).find((item) => item.reference.runId === runId && item.reference.artifactPath === path)?.fields[`${path}.${field}`];
  return { kind, artifactPath: path, reason: kind === "contradiction" ? "The same reader and condition require opposing persistence outcomes." : kind === "terminology" ? "These fields name the same role differently without an approved alias." : "Both fields describe the same reader outcome despite different wording.", suggestedUpdate: "Clarify the selected responsibility through an explicit refinement.", evidence: ["one", "two"].map((runId) => ({ runId, artifactPath: path, fieldPath: `${path}.${field}`, quote: quote(runId) })), dependencies: [] };
};
const service = (respond: (prompt: string) => unknown) => createStoryAgentService({ budget, now: () => 0, route: { complete: (request) => Promise.resolve({ text: JSON.stringify(respond(request.messages[0]?.content ?? "")), provider: "fake", model: "test", usage }) } });

for (const [path, field] of levels) {
  void test(`evidence-backed semantic duplicates, contradictions and terminology at ${path}`, async () => {
    for (const kind of ["duplicate_behavior", "contradiction", "terminology"] as const) {
      const sourceText = kind === "contradiction" ? "A reader must retain progress when closing a chapter." : "A reader resumes a saved chapter.";
      const otherText = kind === "contradiction" ? "A reader must discard progress when closing a chapter." : kind === "terminology" ? "A subscriber resumes a saved chapter." : "Continue the reader's chapter at its saved position.";
      const input = { ...inputFor(replace(plan, path, { [field]: otherText, title: "Different wording" })), plan: replace(plan, path, { [field]: sourceText }) };
      const result = await service((prompt) => { assert.match(prompt, /actor, action, object, outcome, preconditions, negation, numeric constraints/); return output(input, [pair(input, path, field, kind)]); }).analyze(input);
      assert.equal(result.status, "completed");
      const finding = result.findings.find((item) => item.kind === kind && item.artifactPath === path && item.method === "semantic_review"); assert.ok(finding);
      assert.equal(finding.counterparts?.[0]?.runId, "two"); assert.ok(finding.counterparts[0].breadcrumb?.length);
      for (const item of finding.evidence) { assert.equal(item.fieldValue?.slice(item.start, item.end), item.quote); assert.equal(item.fieldPath, `${path}.${field}`); }
      assert.equal(result.coverage?.status, "complete");
    }
  });
  void test(`legitimate repeated names, actors, conditions and approved aliases at ${path}`, async () => {
    const numericConditions = { ...inputFor(replace(plan, path, { [field]: "Retain progress <= 10 days." })), plan: replace(plan, path, { [field]: "Retain progress >= 10 days." }) };
    assert.ok(!exactTitleFindings(numericConditions).some((finding) => finding.artifactPath === path));
    for (const text of ["An administrator resumes another reader's chapter.", "A reader resumes only after online synchronization.", "A Bookworm resumes a saved chapter."]) {
      const input = { ...inputFor(replace(plan, path, { [field]: text })), projectRules: { glossary: [{ term: "Reader", definition: "A person reading a chapter", aliases: ["Bookworm"] }], roles: [], naming: [], rules: [], acceptanceCriteria: { format: "checklist" as const, instructions: "", examples: [] } } };
      assert.ok(!exactTitleFindings(input).some((finding) => finding.artifactPath === path));
      const result = await service((prompt) => { assert.match(prompt, /Approved glossary aliases are valid/); return output(input); }).analyze(input);
      assert.equal(result.status, "completed"); assert.ok(!result.findings.some((item) => item.artifactPath === path));
    }
  });
}

void test("glossary evidence binds the saved definition and rejects fabricated or descendant fields", () => {
  const path = levels[3][0];
  const input = { ...inputFor(), projectRules: { glossary: [{ term: "Reader", definition: "A person reading a chapter", aliases: [] }], roles: [], naming: [], rules: [], acceptanceCriteria: { format: "checklist" as const, instructions: "", examples: [] } } };
  const raw = { ...pair(input, path, "intent", "terminology"), evidence: [{ runId: "one", artifactPath: path, fieldPath: `${path}.intent`, quote: "Continue reading" }, { runId: "one", artifactPath: path, fieldPath: "projectRules.glossary.0.definition", quote: "A person reading a chapter" }] };
  assert.equal(validateEvidence(output(input, [raw]), input).findings[0]?.kind, "terminology");
  for (const evidence of [[{ ...raw.evidence[0], fieldPath: "initiative.title" }, raw.evidence[1]], [raw.evidence[0], { ...raw.evidence[1], quote: "An invented definition" }]]) assert.throws(() => validateEvidence(output(input, [{ ...raw, evidence }]), input));
  const parent = { ...pair(input, "initiative", "outcome"), evidence: [{ runId: "one", artifactPath: "initiative", fieldPath: `${path}.intent`, quote: "Continue reading" }, { runId: "two", artifactPath: "initiative", fieldPath: "initiative.outcome", quote: plan.initiative.outcome }] };
  assert.throws(() => validateEvidence(output(input, [parent]), input), /owned field/);
  assert.throws(() => validateEvidence(output(input, [{ ...raw, kind: "contradiction" }]), input), /counterpart/);
});

void test("same-entry reversed pairs collapse and parent-child contradictions retain both breadcrumbs", () => {
  const first = levels[3][0], second = "initiative.epics.0.features.0.stories.1";
  const input = { ...inputFor(), backlog: [] };
  const findings = [first, second].map((path, index) => ({ kind: "duplicate_behavior", artifactPath: path, reason: "These reader outcomes overlap.", suggestedUpdate: "Clarify their responsibilities.", evidence: [path, index ? first : second].map((artifactPath) => ({ runId: "one", artifactPath, fieldPath: `${artifactPath}.intent`, quote: String(artifactValue(input.plan, `${artifactPath}.intent`)) })), dependencies: [] }));
  assert.equal(validateEvidence(output(input, findings), input).findings.length, 1);
  const contradiction = { ...findings[0], kind: "contradiction", artifactPath: first, evidence: [{ runId: "one", artifactPath: first, fieldPath: `${first}.intent`, quote: String(artifactValue(plan, `${first}.intent`)) }, { runId: "one", artifactPath: "initiative", fieldPath: "initiative.outcome", quote: plan.initiative.outcome }] };
  const finding = validateEvidence(output(input, [contradiction]), input).findings[0];
  assert.equal(finding?.counterparts?.[0]?.level, "initiative");
  assert.throws(() => validateEvidence(output(input, [{ ...contradiction, kind: "duplicate_behavior" }]), input), /same hierarchy level/);
});

void test("partial coverage, finding limits, unknown references and provider failure are explicit", async () => {
  const input = inputFor(); const value = output(input);
  const partial = validateEvidence({ ...value, reviewedArtifacts: value.reviewedArtifacts.slice(1), truncated: true }, input);
  assert.equal(partial.coverage.status, "partial"); assert.equal(partial.coverage.excluded.length, 1);
  assert.throws(() => validateEvidence({ ...value, reviewedArtifacts: [...value.reviewedArtifacts, { runId: "other-project", artifactPath: "initiative" }] }, input), /unknown/);
  assert.throws(() => validateEvidence({ ...value, reviewedArtifacts: [...value.reviewedArtifacts, value.reviewedArtifacts[0]] }, input), /duplicate/);
  const limited = validateEvidence(output(input, Array.from({ length: 50 }, () => pair(input, "initiative", "outcome"))), input);
  assert.equal(limited.coverage.status, "partial");
  let calls = 0;
  const invalid = await service(() => { calls++; return { findings: [] }; }).analyze(input);
  assert.deepEqual(invalid, { status: "failed", reason: "invalid_intelligence_output" }); assert.equal(calls, 2);
});

void test("evidence review preserves provider call, token and prompt budgets", async () => {
  const input = inputFor(); let calls = 0;
  const create = (overrides: Readonly<{ maxCalls?: number; maxTotalTokens?: number; maxPromptCharacters?: number }>) => createStoryAgentService({ budget: { ...budget, ...overrides }, now: () => 0, route: { complete: () => { calls++; return Promise.resolve({ provider: "fake", model: "test", usage, text: JSON.stringify(output(input)) }); } } });
  assert.deepEqual(await create({ maxPromptCharacters: 40 }).analyze(input), { status: "failed", reason: "context_limit" }); assert.equal(calls, 0);
  assert.deepEqual(await create({ maxCalls: 0 }).analyze(input), { status: "failed", reason: "over_budget" }); assert.equal(calls, 0);
  assert.deepEqual(await create({ maxTotalTokens: 1 }).analyze(input), { status: "failed", reason: "over_budget" }); assert.equal(calls, 1);
});

void test("disabled rules stay out of prompts and identical statements do not prove a contradiction", () => {
  const input = { ...inputFor(), projectRules: { glossary: [], roles: [], naming: [], acceptanceCriteria: { format: "checklist" as const, instructions: "", examples: [] }, rules: [{ id: "off", enabled: false, group: "Review", level: "all" as const, instruction: "Disabled instruction must not reach the provider" }] } };
  assert.doesNotMatch(evidencePrompt(input, 24000), /Disabled instruction must not reach the provider/);
  assert.throws(() => validateEvidence(output(input, [pair(input, "initiative", "outcome", "contradiction")]), input), /contrasting statement/);
});

void test("decisions survive unchanged evidence and reopen naturally when evidence or rules change", () => {
  const input = inputFor(); const path = levels[3][0];
  const findings = validateEvidence(output(input, [pair(input, path, "intent")]), input).findings;
  const dismissed = findings.map((item) => ({ ...item, review: { status: "dismissed" as const, history: [{ decision: "dismiss" as const, reason: "Intentional alternatives", at: "now" }] } }));
  const prior: StoryAgentAnalysis = { id: "analysis", kind: "backlog", originalRequirement: input.requirement, sourceFingerprint: "source", sourceVersion: 0, compared: [], findings: dismissed, createdAt: "now" };
  assert.equal(retainFindingDecisions(findings, [prior])[0]?.review?.status, "dismissed");
  const changed = { ...input, plan: replace(plan, path, { intent: "A reader resumes offline" }) };
  assert.equal(retainFindingDecisions(validateEvidence(output(changed, [pair(changed, path, "intent")]), changed).findings, [prior])[0]?.review?.status, "open");
  const changedRules = { ...input, projectRules: { glossary: [{ term: "Reader", definition: "An authenticated chapter reader", aliases: [] }], roles: [], naming: [], rules: [], acceptanceCriteria: { format: "checklist" as const, instructions: "", examples: [] } } };
  assert.equal(retainFindingDecisions(validateEvidence(output(changedRules, [pair(changedRules, path, "intent")]), changedRules).findings, [prior])[0]?.review?.status, "open");
});

const seed = async (repository: Parameters<Parameters<typeof withStoryApi>[1]>[0]["repository"], runId: string, projectId: string | null = "reading") => {
  await repository.saveRun({ runId, ...(projectId ? { projectId } : {}), requirement: "Readers resume saved chapters", plan, stories: flattenPlan(plan), status: "draft", usage, attempts: 1, providers: [], stages: [], validationErrors: [], createdAt: runId, updatedAt: "now" });
};
const apiService = createStoryAgentService({ budget, now: () => 0, route: { complete: (request) => {
  const text = request.messages[0]?.content ?? "";
  const data = JSON.parse(text.match(/<intelligence-data>(.*?)<\/intelligence-data>/s)?.[1] ?? "null") as { runId: string; artifacts: { runId: string; artifactPath: string; fields: Record<string, string> }[] };
  const source = data.artifacts.find((item) => item.runId === data.runId && item.artifactPath === "initiative");
  const counterpart = data.artifacts.find((item) => item.runId !== data.runId && item.artifactPath === "initiative");
  return Promise.resolve({ provider: "fake", model: "test", usage, text: JSON.stringify({ findings: source && counterpart ? [{ kind: "duplicate_behavior", artifactPath: "initiative", reason: "Same outcome", suggestedUpdate: "Clarify scope", evidence: [source, counterpart].map((item) => ({ runId: item.runId, artifactPath: item.artifactPath, fieldPath: "initiative.outcome", quote: item.fields["initiative.outcome"] })), dependencies: [] }] : [], reviewedArtifacts: data.artifacts.map(({ runId, artifactPath }) => ({ runId, artifactPath })), truncated: false }) });
} } });

void test("HTTP decisions persist, use separate review revisions, reject stale writes and preserve plans", async () => {
  await withStoryApi(apiService, async ({ request, repository }) => {
    await seed(repository, "one"); await seed(repository, "two"); await seed(repository, "other", "unrelated");
    const response = await request("/runs/one/analyses", "POST", { kind: "backlog", version: 0, evidenceVersion: 2 }); assert.equal(response.status, 200);
    const analysis = (await response.json() as { analysis: StoryAgentAnalysis }).analysis; const finding = analysis.findings[0]; assert.ok(finding);
    const url = `/runs/one/analyses/${analysis.id}/findings/${finding.id}/decision`;
    assert.equal((await request(url, "POST", { decision: "dismiss", reason: " ", reviewVersion: 0 })).status, 400);
    for (const [reviewVersion, decision] of ["confirm", "dismiss", "reopen"].entries()) {
      assert.equal((await request(url, "POST", { decision, reason: "Reviewed evidence", reviewVersion })).status, 200);
      assert.equal((await repository.getRun("one"))?.refinementVersion, 1);
      assert.equal((await request(url, "POST", { decision, reason: "Stale request", reviewVersion })).status, 409);
    }
    const stored = await repository.getRun("one"); assert.deepEqual(stored?.plan, plan); assert.equal(stored.analyses?.[0]?.findings[0]?.review?.history.length, 3);
    assert.equal((await request(`/runs/other/analyses/${analysis.id}/findings/${finding.id}/decision`, "POST", { decision: "confirm", reason: "", reviewVersion: 3 })).status, 404);
    await repository.updateRunStatus("two", "draft", { refinementVersion: 1 });
    assert.equal((await request(url, "POST", { decision: "confirm", reason: "", reviewVersion: 3 })).status, 409);
    const detail = await (await request("/runs/one")).json() as { run: { analyses: StoryAgentAnalysis[] } }; assert.equal(detail.run.analyses[0]?.stale, true);
    assert.deepEqual((await repository.getRun("other"))?.plan, plan);
  });
});

void test("HTTP pagination reaches older entries, isolates projects and validates page and analysis limits", async () => {
  await withStoryApi(apiService, async ({ request, repository }) => {
    await seed(repository, "source"); for (let i = 0; i < 105; i++) await seed(repository, `reading-${String(i).padStart(3, "0")}`);
    await seed(repository, "other", "unrelated"); await seed(repository, "legacy", null); await seed(repository, "deleted"); await repository.updateRunStatus("deleted", "draft", { deletingAt: "now" });
    const first = await (await request("/runs/source/comparisons?limit=100&skip=0")).json() as { runs: { runId: string }[]; hasMore: boolean; nextSkip: number };
    const second = await (await request(`/runs/source/comparisons?limit=100&skip=${String(first.nextSkip)}`)).json() as typeof first;
    assert.equal(first.runs.length, 100); assert.equal(first.hasMore, true); assert.equal(second.runs.length, 5); assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.runs, ...second.runs].map((item) => item.runId)).size, 105);
    assert.ok([...first.runs, ...second.runs].every((item) => item.runId.startsWith("reading-")));
    assert.equal((await request("/runs/source/comparisons?limit=101")).status, 400);
    assert.equal((await request("/runs/source/comparisons?skip=-1")).status, 400);
    for (const compareRunIds of [["other"], ["missing"], Array.from({ length: 26 }, (_, i) => `reading-${String(i).padStart(3, "0")}`)]) assert.equal((await request("/runs/source/analyses", "POST", { kind: "backlog", evidenceVersion: 2, version: 0, compareRunIds })).status, 400);
    assert.equal((await request("/runs/source/analyses", "POST", { kind: "impact", evidenceVersion: 2, version: 0, updatedRequirement: "Different requirement" })).status, 400);
    assert.equal((await request("/runs/source/analyses", "POST", { kind: "backlog", evidenceVersion: 2, version: 0, compareRunIds: [] })).status, 200);
  });
});

void test("review persistence rejects concurrent writers and decision/history limits without changing plans", async () => {
  await withStoryApi(apiService, async ({ request, repository, memory }) => {
    await seed(repository, "one"); await seed(repository, "two");
    const response = await request("/runs/one/analyses", "POST", { kind: "backlog", evidenceVersion: 2, version: 0 });
    const analysis = (await response.json() as { analysis: StoryAgentAnalysis }).analysis;
    const source = await repository.getRun("one"); assert.ok(source); const snapshot = structuredClone(source);
    const reviews = createIntelligenceRepository(memory.db);
    const update = (status: "confirmed" | "dismissed"): StoryAgentAnalysis => ({ ...analysis, reviewVersion: 1, findings: analysis.findings.map((item) => ({ ...item, review: { status, history: [] } })) });
    assert.equal(await reviews.saveDecision(snapshot, update("confirmed"), "later"), true);
    assert.equal(await reviews.saveDecision(snapshot, update("dismissed"), "stale"), false);
    assert.equal(await reviews.save(snapshot, { ...analysis, id: "concurrent-analysis" }, "stale"), false);
    const finding = analysis.findings[0]; assert.ok(finding);
    const limited = { ...analysis, findings: analysis.findings.map((item) => ({ ...item, review: { status: "open" as const, history: Array.from({ length: 20 }, () => ({ decision: "reopen" as const, reason: "Reviewed", at: "now" })) } })) };
    await repository.updateRunStatus("one", "draft", { analyses: [limited] });
    const url = `/runs/one/analyses/${analysis.id}/findings/${finding.id}/decision`;
    assert.equal((await request(url, "POST", { decision: "confirm", reason: "", reviewVersion: 0 })).status, 400);
    await repository.updateRunStatus("one", "draft", { analyses: Array.from({ length: 20 }, (_, index) => ({ ...analysis, id: String(index) })) });
    assert.equal((await request("/runs/one/analyses", "POST", { kind: "backlog", evidenceVersion: 2, version: 1 })).status, 400);
    assert.deepEqual((await repository.getRun("one"))?.plan, plan);
  });
});

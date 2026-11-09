import test from "node:test";
import assert from "node:assert/strict";
import type { StoryAgentProject, StoryAgentProjectRules } from "@workspace/types";
import { projectRulesSchema, projectRulesPrompt } from "../story-agent.projects.js";
import { createProjectRepository } from "../story-agent.projects.repository.js";
import { createStoryAgentService, flattenPlan } from "../story-agent.service.js";
import { explainQuality } from "../story-agent.quality.js";
import { createMemoryPersistence } from "./story-agent.memory.js";
import { createStoryAgentRepository } from "../story-agent.repository.js";
import { createStoryAgentQueue } from "../story-agent.queue.js";
import { withStoryContext } from "../story-agent.metadata.js";
import { withStoryApi } from "./story-agent.http-fixture.js";
import { plan } from "./story-agent.fixture.js";

export const rules: StoryAgentProjectRules = { glossary: [{ term: "Reader", definition: "A person reading a saved chapter", aliases: ["bookworm"] }], roles: [{ name: "Reader", description: "Resumes a saved chapter" }], naming: [{ level: "story", prefix: "A reader", instructions: "Name the actor and outcome" }], acceptanceCriteria: { format: "given_when_then", instructions: "Use observable results", examples: ["Given a chapter, when opened, then its text is visible."] }, rules: [{ id: "one", group: "Scope", level: "story", instruction: "Keep one reader outcome per story", enabled: true }] };
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const budget = { maxCalls: 6, maxTotalTokens: 1000, timeoutMs: 10000, contextTokenLimit: 6000, maxStories: 10 };
const clarification = JSON.stringify({ needsClarification: false, questions: [], assumptions: ["Use saved progress"] });
const scriptedService = (responses: readonly string[], prompts: string[], contextCharacters = 24000) => createStoryAgentService({ budget: { ...budget, maxPromptCharacters: contextCharacters }, now: () => 0, route: { complete: (input) => {
  const text = responses[prompts.length]; if (text === undefined) throw new Error("Unexpected provider call");
  prompts.push(input.messages[0]?.content ?? ""); return Promise.resolve({ provider: "fake", model: "test", usage, text });
} } });

void test("rules validate structure, ambiguous glossary, naming levels, IDs and total context", () => {
  assert.ok(projectRulesSchema.safeParse(rules).success);
  for (const invalid of [{ ...rules, glossary: [...rules.glossary, { term: "BOOKWORM", definition: "Other meaning", aliases: [] }] }, { ...rules, naming: [...rules.naming, ...rules.naming] }, { ...rules, rules: [...rules.rules, ...rules.rules] }, { ...rules, acceptanceCriteria: { format: "custom", instructions: "", examples: [] } }, { ...rules, rules: Array.from({ length: 20 }, (_, i) => ({ id: String(i), group: "Scope", level: "all", instruction: "x".repeat(500), enabled: true })) }]) assert.equal(projectRulesSchema.safeParse(invalid).success, false);
  assert.equal(projectRulesPrompt(undefined), "");
  assert.doesNotMatch(projectRulesPrompt({ ...rules, rules: [{ ...rules.rules[0] as NonNullable<typeof rules.rules[0]>, instruction: "Disabled project instruction", enabled: false }] }), /Disabled project instruction/);
});

void test("rules reach clarify, generation and repair while no-rules generation stays compatible", async () => {
  const prompts: string[] = [];
  const service = createStoryAgentService({ budget, now: () => 0, route: { complete: (input) => { prompts.push(input.messages[0]?.content ?? ""); return Promise.resolve({ provider: "fake", model: "test", usage, text: JSON.stringify(prompts.length === 1 ? { needsClarification: false, questions: [], assumptions: [] } : prompts.length === 2 ? { plan: {} } : { plan }) }); } } });
  const result = await service.run({ requirement: "Readers resume chapters", projectRules: rules });
  assert.equal(result.status, "draft"); assert.equal(prompts.length, 3);
  for (const prompt of prompts) { assert.match(prompt, /project-rules-data.*Reader/s); assert.ok(prompt.indexOf("<project-rules-data>") < prompt.indexOf("<requirement-data>")); assert.equal(prompt.split("<project-rules-data>").length, 2); }
  const invalid = await service.run({ requirement: "Readers resume chapters", projectRules: { ...rules, naming: [...rules.naming, ...rules.naming] } });
  assert.equal(invalid.reason, "invalid_project_rules"); assert.equal(prompts.length, 3);
});

void test("project naming and criteria feedback remains advisory and level-aware", () => {
  const quality = explainQuality(plan, [], rules);
  assert.equal(quality.status, "passed"); assert.ok(quality.checks.some((check) => check.issue.includes("acceptance criteria format") && check.status === "warning"));
  assert.ok(quality.checks.filter((check) => check.issue === "Project rule (Scope)").every((check) => check.level === "story"));
});

void test("combined project context limits fail before making provider calls", async () => {
  let calls = 0;
  const service = createStoryAgentService({ budget: { ...budget, maxPromptCharacters: 40 }, now: () => 0, route: { complete: () => { calls += 1; return Promise.resolve({ provider: "fake", model: "test", usage, text: "{}" }); } } });
  const result = await service.run({ requirement: "Resume a chapter", projectRules: rules });
  assert.equal(result.reason, "context_limit"); assert.equal(calls, 0);
});

void test("assembled clarification and generation prompts honor exact context boundaries", async () => {
  for (const projectRules of [undefined, rules]) {
    const request = { requirement: "Readers resume chapters", projectRules };
    const responses = [clarification, JSON.stringify({ plan })]; const baseline: string[] = [];
    assert.equal((await scriptedService(responses, baseline).run(request)).status, "draft");
    const clarifyPrompt = baseline[0], generatePrompt = baseline[1]; assert.ok(clarifyPrompt && generatePrompt); assert.ok(generatePrompt.length > clarifyPrompt.length);
    for (const [limit, expectedCalls] of [[clarifyPrompt.length - 1, 0], [generatePrompt.length - 1, 1]] as const) {
      const sent: string[] = []; const result = await scriptedService(responses, sent, limit).run(request);
      assert.equal(result.reason, "context_limit"); assert.equal(sent.length, expectedCalls); assert.ok(sent.every((prompt) => prompt.length <= limit));
    }
    const sent: string[] = [];
    assert.equal((await scriptedService(responses, sent, generatePrompt.length).run(request)).status, "draft");
    assert.equal(sent[1]?.length, generatePrompt.length);
  }
});

void test("repair prompt limits include the prior output and validation errors", async () => {
  const invalid = JSON.stringify({ plan: { initiative: { title: "x".repeat(8000) } } });
  const responses = [clarification, invalid, JSON.stringify({ plan })]; const baseline: string[] = [];
  const request = { requirement: "Readers resume chapters", projectRules: rules };
  assert.equal((await scriptedService(responses, baseline).run(request)).status, "draft");
  const repairPrompt = baseline[2]; assert.ok(repairPrompt); assert.ok(repairPrompt.length > (baseline[1]?.length ?? 0));
  const sent: string[] = []; const result = await scriptedService(responses, sent, repairPrompt.length - 1).run(request);
  assert.equal(result.reason, "context_limit"); assert.equal(sent.length, 2);
  const boundary: string[] = []; assert.equal((await scriptedService(responses, boundary, repairPrompt.length).run(request)).status, "draft");
  assert.equal(boundary[2]?.length, repairPrompt.length);
});

void test("refinement prompt limits include the original hierarchy and quality findings", async () => {
  const original = withStoryContext("context-test", plan, flattenPlan(plan));
  const proposed = { initiative: { ...original.initiative, title: "Reader confidence" } };
  const response = JSON.stringify({ plan: proposed, changes: [{ path: "initiative.title", explanation: "Clarify the reader outcome", reason: "Resolve ambiguity" }] });
  const request = { requirement: "Readers resume chapters", projectRules: rules, refinement: { original, artifactPath: "initiative", instructions: "Clarify the outcome" } };
  const baseline: string[] = []; assert.equal((await scriptedService([response], baseline).run(request)).status, "draft");
  const prompt = baseline[0]; assert.ok(prompt); assert.match(prompt, /refinement-data/); assert.match(prompt, /quality-findings-data/);
  const sent: string[] = []; assert.equal((await scriptedService([response], sent, prompt.length - 1).run(request)).reason, "context_limit"); assert.equal(sent.length, 0);
  assert.equal((await scriptedService([response], [], prompt.length).run(request)).status, "draft");
});

void test("queued retries pass the persisted rules snapshot to the existing generation pipeline", async () => {
  const { db } = createMemoryPersistence(); const repository = createStoryAgentRepository(db);
  const now = new Date(0).toISOString();
  await repository.saveRun({ runId: "queued", requirement: "Resume a chapter", projectId: "project", projectRules: rules, status: "queued", usage, attempts: 0, providers: [], stages: [], validationErrors: [], createdAt: now, updatedAt: now, nextAttemptAt: now, lockedUntil: null });
  let seen: unknown;
  const queue = createStoryAgentQueue({ repository, clock: { now: () => 0 }, intervalMs: 1000, logger: { info: () => undefined, warn: () => undefined, error: () => undefined }, service: { run: (input) => { seen = input.projectRules; return Promise.resolve({ status: "draft", plan, stories: flattenPlan(plan), usage, attempts: 1, providers: [], stages: [], validationErrors: [] }); } } });
  await queue.processNext(); assert.deepEqual(seen, rules); assert.equal((await repository.getRun("queued"))?.status, "draft");
});

void test("project writes use optimistic versions and retain prior configurations", async () => {
  const { db } = createMemoryPersistence(); const repository = createProjectRepository(db);
  const project: StoryAgentProject = { projectId: "one", name: "Reading", version: 1, updatedAt: "now", rules };
  await repository.create(project); const saved = await repository.get("one"); assert.ok(saved);
  assert.equal(await repository.update(saved, { name: "Renamed", rules: { ...rules, rules: [] } }, "later"), true);
  assert.equal(await repository.update(saved, project, "stale"), false);
  assert.deepEqual((await repository.get("one"))?.history[0]?.rules, rules);
  assert.equal(await repository.remove("one", 1, "now"), false);
  assert.equal(await repository.remove("one", 2, "now"), true); assert.deepEqual(await repository.list(), []);
});

void test("HTTP project CRUD, rule deletion/order and generation snapshots preserve old entries", async () => {
  const seen: unknown[] = [];
  await withStoryApi({ run: (input) => { seen.push(input); const output = input.refinement?.original ?? plan; return Promise.resolve({ status: "draft", plan: output, stories: flattenPlan(output), usage, attempts: 1, providers: [], stages: [], validationErrors: [] }); } }, async ({ request, repository }) => {
    const created = await request("/projects", "POST", { name: "Reading", rules }); assert.equal(created.status, 200);
    const project = (await created.json() as { project: StoryAgentProject }).project;
    const generation = await request("/runs", "POST", { requirement: "Readers resume chapters", projectId: project.projectId }); assert.equal(generation.status, 200);
    const runId = (await generation.json() as { runId: string }).runId;
    assert.deepEqual((await repository.getRun(runId))?.projectRules, rules);
    assert.equal((await request(`/projects/${project.projectId}`, "PUT", { name: "Reading", rules: { ...rules, rules: [] }, version: 1 })).status, 200);
    assert.equal((await request(`/projects/${project.projectId}`, "PUT", { name: "Reading", rules, version: 1 })).status, 409);
    assert.deepEqual((await repository.getRun(runId))?.projectRules, rules);
    const proposed = await request(`/runs/${runId}/refinements`, "POST", { artifactPath: "initiative", instructions: "Clarify title", version: 0 }); assert.equal(proposed.status, 422);
    assert.deepEqual((seen[1] as { projectRules: unknown }).projectRules, rules);
    assert.equal((await request(`/projects/${project.projectId}`, "DELETE", { version: 2 })).status, 200);
    assert.ok(await repository.getRun(runId)); assert.equal((await request("/runs", "POST", { requirement: "Readers resume", projectId: project.projectId })).status, 404);
    assert.equal((await request("/runs", "POST", { requirement: "Readers resume without a project" })).status, 200);
    assert.equal((await request("/projects", "POST", { name: "Invalid", rules: {} })).status, 400);
  });
});

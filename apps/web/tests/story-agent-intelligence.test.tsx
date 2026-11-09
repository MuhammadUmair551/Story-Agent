import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StoryAgentAnalysis } from "@workspace/types";
import { createStoryAgentClient, parseStoryAgentRun } from "../features/story-agent/story-agent.client";
import { IntelligenceReview } from "../features/story-agent/components/intelligence-review";
import { QualityReview } from "../features/story-agent/components/quality-review";
import { comparisonCandidates, updateComparisonSelection } from "../features/story-agent/story-agent.comparisons";

const plan = { initiative: { title: "Reading", outcome: "Resume chapters", epics: [{ title: "Reading progress", objective: "Keep position", features: [{ title: "Resume", outcome: "Keep chapter position", stories: [{ title: "A reader resumes a chapter", intent: "Continue reading", acceptanceCriteria: ["A chapter resumes at the saved position"], tasks: [{ title: "Save offset", description: "Persist the last position", effort: "S" as const }] }] }] }] } };
const analysis: StoryAgentAnalysis = { id: "analysis", kind: "impact", originalRequirement: "Resume chapters", updatedRequirement: "Resume chapters offline", sourceVersion: 0, sourceFingerprint: "fingerprint", compared: [{ runId: "two", fingerprint: "other" }], createdAt: "2026-11-08", findings: [{ id: "finding", kind: "stale", artifactPath: "initiative", method: "semantic_review", reason: "Offline progress is not described", suggestedUpdate: "Describe offline progress persistence", evidence: [{ runId: "one", artifactPath: "initiative", quote: "Resume chapters offline" }], dependencies: [{ runId: "two", artifactPath: "initiative" }] }] };

void test("saved-title comparison choices retain identity and exclude unavailable or unrelated entries", () => {
  const entry = (runId: string, fields: Readonly<Record<string, unknown>> = {}) => parseStoryAgentRun({ runId, status: "draft", requirement: "Same saved title", projectId: "reading", plan, ...fields });
  const source = entry("source");
  const choices = comparisonCandidates(source, [source, entry("first"), entry("second"), entry("first"), entry("other", { projectId: "other" }), entry("unscoped", { projectId: undefined }), entry("deleted", { deletingAt: "now" }), entry("queued", { status: "queued" })]);
  assert.deepEqual(choices.map((run) => run.runId), ["first", "second"]);
  const selected = updateComparisonSelection([], "second", true, choices);
  assert.deepEqual(selected, ["second"]); assert.deepEqual(updateComparisonSelection(selected, "other", true, choices), selected);
  const renamed = comparisonCandidates(source, [entry("second", { requirement: "Renamed saved title" })]);
  assert.deepEqual(updateComparisonSelection(selected, "second", true, renamed), ["second"]);
  assert.deepEqual(comparisonCandidates(entry("legacy", { projectId: undefined }), [entry("legacy-other", { projectId: undefined }), entry("project-run")]).map((run) => run.runId), ["legacy-other"]);
});

void test("comparison selections are immutable, unique and bounded to 25 entries", () => {
  const entries = Array.from({ length: 30 }, (_, index) => parseStoryAgentRun({ runId: String(index), status: "draft", requirement: "Same title", plan }));
  let selected: readonly string[] = [];
  for (const entry of entries) selected = updateComparisonSelection(selected, entry.runId, true, entries);
  assert.equal(selected.length, 25);
  assert.deepEqual(updateComparisonSelection(selected, "0", true, entries), selected);
  const removed = updateComparisonSelection(selected, "0", false, entries);
  assert.equal(selected.length, 25); assert.equal(removed.length, 24);
  assert.equal(updateComparisonSelection(removed, "29", true, entries).length, 25);
});

void test("saved comparison retrieval preserves history defaults and explicit empty selections", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const client = createStoryAgentClient("https://api.example.test", (url, init) => { calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined }); return Promise.resolve(Response.json({ runs: [{ runId: "deleted", status: "draft", requirement: "Delete pending", plan, deletingAt: "now" }] })); });
  await client.listRuns(); const page = await client.listRuns({ limit: 100, skip: 100 });
  assert.match(calls[0]?.url ?? "", /\?limit=20&skip=0$/); assert.match(calls[1]?.url ?? "", /\?limit=100&skip=100$/); assert.equal(page[0]?.deletingAt, "now");
  await client.analyzeRun("source", { kind: "backlog", version: 0, compareRunIds: [] });
  assert.deepEqual(calls[2]?.body, { kind: "backlog", version: 0, compareRunIds: [] });
});

void test("intelligence client separates analysis from versioned proposal preparation", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const client = createStoryAgentClient("https://api.example.test", (url, init) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as unknown }); return Promise.resolve(Response.json({})); });
  await client.analyzeRun("a/b", { kind: "impact", updatedRequirement: analysis.updatedRequirement, compareRunIds: ["two"], version: 0 });
  await client.proposeRefinement("a/b", { artifactPath: "initiative", instructions: "Persist offline progress", version: 1, analysisId: "analysis", findingId: "finding" });
  assert.match(calls[0]?.url ?? "", /a%2Fb\/analyses$/); assert.deepEqual(calls[0]?.body, { kind: "impact", updatedRequirement: "Resume chapters offline", compareRunIds: ["two"], version: 0 });
  assert.deepEqual(calls[1]?.body, { artifactPath: "initiative", instructions: "Persist offline progress", version: 1, analysisId: "analysis", findingId: "finding" });
  const stale = createStoryAgentClient("https://api.example.test", () => Promise.resolve(Response.json({ error: "This analysis is stale. Analyze again." }, { status: 409 })));
  await assert.rejects(stale.proposeRefinement("one", { artifactPath: "initiative", instructions: "Update", version: 1, analysisId: "analysis", findingId: "finding" }), /stale/);
});

void test("analysis controls display requirement comparison, evidence, dependency scope and explicit update action", () => {
  const run = parseStoryAgentRun({ runId: "one", status: "draft", requirement: "Resume chapters", plan, analyses: [analysis] });
  const html = renderToStaticMarkup(createElement(IntelligenceReview, { run, client: createStoryAgentClient("https://api.example.test"), onUpdated: () => undefined }));
  for (const text of ["Review backlog", "Analyze requirement change", "Original requirement", "Updated requirement", "Offline progress is not described", "Describe offline progress persistence", "two / initiative", "Prepare proposed update", "verify the evidence"]) assert.ok(html.includes(text), text);
  assert.ok(html.includes("disabled=\"\""));
  for (const [version, disabled] of [[1, false], [2, true]] as const) {
    const markup = renderToStaticMarkup(createElement(IntelligenceReview, { run: { ...run, refinementVersion: version }, client: createStoryAgentClient("https://api.example.test"), onUpdated: () => undefined }));
    const proposalButton = markup.match(/<button[^>]*>Prepare proposed update<\/button>/)?.[0]; assert.ok(proposalButton);
    assert.equal(/\sdisabled(?:\s|=|>)/.test(proposalButton), disabled);
  }
});

void test("pending and retained revisions show original/proposed requirement changes without accepting them", () => {
  const proposal = { id: "proposal", artifactPath: "initiative", status: "pending", original: plan, proposed: { initiative: { ...plan.initiative, title: "Offline reading" } }, changes: [{ path: "initiative.title", explanation: "Clarify offline reading", reason: "Updated requirement" }], quality: { status: "passed", checks: [] }, createdAt: "now", analysisId: analysis.id, requirementChange: { original: "Resume chapters", proposed: "Resume chapters offline" } };
  for (const status of ["pending", "accepted", "rejected"]) {
    const run = parseStoryAgentRun({ runId: "one", status: "draft", requirement: "Resume chapters", plan, refinements: [{ ...proposal, status }], analyses: [analysis] });
    assert.deepEqual(run.refinements?.[0]?.requirementChange, proposal.requirementChange);
    assert.equal(run.requirement, "Resume chapters");
    const html = renderToStaticMarkup(createElement(QualityReview, { run, client: createStoryAgentClient("https://api.example.test"), onUpdated: () => undefined }));
    assert.match(html, /Original requirement/); assert.match(html, /Proposed requirement/); assert.match(html, /Resume chapters offline/);
    if (status === "pending") assert.match(html, /Accept proposal/);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StoryAgentAnalysis } from "@workspace/types";
import { createStoryAgentClient, parseStoryAgentRun } from "../features/story-agent/story-agent.client";
import { analysisIsStale, analysisSchema, filterFindings } from "../features/story-agent/story-agent.intelligence";
import { IntelligenceFindings } from "../features/story-agent/components/intelligence-findings";

const analysis: StoryAgentAnalysis = {
  id: "review", kind: "backlog", evidenceVersion: 2, sourceVersion: 0, reviewVersion: 1, sourceFingerprint: "snapshot", originalRequirement: "Readers resume", compared: [], createdAt: "now", stale: false,
  coverage: { scope: "selected_entries", status: "partial", reviewedArtifacts: 4, totalArtifacts: 5, excluded: [{ runId: "one", artifactPath: "initiative", breadcrumb: ["initiative: Reading"] }], reasons: ["The provider reported incomplete coverage."] },
  findings: [{ id: "finding", kind: "contradiction", artifactPath: "initiative.epics.0", method: "semantic_review", reason: "Progress retention requirements oppose each other.", suggestedUpdate: "Clarify retention under the same condition.", evidence: [{ runId: "one", artifactPath: "initiative.epics.0", level: "epic", breadcrumb: ["initiative: Reading", "epic: Progress"], fieldPath: "initiative.epics.0.objective", fieldValue: "Must retain progress", quote: "retain", start: 5, end: 11 }, { runId: "two", artifactPath: "initiative", level: "initiative", breadcrumb: ["initiative: Other brief"], fieldPath: "initiative.outcome", fieldValue: "Must discard progress", quote: "discard", start: 5, end: 12 }], counterparts: [{ runId: "two", artifactPath: "initiative", breadcrumb: ["initiative: Other brief"] }], dependencies: [], review: { status: "dismissed", history: [{ decision: "dismiss", reason: "Different actors", at: "now" }] } }]
};
const run = parseStoryAgentRun({ runId: "one", requirement: "Readers resume", status: "queued", refinementVersion: 1, analyses: [analysis] });

void test("evidence schema preserves field quotes, review history, coverage and legacy reports", () => {
  assert.deepEqual(run.analyses?.[0], analysis);
  assert.equal(analysisSchema.safeParse({ ...analysis, evidenceVersion: undefined, reviewVersion: undefined, coverage: undefined, stale: undefined }).success, true);
  assert.equal(analysisSchema.safeParse({ ...analysis, reviewVersion: -1 }).success, false);
});

void test("finding filters combine hierarchy, type and decision status without mutating reports", () => {
  assert.equal(filterFindings(analysis.findings, { level: "epic", kind: "contradiction", status: "dismissed" }).length, 1);
  for (const filters of [{ level: "task", kind: "all", status: "all" }, { level: "all", kind: "duplicate_behavior", status: "all" }, { level: "all", kind: "all", status: "open" }]) assert.equal(filterFindings(analysis.findings, filters).length, 0);
  assert.equal(analysis.findings.length, 1);
  assert.equal(analysisIsStale(run, analysis), false);
  assert.equal(analysisIsStale(run, { ...analysis, stale: true }), true);
});

void test("review UI presents side-by-side exact fields, breadcrumbs, coverage and reversible decisions", () => {
  const html = renderToStaticMarkup(createElement(IntelligenceFindings, { run, analysis, busy: false, client: createStoryAgentClient("https://api.example.test"), perform: async (operation) => { await operation(); } }));
  for (const text of ["Side-by-side evidence", "epic: Progress", "Other brief", "initiative.epics.0.objective", "<mark>retain</mark>", "<mark>discard</mark>", "Finding level", "Finding type", "Finding status", "Confirm finding", "Dismiss with reason", "Reopen finding", "Different actors", "partial", "4 of 5"]) assert.ok(html.includes(text), text);
  assert.match(html, /<button[^>]*disabled[^>]*>Prepare proposed update<\/button>/);
  const stale = renderToStaticMarkup(createElement(IntelligenceFindings, { run, analysis: { ...analysis, stale: true }, busy: false, client: createStoryAgentClient("https://api.example.test"), perform: async () => undefined }));
  assert.match(stale, /<fieldset disabled/); assert.match(stale, /evidence changed/);
});

void test("client encodes finding decisions and paginates comparisons beyond 100 without widening scope", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const client = createStoryAgentClient("https://api.example.test", (url, init) => { calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined }); return Promise.resolve(Response.json(init?.method ? {} : { runs: [], hasMore: false, nextSkip: 200 })); });
  await client.listComparisons("source/one", 100);
  assert.match(calls[0]?.url ?? "", /source%2Fone\/comparisons\?limit=100&skip=100$/);
  await client.decideFinding("source/one", "analysis/one", "finding/one", { decision: "dismiss", reason: "Different conditions", reviewVersion: 2 });
  assert.match(calls[1]?.url ?? "", /analyses\/analysis%2Fone\/findings\/finding%2Fone\/decision$/);
  assert.deepEqual(calls[1]?.body, { decision: "dismiss", reason: "Different conditions", reviewVersion: 2 });
  await client.analyzeRun("source/one", { kind: "backlog", evidenceVersion: 2, version: 0, compareRunIds: [] });
  assert.deepEqual(calls[2]?.body, { kind: "backlog", evidenceVersion: 2, version: 0, compareRunIds: [] });
  const missing = createStoryAgentClient("https://api.example.test", () => Promise.resolve(Response.json({ error: "Missing" }, { status: 404 })));
  await assert.rejects(missing.getRun("gone"), (error: unknown) => typeof error === "object" && error !== null && "status" in error && error.status === 404);
});

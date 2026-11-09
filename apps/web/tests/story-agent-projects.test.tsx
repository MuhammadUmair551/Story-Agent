import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStoryAgentClient } from "../features/story-agent/story-agent.client";
import { emptyProjectRules } from "../features/story-agent/story-agent.projects";
import { ProjectRules } from "../features/story-agent/components/project-rules";

void test("project client preserves rule ordering/removal and supplies optimistic versions", async () => {
  const rules = { ...emptyProjectRules(), rules: [{ id: "two", group: "Review", level: "all" as const, instruction: "Review coverage", enabled: false }] };
  const project = { projectId: "project/one", name: "Reading", version: 2, updatedAt: "now", rules };
  const calls: { url: string; method: string; body: unknown }[] = [];
  const client = createStoryAgentClient("https://api.example.test", (url, init) => { calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) as unknown : null }); return Promise.resolve(Response.json(init?.method ? { project } : { projects: [project] })); });
  assert.deepEqual(await client.listProjects(), [project]);
  assert.deepEqual(await client.saveProject({ name: "Reading", rules }, project), project);
  assert.match(calls[1]?.url ?? "", /projects\/project%2Fone$/);
  assert.deepEqual(calls[1]?.body, { name: "Reading", rules, version: 2 });
  const stale = createStoryAgentClient("https://api.example.test", () => Promise.resolve(Response.json({ error: "Project changed. Reload before saving." }, { status: 409 })));
  await assert.rejects(stale.saveProject({ name: "Reading", rules }, project), /Reload/);
});

void test("project form composes shared controls with saved glossary, role, conventions and examples", () => {
  const rules = { ...emptyProjectRules(), glossary: [{ term: "Reader", definition: "A person reading", aliases: ["Bookworm"] }], roles: [{ name: "Reader", description: "Resumes progress" }], naming: [{ level: "task" as const, prefix: "Implement", instructions: "Use an action verb" }], acceptanceCriteria: { format: "checklist" as const, instructions: "Observable results", examples: ["A saved chapter can be resumed"] } };
  const html = renderToStaticMarkup(createElement(ProjectRules, { projects: [{ projectId: "one", name: "Reading", rules, version: 1, updatedAt: "now" }], selectedId: "one", client: createStoryAgentClient("https://api.example.test"), loadError: "", onSelect: () => undefined, onSaved: () => undefined }));
  for (const value of ["Project for generation", "Reader", "Bookworm", "Resumes progress", "Implement", "Observable results", "A saved chapter can be resumed", "Save rules", "Delete glossary term", "Add project rule"]) assert.ok(html.includes(value), value);
});

void test("malformed project responses fail and generation carries project selection explicitly", async () => {
  const invalid = createStoryAgentClient("https://api.example.test", () => Promise.resolve(Response.json({ projects: [{ projectId: "one" }] })));
  await assert.rejects(invalid.listProjects());
  const rejected = createStoryAgentClient("https://api.example.test", () => Promise.resolve(Response.json({ error: { message: "Invalid project rules.", details: [{ path: ["rules", "glossary", 0, "term"], message: "A term is required." }] } }, { status: 400 })));
  await assert.rejects(rejected.saveProject({ name: "Reading", rules: emptyProjectRules() }), /rules.glossary.0.term: A term is required/);
  let body: unknown;
  const client = createStoryAgentClient("https://api.example.test", (_url, init) => { body = JSON.parse(String(init?.body)) as unknown; return Promise.resolve(Response.json({ runId: "run", status: "questions", questions: ["Who reads?"] })); });
  await client.createRun({ requirement: "Resume a chapter", projectId: "one" }); assert.deepEqual(body, { requirement: "Resume a chapter", projectId: "one" });
});

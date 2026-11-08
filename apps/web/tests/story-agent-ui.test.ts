import test from "node:test";
import assert from "node:assert/strict";
import { buildStoryAgentRunCopyText, createStoryAgentClient, filterStoryAgentRuns, parseStoryAgentRun } from "../features/story-agent/story-agent.client";
import { deleteConfirmedHistoryEntry } from "../features/story-agent/story-agent.history";
import type { StoryAgentRun } from "../features/story-agent/story-agent.types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QualityReview } from "../features/story-agent/components/quality-review";

const run: StoryAgentRun = {
    runId: "run-123",
    status: "draft",
    requirement: "Customers must manage cart quantities",
    stories: [
        {
            title: "A customer updates quantity in the cart",
            intent: "Change the item quantity",
            epic: "Cart",
            size: "S",
            acceptanceCriteria: [
                "Given a cart item exists, when the quantity changes, then the total reflects the new quantity.",
                "Given a quantity exceeds stock, when the change is submitted, then the cart rejects the update."
            ],
            states: ["ready"],
            dependsOn: [],
            openQuestions: [],
            sliceRationale: "Tracks the quantity-edit outcome independently."
        }
    ],
    usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    createdAt: "2026-01-01T00:00:00.000Z"
};

test("filters history by requirement and generated story titles", () => {
    const filtered = filterStoryAgentRuns([
        run,
        {
            ...run,
            runId: "run-456",
            requirement: "Check analytics dashboard",
            stories: [{
                ...run.stories?.[0] ?? {
                    title: "Dashboard overview",
                    intent: "Review performance",
                    epic: "Analytics",
                    size: "M",
                    acceptanceCriteria: ["Metrics appear."],
                    states: [],
                    dependsOn: [],
                    openQuestions: [],
                    sliceRationale: "Shows the dashboard."
                },
                title: "Dashboard overview"
            }]
        }
    ], "quantity");

    assert.deepEqual(filtered.map((item) => item.runId), ["run-123"]);
});

test("copy text includes every story and acceptance criterion", () => {
    const output = buildStoryAgentRunCopyText(run);

    assert.match(output, /Requirement: Customers must manage cart quantities/);
    assert.match(output, /A customer updates quantity in the cart/);
    assert.match(output, /Given a cart item exists/);
    assert.match(output, /then the cart rejects the update/);
});

test("turns malformed persisted drafts into a controlled failed state", () => {
  const parsed = parseStoryAgentRun({ runId: "bad-run", status: "draft", requirement: "Create stories", stories: [{ title: "Missing required story fields" }] });

  assert.equal(parsed.status, "failed");
  assert.equal(parsed.error, "Saved draft data is incomplete.");
});

test("preserves a nested initiative delivery plan from persisted data", () => {
  const parsed = parseStoryAgentRun({
    runId: "plan-123", status: "draft", requirement: "Make checkout easier",
    plan: { initiative: { title: "Checkout confidence", outcome: "Customers complete orders confidently.", epics: [{ title: "Checkout", objective: "Clarify payment review.", features: [{ title: "Order summary", outcome: "Show the final order.", stories: [{ title: "A customer reviews an order summary", intent: "Confirm items before payment", acceptanceCriteria: ["Given a cart, when checkout opens, then a summary is visible."], tasks: [{ title: "Render order lines", description: "Show products, quantities, and prices.", effort: "S" }] }] }] }] } }
  });

  assert.equal(parsed.plan?.initiative.epics[0]?.features[0]?.stories[0]?.tasks[0]?.title, "Render order lines");
});

test("opening an entry uses GET; deleting it uses an encoded DELETE and surfaces failures", async () => {
  const calls: { url: string; method: string }[] = [];
  const client = createStoryAgentClient("https://api.example.test/", (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    return Promise.resolve(Response.json(init?.method === "DELETE" ? { deleted: true } : { run, draft: null }));
  });
  await client.getRun("a/b"); await client.deleteRun("a/b");
  assert.deepEqual(calls, [{ url: "https://api.example.test/story-agent/runs/a%2Fb", method: "GET" }, { url: "https://api.example.test/story-agent/runs/a%2Fb", method: "DELETE" }]);
  const failing = createStoryAgentClient("https://api.example.test", () => Promise.resolve(Response.json({ error: "Storage unavailable" }, { status: 500 })));
  await assert.rejects(failing.deleteRun("one"), /Storage unavailable/);
  const missing = createStoryAgentClient("https://api.example.test", () => Promise.resolve(Response.json({ error: "History entry not found." }, { status: 404 })));
  await assert.rejects(missing.deleteRun("one"), /History entry not found/);
});

test("history deletion requires confirmation, removes only the selected entry and refreshes after success", async () => {
  const events: string[] = []; let history = ["one", "two"];
  const input = { runId: "one", deleteRun: (id: string) => { events.push(`delete:${id}`); return Promise.resolve(); }, onDeleted: (id: string) => { history = history.filter((item) => item !== id); events.push(`removed:${id}`); }, refresh: () => { events.push("refresh"); return Promise.resolve(); } };
  assert.equal(await deleteConfirmedHistoryEntry({ ...input, confirmed: false }), false); assert.deepEqual(events, []);
  assert.equal(await deleteConfirmedHistoryEntry({ ...input, confirmed: true }), true);
  assert.deepEqual(events, ["delete:one", "removed:one", "refresh"]); assert.deepEqual(history, ["two"]);
});

test("failed deletion retains the entry and does not report success or refresh", async () => {
  const events: string[] = [];
  await assert.rejects(deleteConfirmedHistoryEntry({ confirmed: true, runId: "one", deleteRun: () => Promise.reject(new Error("Storage unavailable")), onDeleted: () => { events.push("removed"); }, refresh: () => { events.push("refresh"); return Promise.resolve(); } }), /Storage unavailable/);
  assert.deepEqual(events, []);
});

test("refinement client sends explicit proposals and accept/reject decisions with versions", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const client = createStoryAgentClient("https://api.example.test", (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as unknown });
    return Promise.resolve(Response.json({}));
  });
  await client.proposeRefinement("one", { artifactPath: "initiative", instructions: "Clarify scope", version: 0 });
  await client.decideRefinement("one", "proposal", "accept", 1); await client.decideRefinement("one", "proposal", "reject", 1);
  assert.deepEqual(calls.map((call) => call.body), [{ artifactPath: "initiative", instructions: "Clarify scope", version: 0 }, { decision: "accept", version: 1 }, { decision: "reject", version: 1 }]);
  assert.match(calls[1]?.url ?? "", /\/one\/refinements\/proposal\/decision$/);
});

test("proposal parsing and comparison preserve and display original/proposed story context", () => {
  const story = run.stories?.[0]; assert.ok(story);
  const original = { initiative: { title: "Reading continuity", outcome: "Resume a saved chapter", epics: [{ title: "Reading", objective: "Retain progress", features: [{ title: "Resume", outcome: "Continue reading", stories: [{ artifactId: "story:0123456789abcdef01234567", title: story.title, intent: story.intent, acceptanceCriteria: story.acceptanceCriteria, tasks: [{ title: "Save offset", description: "Persist position", effort: "S" }], metadata: { states: ["ready"], dependsOn: ["Saved chapter"], openQuestions: ["Retention period?"], sliceRationale: "Original context rationale" } }] }] }] } };
  const proposed = structuredClone(original);
  const changed = proposed.initiative.epics[0]?.features[0]?.stories[0]; assert.ok(changed);
  changed.title = "A reader resumes the saved chapter"; changed.metadata.states = ["reviewed"];
  const parsed = parseStoryAgentRun({ ...run, plan: original, refinementVersion: 1, refinements: [{ id: "proposal", artifactPath: "initiative", status: "pending", original, proposed, quality: { status: "passed", checks: [] }, changes: [{ path: "initiative.epics.0.features.0.stories.0.metadata.states.0", explanation: "State updated", reason: "Requested context correction" }], createdAt: "2026-11-08" }] });
  assert.deepEqual(parsed.refinements?.[0]?.original.initiative.epics[0]?.features[0]?.stories[0]?.metadata?.states, ["ready"]);
  assert.deepEqual(parsed.refinements?.[0]?.proposed.initiative.epics[0]?.features[0]?.stories[0]?.metadata?.states, ["reviewed"]);
  const markup = renderToStaticMarkup(createElement(QualityReview, { run: parsed, client: createStoryAgentClient("https://api.example.test"), onUpdated: () => undefined }));
  assert.match(markup, /Original artifact/); assert.match(markup, /Proposed artifact/);
  assert.match(markup, /Story context/); assert.match(markup, />ready</); assert.match(markup, />reviewed</);
  assert.match(markup, /Saved chapter/); assert.match(markup, /Retention period/); assert.match(markup, /Original context rationale/);
  assert.doesNotMatch(markup, /story:0123456789abcdef01234567/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { buildStoryAgentRunCopyText, createStoryAgentClient, filterStoryAgentRuns, parseStoryAgentRun } from "../features/story-agent/story-agent.client";
import { deleteConfirmedHistoryEntry } from "../features/story-agent/story-agent.history";
import type { StoryAgentRun } from "../features/story-agent/story-agent.types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QualityReview } from "../features/story-agent/components/quality-review";
import { storyAgentStatusLabel, storyAgentFailureRun } from "../features/story-agent/story-agent.client";
import { GenerationFeedback } from "../features/story-agent/components/generation-feedback";

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

test("history polling distinguishes an active lease from queued and terminal results", () => {
    const active = parseStoryAgentRun({ ...run, status: "queued", lockedUntil: "2026-01-01T00:05:00.000Z" });
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    assert.equal(storyAgentStatusLabel(active, now), "In progress");
    assert.equal(storyAgentStatusLabel(active, now + 5 * 60_000), "In queue");
    assert.equal(storyAgentStatusLabel({ ...active, status: "draft" }, now), "Ready");
    assert.equal(storyAgentStatusLabel({ ...active, status: "failed" }, now), "Needs repair");
    assert.equal(storyAgentStatusLabel({ ...active, status: "questions" }, now), "Needs a choice");
});

test("failed API responses preserve saved run identity, stage, retryability and HTTP status", async () => {
    const diagnostic = { category: "missing_required_field", reason: "validation_failed", stage: "repair", retryable: false, provider: "fixture", model: "fixture", issues: [{ path: "initiative.epics.0.features.0.outcome", code: "invalid_type", message: "Expected a string." }] };
    const client = createStoryAgentClient("/api", () => Promise.resolve(Response.json({ runId: "saved-failure", status: "failed", error: "Expected a string.", reason: "validation_failed", diagnostic }, { status: 500 })));
    await assert.rejects(() => client.createRun({ requirement: "Fixture requirement" }), (error: unknown) => {
        const failed = storyAgentFailureRun(error, "Fixture requirement");
        assert.equal(failed.runId, "saved-failure"); assert.equal(failed.requirement, "Fixture requirement");
        assert.equal(failed.diagnostic?.httpStatus, 500); assert.equal(failed.diagnostic?.stage, "repair"); assert.equal(failed.diagnostic?.retryable, false);
        const markup = renderToStaticMarkup(createElement(GenerationFeedback, { run: failed }));
        assert.match(markup, /saved-failure/); assert.match(markup, /Generation could not complete/); assert.match(markup, /initiative.epics.0.features.0.outcome/);
        assert.doesNotMatch(markup, /Quality &amp; refinement/); return true;
    });
});

for (const status of ["queued", "failed"] as const) test(`${status} data cannot retain a previous plan, passed quality or refinement controls`, () => {
    const stale = parseStoryAgentRun({ ...run, status, quality: { status: "passed", checks: [] }, refinements: [] });
    assert.equal(stale.plan, undefined); assert.equal(stale.stories, undefined); assert.equal(stale.quality, undefined); assert.equal(stale.refinements, undefined);
    const markup = renderToStaticMarkup(createElement(QualityReview, { run: stale, client: createStoryAgentClient("/api"), onUpdated: () => undefined }));
    assert.doesNotMatch(markup, /Quality &amp; refinement|Propose refinement/);
    assert.match(markup, /validated delivery plan is required/);
});

test("queued and processing feedback describes the saved run without implying a completed plan", async () => {
    const queued: StoryAgentRun = { runId: "saved-queue", requirement: "Fixture", status: "queued", diagnostic: { category: "provider_transport", reason: "provider_rate_limited", stage: "generate", retryable: true } };
    const markup = renderToStaticMarkup(createElement(GenerationFeedback, { run: queued }));
    assert.match(markup, /Automatic retry is scheduled/); assert.match(markup, /do not need to submit it again/);
    assert.equal(storyAgentStatusLabel(queued, 0), "In queue");
    assert.equal(storyAgentStatusLabel({ ...queued, lockedUntil: "1970-01-01T00:01:00.000Z" }, 0), "In progress");
    const client = createStoryAgentClient("/api", () => Promise.resolve(Response.json({ ...queued, lockedUntil: "1970-01-01T00:01:00.000Z" }, { status: 202 })));
    assert.equal(storyAgentStatusLabel(await client.createRun({ requirement: "Fixture" }), 0), "In progress");
});

test("completed generation does not display a failure or queue feedback panel", () => {
    assert.equal(renderToStaticMarkup(createElement(GenerationFeedback, { run })), "");
});

test("empty persisted draft cannot be mapped to a successful result", () => {
    assert.equal(parseStoryAgentRun({ runId: "empty", status: "draft", stories: [] }).status, "failed");
});

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

test("generation keeps transport and API failures visible without inventing a draft", async () => {
  const requirement = "Build an e-commerce platform where customers can browse products, add items to cart, and place orders. Admins can manage products and track orders.";
  const networkError = new TypeError("Failed to fetch");
  const disconnected = createStoryAgentClient("https://api.example.test", () => Promise.reject(networkError));
  await assert.rejects(disconnected.createRun({ requirement }), (error: unknown) => error === networkError);
  const unavailable = createStoryAgentClient("https://api.example.test", () => Promise.resolve(Response.json({ error: "provider_failed" }, { status: 500 })));
  await assert.rejects(unavailable.createRun({ requirement }), (error: unknown) => error instanceof Error && error.message === "provider_failed" && "status" in error && error.status === 500);
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

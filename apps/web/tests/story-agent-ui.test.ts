import test from "node:test";
import assert from "node:assert/strict";
import { buildStoryAgentRunCopyText, filterStoryAgentRuns, parseStoryAgentRun } from "../features/story-agent/story-agent.client";
import type { StoryAgentRun } from "../features/story-agent/story-agent.types";

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

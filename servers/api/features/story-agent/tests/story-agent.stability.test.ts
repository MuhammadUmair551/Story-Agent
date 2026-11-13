import test from "node:test";
import assert from "node:assert/strict";
import { createLlmGateway } from "../../../integrations/index.js";
import { createStoryAgentProviderRouter } from "../story-agent.router.js";
import { createStoryAgentService } from "../story-agent.service.js";
import { createStoryAgentQueue } from "../story-agent.queue.js";
import { withStoryApi } from "./story-agent.http-fixture.js";
import { plan } from "./story-agent.fixture.js";

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const budget = { maxCalls: 6, maxTotalTokens: 10000, timeoutMs: 60000, contextTokenLimit: 1000, maxStories: 10 };
const setup = (mode: "permanent" | "fallback" | "temporary") => {
  let now = 0; let recovered = false; let successes = 0;
  const calls: string[] = [];
  const gateway = createLlmGateway({ fetch: (url) => {
    const name = new URL(url).hostname.split(".")[0] ?? ""; calls.push(name);
    const status = name === "gemini" ? 404 : name === "ollama" ? 402 : mode === "permanent" ? 401 : mode === "temporary" && !recovered ? 429 : 200;
    if (status !== 200) return Promise.resolve(Response.json({ error: { message: "private-provider-response" } }, { status }));
    const output = successes++ % 2 === 0 ? { needsClarification: false, questions: [], assumptions: [] } : { plan };
    return Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  } });
  const route = createStoryAgentProviderRouter({
    config: { providers: ["gemini", "ollama", "groq"].map(name => ({ name, baseUrl: `https://${name}.example.test/v1`, model: "fixture", apiKey: "fixture-only", timeoutMs: 100 })), routes: { fast: ["gemini", "ollama", "groq"], generate: ["gemini", "ollama", "groq"], tools: ["gemini", "ollama", "groq"] }, cooldownMs: 60000 },
    createClient: gateway.createClient, logger, clock: { now: () => now }
  });
  return { service: createStoryAgentService({ route, now: () => now, budget }), calls, clock: { now: () => now }, recover: () => { now = 120000; recovered = true; } };
};

void test("real adapter/router fallback persists a complete result without failed-provider output leaking", async () => {
  const fixture = setup("fallback");
  await withStoryApi(fixture.service, async ({ request, repository }) => {
    const response = await request("/runs", "POST", { requirement: "Customers browse products, add to cart and place orders." });
    assert.equal(response.status, 200);
    const result = await response.json() as { runId: string; status: string };
    assert.equal(result.status, "draft");
    const stored = await repository.getRun(result.runId); const draft = await repository.getDraftByRun(result.runId);
    assert.deepEqual(stored?.providers, ["groq"]); assert.deepEqual(draft?.plan, plan);
    assert.doesNotMatch(JSON.stringify(stored), /private-provider-response/);
    assert.deepEqual(fixture.calls, ["gemini", "ollama", "groq", "gemini", "ollama", "groq"]);
  });
});

void test("all permanently rejected providers persist an honest terminal result instead of a retry queue", async () => {
  const fixture = setup("permanent");
  await withStoryApi(fixture.service, async ({ request, repository }) => {
    const response = await request("/runs", "POST", { requirement: "Customers place an order." });
    assert.equal(response.status, 503);
    const result = await response.json() as { runId: string; status: string; reason: string; error: string };
    assert.equal(result.status, "failed"); assert.equal(result.reason, "provider_rejected"); assert.match(result.error, /account limits/);
    assert.equal(await repository.countQueuedRuns(), 0); assert.equal(await repository.getDraftByRun(result.runId), null);
    assert.doesNotMatch(JSON.stringify(await repository.getRun(result.runId)), /private-provider-response/);
  });
});

void test("temporary provider failure queues once, recovers after cooldown and persists the final draft", async () => {
  const fixture = setup("temporary");
  await withStoryApi(fixture.service, async ({ request, repository }) => {
    const response = await request("/runs", "POST", { requirement: "Customers complete checkout." });
    assert.equal(response.status, 202);
    const result = await response.json() as { runId: string };
    assert.equal((await repository.getRun(result.runId))?.status, "queued");
    fixture.recover();
    const queue = createStoryAgentQueue({ repository, service: fixture.service, logger, clock: fixture.clock, intervalMs: 120000 });
    await queue.processNext();
    const stored = await repository.getRun(result.runId);
    assert.equal(stored?.status, "draft"); assert.equal(stored.reason, null); assert.equal(stored.error, null);
    assert.equal(stored.lockedUntil, null); assert.deepEqual(stored.providers, ["groq"]);
    assert.deepEqual((await repository.getDraftByRun(result.runId))?.plan, plan);
  });
});

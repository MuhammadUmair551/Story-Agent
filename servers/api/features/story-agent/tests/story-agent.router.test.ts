import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderConfig } from "../../../types/index.js";
import type { LlmClient, LlmCompletion, LlmTransportError } from "../../../integrations/index.js";
import {
  createStoryAgentProviderRouter,
  isStoryAgentRouterError,
  type StoryAgentProviderProfile
} from "../story-agent.router.js";

const provider = (name: string): ProviderConfig => ({ name, baseUrl: `https://${name}.example.test/v1`, apiKey: "test-key", model: "test", timeoutMs: 100 });
const result = (name: string): LlmCompletion => ({
  text: "{}", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, provider: name, model: "test"
});
const providerError = (kind: LlmTransportError["kind"]): LlmTransportError => Object.assign(new Error(kind), { kind });
const routes = (names: readonly string[]): Readonly<Record<StoryAgentProviderProfile, readonly string[]>> => ({ fast: names, generate: names, tools: names });

void test("fails over retryable provider failures and skips authentication failures", async () => {
  const calls: string[] = [];
  const warnings: string[] = [];
  const router = createStoryAgentProviderRouter({
    config: { providers: [provider("gemini"), provider("groq")], routes: routes(["gemini", "groq"]), cooldownMs: 100 },
    createClient: (config): LlmClient => ({
      complete: async () => {
        await Promise.resolve();
        calls.push(config.name);
        if (config.name === "gemini") throw providerError("auth");
        return result(config.name);
      }
    }),
    logger: { warn: (message): void => { warnings.push(message); } },
    clock: { now: () => 0 }
  });

  const completion = await router.complete({ profile: "generate", messages: [] });

  assert.equal(completion.provider, "groq");
  assert.deepEqual(calls, ["gemini", "groq"]);
  assert.equal(warnings.length, 1);
});


void test("fails over to the next provider after a retryable failure", async () => {
  const calls: string[] = [];
  const router = createStoryAgentProviderRouter({
    config: { providers: [provider("groq"), provider("gemini")], routes: routes(["groq", "gemini"]), cooldownMs: 100 },
    createClient: (config): LlmClient => ({
      complete: async () => {
        await Promise.resolve();
        calls.push(config.name);
        if (config.name === "groq") throw providerError("retryable");
        return result(config.name);
      }
    }),
    logger: { warn: (): void => undefined },
    clock: { now: () => 0 }
  });

  const completion = await router.complete({ profile: "generate", messages: [] });
  assert.equal(completion.provider, "gemini");
  assert.deepEqual(calls, ["groq", "gemini"]);
});


void test("fails over when a provider rejects a model-specific request", async () => {
  const calls: string[] = [];
  const router = createStoryAgentProviderRouter({
    config: { providers: [provider("groq"), provider("gemini")], routes: routes(["groq", "gemini"]), cooldownMs: 100 },
    createClient: (config): LlmClient => ({
      complete: async () => {
        await Promise.resolve();
        calls.push(config.name);
        if (config.name === "groq") throw providerError("bad-request");
        return result(config.name);
      }
    }),
    logger: { warn: (): void => undefined },
    clock: { now: () => 0 }
  });

  const completion = await router.complete({ profile: "generate", messages: [] });
  assert.equal(completion.provider, "gemini");
  assert.deepEqual(calls, ["groq", "gemini"]);
});

void test("opens a circuit after two failures, then permits one cooldown trial", async () => {
  let now = 0;
  let shouldSucceed = false;
  let calls = 0;
  const router = createStoryAgentProviderRouter({
    config: { providers: [provider("gemini")], routes: routes(["gemini"]), cooldownMs: 100 },
    createClient: (): LlmClient => ({
      complete: async () => {
        await Promise.resolve();
        calls += 1;
        if (!shouldSucceed) throw providerError("retryable");
        return result("gemini");
      }
    }),
    logger: { warn: (): void => undefined },
    clock: { now: () => now }
  });

  await assert.rejects(() => router.complete({ profile: "fast", messages: [] }));
  await assert.rejects(() => router.complete({ profile: "fast", messages: [] }));
  await assert.rejects(() => router.complete({ profile: "fast", messages: [] }));
  assert.equal(calls, 2);

  now = 100;
  shouldSucceed = true;
  assert.equal((await router.complete({ profile: "fast", messages: [] })).provider, "gemini");
  assert.equal(calls, 3);
});

void test("reports missing and exhausted provider routes", async () => {
  const dependencies = {
    createClient: (): LlmClient => ({
      complete: async () => {
        await Promise.resolve();
        return result("unused");
      }
    }),
    logger: { warn: (): void => undefined },
    clock: { now: () => 0 }
  };

  // Case 1: koi provider hi nahi
  const noConfig = createStoryAgentProviderRouter({
    config: { providers: [], routes: routes([]), cooldownMs: 100 },
    ...dependencies
  });

  // Case 2: provider hai, lekin us profile ka route empty
  const noRoute = createStoryAgentProviderRouter({
    config: { providers: [provider("gemini")], routes: routes([]), cooldownMs: 100 },
    ...dependencies
  });

  // Case 3: provider route me hai, lekin sab fail ho gaye
  const allFailed = createStoryAgentProviderRouter({
    config: { providers: [provider("gemini")], routes: routes(["gemini"]), cooldownMs: 100 },
    createClient: (): LlmClient => ({
      complete: async () => {
        await Promise.resolve();
        throw providerError("retryable");
      }
    }),
    logger: { warn: (): void => undefined },
    clock: { now: () => 0 }
  });

  // Assertions
  await assert.rejects(
    () => noConfig.complete({ profile: "tools", messages: [] }),
    (error: unknown): boolean => isStoryAgentRouterError(error) && error.code === "no_provider_configured"
  );

  await assert.rejects(
    () => noRoute.complete({ profile: "tools", messages: [] }),
    (error: unknown): boolean => isStoryAgentRouterError(error) && error.code === "no_provider_configured"
  );

  await assert.rejects(
    () => allFailed.complete({ profile: "tools", messages: [] }),
    (error: unknown): boolean => isStoryAgentRouterError(error) && error.code === "providers_unavailable"
  );
});

void test("permanent 404 and 402 rejection is terminal even while circuits cool down, but fallback can succeed", async () => {
  const calls: string[] = []; let recover = false;
  const diagnostics: string[] = [];
  const router = createStoryAgentProviderRouter({
    config: { providers: [provider("gemini"), provider("ollama")], routes: routes(["gemini", "ollama"]), cooldownMs: 100 },
    createClient: (config) => ({ complete: () => {
      calls.push(config.name);
      if (recover && config.name === "ollama") return Promise.resolve(result(config.name));
      return Promise.reject(Object.assign(new Error("private-provider-body"), { kind: "bad-request", status: config.name === "gemini" ? 404 : 402 }));
    } }), logger: { warn: (message, fields) => { diagnostics.push(JSON.stringify({ message, ...fields })); } }, clock: { now: () => recover ? 100 : 0 }
  });
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(() => router.complete({ profile: "generate", messages: [] }), (error: unknown) => isStoryAgentRouterError(error) && error.code === "provider_rejected");
  assert.equal(calls.length, 4);
  assert.match(diagnostics.join("\n"), /provider_payment_required/);
  assert.match(diagnostics.join("\n"), /provider_model_or_endpoint_unavailable/);
  assert.doesNotMatch(diagnostics.join("\n"), /private-provider-body/);
  recover = true; assert.equal((await router.complete({ profile: "generate", messages: [] })).provider, "ollama");
});

void test("an unexpected half-open error releases the trial so a later cooldown can recover", async () => {
  let now = 0; let calls = 0;
  const router = createStoryAgentProviderRouter({
    config: { providers: [provider("groq")], routes: routes(["groq"]), cooldownMs: 100 },
    createClient: () => ({ complete: () => { calls++; if (calls <= 2) return Promise.reject(providerError("retryable")); if (calls === 3) return Promise.reject(new Error("unexpected fixture failure")); return Promise.resolve(result("groq")); } }),
    logger: { warn: () => undefined }, clock: { now: () => now }
  });
  await assert.rejects(() => router.complete({ profile: "generate", messages: [] }));
  await assert.rejects(() => router.complete({ profile: "generate", messages: [] }));
  now = 100; await assert.rejects(() => router.complete({ profile: "generate", messages: [] }));
  now = 200; assert.equal((await router.complete({ profile: "generate", messages: [] })).provider, "groq");
});

import test from "node:test";
import assert from "node:assert/strict";
import { createLlmGateway, isLlmTransportError } from "../index.js";
import type { ProviderConfig } from "../../../types/index.js";

const config: ProviderConfig = {
  name: "test-provider",
  baseUrl: "https://provider.example.test/v1/",
  apiKey: "test-key",
  model: "test-model",
  timeoutMs: 100
};

void test("posts an OpenAI-compatible completion request and normalizes usage", async () => {
  let request: Readonly<{ url: string; init: RequestInit }> | undefined;
  const gateway = createLlmGateway({
    fetch: async (url, init): Promise<Response> => {
      await Promise.resolve();
      if (!init) throw new Error("Expected request initialization.");
      request = { url, init };
      return Response.json({ choices: [{ message: { content: "{\\\"stories\\\":[]}" } }], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } });
    }
  });

  const result = await gateway.createClient(config).complete({ messages: [{ role: "user", content: "Create stories" }] });

  assert.deepEqual(result, { text: "{\\\"stories\\\":[]}", usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 }, provider: "test-provider", model: "test-model" });
  assert.ok(request);
  assert.equal(request.url, "https://provider.example.test/v1/chat/completions");
  assert.equal((request.init.headers as Record<string, string>).Authorization, "Bearer test-key");
  if (typeof request.init.body !== "string") throw new Error("Expected a JSON request body.");
  assert.deepEqual(JSON.parse(request.init.body), { model: "test-model", messages: [{ role: "user", content: "Create stories" }] });
});

void test("classifies HTTP and malformed-response failures", async () => {
  const auth = createLlmGateway({ fetch: (): Promise<Response> => Promise.resolve(new Response("not authorized", { status: 401 })) });
  const retryable = createLlmGateway({ fetch: (): Promise<Response> => Promise.resolve(new Response("rate limited", { status: 429 })) });
  const badRequest = createLlmGateway({ fetch: (): Promise<Response> => Promise.resolve(new Response("invalid input", { status: 400 })) });
  const malformed = createLlmGateway({ fetch: (): Promise<Response> => Promise.resolve(new Response("not JSON")) });
  await assert.rejects(() => auth.createClient(config).complete({ messages: [] }), (error: unknown): boolean => isLlmTransportError(error) && error.kind === "auth" && error.status === 401);
  await assert.rejects(() => retryable.createClient(config).complete({ messages: [] }), (error: unknown): boolean => isLlmTransportError(error) && error.kind === "retryable" && error.status === 429);
  await assert.rejects(() => badRequest.createClient(config).complete({ messages: [] }), (error: unknown): boolean => isLlmTransportError(error) && error.kind === "bad-request" && error.status === 400);
  await assert.rejects(() => malformed.createClient(config).complete({ messages: [] }), (error: unknown): boolean => isLlmTransportError(error) && error.kind === "bad-request");
});

void test("classifies timeout aborts and fetch failures as retryable", async () => {
  const timeout = createLlmGateway({
    fetch: async (_url, init): Promise<Response> => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => { reject(new Error("request aborted")); });
    })
  });
  const unavailable = createLlmGateway({ fetch: (): Promise<Response> => Promise.reject(new Error("network unavailable")) });
  await assert.rejects(() => timeout.createClient({ ...config, timeoutMs: 1 }).complete({ messages: [] }), (error: unknown): boolean => isLlmTransportError(error) && error.kind === "retryable");
  await assert.rejects(() => unavailable.createClient(config).complete({ messages: [] }), (error: unknown): boolean => isLlmTransportError(error) && error.kind === "retryable");
});

void test("retains HTTP failure classification without exposing provider bodies or transport diagnostics", async () => {
  for (const status of [402, 404, 429, 503]) {
    const gateway = createLlmGateway({ fetch: () => Promise.resolve(new Response("private-provider-diagnostic", { status })) });
    await assert.rejects(() => gateway.createClient(config).complete({ messages: [] }), (error: unknown) => {
      assert.ok(isLlmTransportError(error)); assert.equal(error.status, status);
      assert.equal(error.kind, status >= 500 || status === 429 ? "retryable" : "bad-request");
      assert.doesNotMatch(error.message, /private-provider-diagnostic/); return true;
    });
  }
  const gateway = createLlmGateway({ fetch: () => Promise.reject(new Error("private-network-diagnostic")) });
  await assert.rejects(() => gateway.createClient(config).complete({ messages: [] }), (error: unknown) => {
    assert.ok(isLlmTransportError(error)); assert.doesNotMatch(error.message, /private-network-diagnostic/); return true;
  });
});

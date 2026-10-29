import test from "node:test";
import assert from "node:assert/strict";
import { ZodError } from "zod";
import { createApiConfig, readApiEnvironment, readProviderConfigs, readProviderRouterConfig } from "../config/index.js";

void test("derives API configuration from validated environment input", () => {
  const environment = readApiEnvironment({
    NODE_ENV: "production",
    API_HOST: "0.0.0.0",
    API_PORT: "8080",
    WEB_ORIGIN: "https://example.test",
    LOG_LEVEL: "warn"
  });
  assert.deepEqual(createApiConfig(environment), {
    environment: "production",
    host: "0.0.0.0",
    port: 8080,
    webOrigin: "https://example.test",
    logLevel: "warn",
    queueIntervalMs: 120_000,
    storyAgentMaxConcurrentRuns: 2,
    storyAgentMaxRequestsPerWindow: 6,
    storyAgentRequestWindowMs: 60_000,
    storyAgentMaxTrackedClients: 1_000
  });
});

void test("loads named providers and preserves the legacy provider environment", () => {
  const named = readApiEnvironment({
    NODE_ENV: "test", API_HOST: "127.0.0.1", API_PORT: "4000", WEB_ORIGIN: "http://localhost:3000", LOG_LEVEL: "silent",
    LLM_PROVIDERS: "gemini,groq",
    LLM_GEMINI_BASE_URL: "https://gemini.example.test/v1", LLM_GEMINI_API_KEY: "gemini-key", LLM_GEMINI_MODEL: "gemini-model", LLM_GEMINI_TIMEOUT_MS: "1000",
    LLM_GROQ_BASE_URL: "https://groq.example.test/v1", LLM_GROQ_API_KEY: "groq-key", LLM_GROQ_MODEL: "groq-model", LLM_GROQ_TIMEOUT_MS: "2000"
  });
  assert.deepEqual(readProviderConfigs(named).map(({ name, model }) => ({ name, model })), [
    { name: "gemini", model: "gemini-model" },
    { name: "groq", model: "groq-model" }
  ]);

  const legacy = readApiEnvironment({
    NODE_ENV: "test", API_HOST: "127.0.0.1", API_PORT: "4000", WEB_ORIGIN: "http://localhost:3000", LOG_LEVEL: "silent",
    LLM_BASE_URL: "https://legacy.example.test/v1", LLM_API_KEY: "legacy-key", LLM_MODEL: "legacy-model", LLM_TIMEOUT_MS: "3000"
  });
  assert.deepEqual(readProviderConfigs(legacy).map(({ name, model }) => ({ name, model })), [{ name: "default", model: "legacy-model" }]);
});

void test("loads profile routes and provider cooldown from environment", () => {
  const environment = readApiEnvironment({
    NODE_ENV: "test", API_HOST: "127.0.0.1", API_PORT: "4000", WEB_ORIGIN: "http://localhost:3000", LOG_LEVEL: "silent",
    LLM_PROVIDERS: "gemini,groq",
    LLM_GEMINI_BASE_URL: "https://gemini.example.test/v1", LLM_GEMINI_API_KEY: "gemini-key", LLM_GEMINI_MODEL: "gemini-model",
    LLM_GROQ_BASE_URL: "https://groq.example.test/v1", LLM_GROQ_API_KEY: "groq-key", LLM_GROQ_MODEL: "groq-model",
    LLM_PROFILE_FAST: "groq,gemini", LLM_PROFILE_GENERATE: "gemini", LLM_PROFILE_TOOLS: "groq", LLM_COOLDOWN_MS: "1234"
  });

  assert.deepEqual(readProviderRouterConfig(environment), {
    providers: [
      { name: "gemini", baseUrl: "https://gemini.example.test/v1", apiKey: "gemini-key", model: "gemini-model", timeoutMs: 30_000 },
      { name: "groq", baseUrl: "https://groq.example.test/v1", apiKey: "groq-key", model: "groq-model", timeoutMs: 30_000 }
    ],
    routes: { fast: ["groq", "gemini"], generate: ["gemini"], tools: ["groq"] },
    cooldownMs: 1234
  });
});

void test("rejects invalid server environment input", () => {
  assert.throws(() => readApiEnvironment({ API_PORT: "70000" }));
});

void test("requires runtime values from the environment", () => {
  assert.throws(() => readApiEnvironment({}), ZodError);
});

void test("accepts optional OTLP settings and rejects malformed endpoints", () => {
  const environment = readApiEnvironment({
    NODE_ENV: "test", API_HOST: "127.0.0.1", API_PORT: "4000", WEB_ORIGIN: "http://localhost:3000", LOG_LEVEL: "silent"
  });
  assert.equal(environment.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  assert.throws(() => readApiEnvironment({
    NODE_ENV: "test", API_HOST: "127.0.0.1", API_PORT: "4000", WEB_ORIGIN: "http://localhost:3000", LOG_LEVEL: "silent",
    OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-url"
  }), ZodError);
});

void test("accepts a hosting platform PORT when API_PORT is not set", () => {
  const environment = readApiEnvironment({
    NODE_ENV: "production", API_HOST: "0.0.0.0", PORT: "8080", WEB_ORIGIN: "https://web.example.test", LOG_LEVEL: "info"
  });
  assert.equal(environment.API_PORT, 8080);
});

void test("hosting platform PORT takes precedence over API_PORT", () => {
  const environment = readApiEnvironment({
    NODE_ENV: "production", API_HOST: "0.0.0.0", PORT: "8080", API_PORT: "4000", WEB_ORIGIN: "https://web.example.test", LOG_LEVEL: "info"
  });
  assert.equal(environment.API_PORT, 8080);
});


void test("loads the named, legacy fallback, and Ollama alias providers", () => {
  const environment = readApiEnvironment({
    NODE_ENV: "test", API_HOST: "127.0.0.1", API_PORT: "4000", WEB_ORIGIN: "http://localhost:3000", LOG_LEVEL: "silent",
    LLM_PROVIDERS: "groq,gemini,ollama",
    LLM_GROQ_BASE_URL: "https://api.groq.com/openai/v1", LLM_GROQ_API_KEY: "groq-key", LLM_GROQ_MODEL: "groq-model",
    LLM_GEMINI_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai", LLM_GEMINI_API_KEY: "gemini-key", LLM_GEMINI_MODEL: "gemini-model",
    FALLBACK_LLM_BASE_URL: "https://api.groq.com/openai/v1", FALLBACK_LLM_API_KEY: "duplicate-key", FALLBACK_LLM_MODEL: "duplicate-model",
    OLLAMA_BASE_FREE_URL: "https://ollama.com/v1", OLLAMA_API_KEY: "ollama-key", OLLAMA_FREE_MODEL: "ollama-model"
  });

  assert.deepEqual(readProviderConfigs(environment).map(({ name, model }) => ({ name, model })), [
    { name: "groq", model: "groq-model" },
    { name: "gemini", model: "gemini-model" },
    { name: "ollama", model: "ollama-model" },
    { name: "fallback", model: "duplicate-model" },
  ]);
});

void test("treats blank optional provider variables as unset", () => {
  const environment = readApiEnvironment({
    NODE_ENV: "test", API_HOST: "127.0.0.1", API_PORT: "4000", WEB_ORIGIN: "http://localhost:3000", LOG_LEVEL: "silent",
    LLM_BASE_URL: "", LLM_API_KEY: "", LLM_MODEL: "",
    FALLBACK_LLM_BASE_URL: "", FALLBACK_LLM_API_KEY: "", FALLBACK_LLM_MODEL: "",
    OLLAMA_BASE_FREE_URL: "", OLLAMA_API_KEY: "", OLLAMA_FREE_MODEL: ""
  });

  assert.deepEqual(readProviderConfigs(environment), []);
});

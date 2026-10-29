import { z } from "zod";
import type { ValidatedApiEnvironment } from "../types/index.js";

export const apiEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  API_HOST: z.string().min(1),
  API_PORT: z.coerce.number().int().min(1).max(65_535),
  WEB_ORIGIN: z.url(),
  MONGODB_URI: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),
  LLM_PROVIDERS: z.string().min(1).optional(),
  LLM_BASE_URL: z.url().optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().min(1).optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  FALLBACK_LLM_BASE_URL: z.url().optional(),
  FALLBACK_LLM_API_KEY: z.string().min(1).optional(),
  FALLBACK_LLM_MODEL: z.string().min(1).optional(),
  OLLAMA_BASE_FREE_URL: z.url().optional(),
  OLLAMA_API_KEY: z.string().min(1).optional(),
  OLLAMA_FREE_MODEL: z.string().min(1).optional(),
  LLM_GEMINI_BASE_URL: z.url().optional(),
  LLM_GEMINI_API_KEY: z.string().min(1).optional(),
  LLM_GEMINI_MODEL: z.string().min(1).optional(),
  LLM_GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  LLM_GROQ_BASE_URL: z.url().optional(),
  LLM_GROQ_API_KEY: z.string().min(1).optional(),
  LLM_GROQ_MODEL: z.string().min(1).optional(),
  LLM_GROQ_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  LLM_OLLAMA_BASE_URL: z.url().optional(),
  LLM_OLLAMA_API_KEY: z.string().min(1).optional(),
  LLM_OLLAMA_MODEL: z.string().min(1).optional(),
  LLM_OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  LLM_PROFILE_FAST: z.string().min(1).optional(),
  LLM_PROFILE_GENERATE: z.string().min(1).optional(),
  LLM_PROFILE_TOOLS: z.string().min(1).optional(),
  LLM_COOLDOWN_MS: z.coerce.number().int().positive().optional(),
  QUEUE_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  STORY_AGENT_MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().optional(),
  STORY_AGENT_MAX_REQUESTS_PER_WINDOW: z.coerce.number().int().positive().optional(),
  STORY_AGENT_REQUEST_WINDOW_MS: z.coerce.number().int().positive().optional(),
  STORY_AGENT_MAX_TRACKED_CLIENTS: z.coerce.number().int().positive().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), "OTLP endpoint must use HTTP or HTTPS.").optional(),
  OTEL_EXPORTER_OTLP_HEADERS: z.string().max(2_048).optional(),
  OTEL_SERVICE_NAME: z.string().min(1).max(64).optional()
}) satisfies z.ZodType<ValidatedApiEnvironment>;

export const validateApiEnvironment = (input: unknown): ValidatedApiEnvironment => {
  const normalized = typeof input === "object" && input !== null && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value === "" ? undefined : value]))
    : input;
  return Object.freeze(apiEnvironmentSchema.parse(normalized));
};

import { z } from "zod";
import type { ProviderConfig, ValidatedApiEnvironment } from "../types/index.js";

const providerNames = ["gemini", "groq", "ollama"] as const;
type ProviderName = (typeof providerNames)[number];
const defaultProviderTimeoutMs = 30_000;
const defaultCooldownMs = 60_000;

export type ProviderProfile = "fast" | "generate" | "tools";
export type ProviderRouterConfig = Readonly<{
  providers: readonly ProviderConfig[];
  routes: Readonly<Record<ProviderProfile, readonly string[]>>;
  cooldownMs: number;
}>;

type ProviderEnvironment = Readonly<{
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  timeoutMs?: number | undefined;
}>;

const providerEnvironmentSchema = z.object({
  baseUrl: z.url(),
  apiKey: z.string().min(1),
  model: z.string().min(1).max(128),
  timeoutMs: z.number().int().positive().optional()
});

const parseProviderNames = (value: string | undefined): readonly ProviderName[] => {
  if (!value) return [];
  return value.split(",").map((name) => z.enum(providerNames).parse(name.trim().toLowerCase()));
};

const namedEnvironment = (environment: ValidatedApiEnvironment, name: ProviderName): ProviderEnvironment => {
  if (name === "gemini") return {
    baseUrl: environment.LLM_GEMINI_BASE_URL,
    apiKey: environment.LLM_GEMINI_API_KEY,
    model: environment.LLM_GEMINI_MODEL,
    timeoutMs: environment.LLM_GEMINI_TIMEOUT_MS
  };
  if (name === "groq") return {
    baseUrl: environment.LLM_GROQ_BASE_URL,
    apiKey: environment.LLM_GROQ_API_KEY,
    model: environment.LLM_GROQ_MODEL,
    timeoutMs: environment.LLM_GROQ_TIMEOUT_MS
  };
  return {
    baseUrl: environment.LLM_OLLAMA_BASE_URL ?? environment.OLLAMA_BASE_FREE_URL,
    apiKey: environment.LLM_OLLAMA_API_KEY ?? environment.OLLAMA_API_KEY,
    model: environment.LLM_OLLAMA_MODEL ?? environment.OLLAMA_FREE_MODEL,
    timeoutMs: environment.LLM_OLLAMA_TIMEOUT_MS
  };
};

const toProviderConfig = (name: string, environment: ProviderEnvironment): ProviderConfig => {
  const parsed = providerEnvironmentSchema.parse(environment);
  return Object.freeze({ name, ...parsed, timeoutMs: parsed.timeoutMs ?? defaultProviderTimeoutMs });
};

const inferredProviderName = (baseUrl: string): string => {
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (host.includes("groq")) return "groq";
  if (host.includes("google") || host.includes("gemini")) return "gemini";
  if (host.includes("ollama")) return "ollama";
  return "default";
};

const hasProviderCredentials = (provider: ProviderEnvironment): boolean =>
  Boolean(provider.baseUrl && provider.apiKey && provider.model);

const routeProviderNames = (value: string | undefined, fallback: readonly string[]): readonly string[] => {
  const names = value ? value.split(",").map((name) => name.trim()).filter(Boolean) : fallback;
  return Object.freeze([...new Set(names)]);
};

export const readProviderConfigs = (environment: ValidatedApiEnvironment): readonly ProviderConfig[] => {
  const configured: ProviderConfig[] = [];
  const add = (name: string, values: ProviderEnvironment): void => {
    if (configured.some((provider) => provider.name === name) || !hasProviderCredentials(values)) return;
    configured.push(toProviderConfig(name, values));
  };

  for (const name of parseProviderNames(environment.LLM_PROVIDERS)) {
    add(name, namedEnvironment(environment, name));
  }

  const legacy: ProviderEnvironment = {
    baseUrl: environment.LLM_BASE_URL,
    apiKey: environment.LLM_API_KEY,
    model: environment.LLM_MODEL,
    timeoutMs: environment.LLM_TIMEOUT_MS
  };
  if (hasProviderCredentials(legacy)) add(inferredProviderName(legacy.baseUrl ?? ""), legacy);

  const fallback: ProviderEnvironment = {
    baseUrl: environment.FALLBACK_LLM_BASE_URL,
    apiKey: environment.FALLBACK_LLM_API_KEY,
    model: environment.FALLBACK_LLM_MODEL
  };
  if (hasProviderCredentials(fallback)) add("fallback", fallback);

  const ollama: ProviderEnvironment = {
    baseUrl: environment.LLM_OLLAMA_BASE_URL ?? environment.OLLAMA_BASE_FREE_URL,
    apiKey: environment.LLM_OLLAMA_API_KEY ?? environment.OLLAMA_API_KEY,
    model: environment.LLM_OLLAMA_MODEL ?? environment.OLLAMA_FREE_MODEL,
    timeoutMs: environment.LLM_OLLAMA_TIMEOUT_MS
  };
  if (hasProviderCredentials(ollama)) add("ollama", ollama);

  return Object.freeze(configured);
};

export const readProviderRouterConfig = (environment: ValidatedApiEnvironment): ProviderRouterConfig => {
  const providers = readProviderConfigs(environment);
  const fallback = providers.map(({ name }) => name);
  return Object.freeze({
    providers,
    routes: Object.freeze({
      fast: routeProviderNames(environment.LLM_PROFILE_FAST, fallback),
      generate: routeProviderNames(environment.LLM_PROFILE_GENERATE, fallback),
      tools: routeProviderNames(environment.LLM_PROFILE_TOOLS, fallback)
    }),
    cooldownMs: environment.LLM_COOLDOWN_MS ?? defaultCooldownMs
  });
};

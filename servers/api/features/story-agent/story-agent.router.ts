import type { Logger } from "@workspace/logging";
import type { ProviderConfig } from "../../types/index.js";
import { isLlmTransportError, type LlmChatMessage, type LlmClient, type LlmCompletion, type LlmTransportError, type LlmOutputContract } from "../../integrations/index.js";
import { executionCorrelation, type StoryAgentExecution } from "./story-agent.execution.js";
import { recordLlmRequest, recordProviderDecision, withStorySpan } from "./story-agent.telemetry.js";

export type StoryAgentProviderProfile = "fast" | "generate" | "tools";
export type StoryAgentRouterError = Error & Readonly<{ code: "providers_unavailable" | "no_provider_configured" | "provider_rejected" | "unsupported_structured_output" | "malformed_provider_response"; provider?: string; model?: string; retryAfterMs?: number; causeCode?: string }>;
export type StoryAgentRouterConfig = Readonly<{ providers: readonly ProviderConfig[]; routes: Readonly<Record<StoryAgentProviderProfile, readonly string[]>>; cooldownMs: number }>;
type ProviderState = { consecutiveFailures: number; cooldownUntil?: number | undefined; trialInFlight: boolean; lastFailure?: LlmTransportError["kind"] | undefined };
type Clock = Readonly<{ now: () => number }>;
type RouterDependencies = Readonly<{ config: StoryAgentRouterConfig; createClient: (config: ProviderConfig) => LlmClient; logger: Pick<Logger, "warn"> & Partial<Pick<Logger, "info">>; clock: Clock }>;
type CompletionInput = Readonly<{ profile: StoryAgentProviderProfile; messages: readonly LlmChatMessage[]; outputContract?: LlmOutputContract | undefined;
  excludeProviders?: readonly string[] | undefined; requireStructuredOutput?: boolean | undefined; execution?: StoryAgentExecution | undefined; stage?: string | undefined;
  beforeAttempt?: ((provider: ProviderConfig) => Promise<Readonly<{ timeoutMs: number; attempt: number }>>) | undefined;
  onFailure?: ((failure: Readonly<{ provider: string; model: string; code: string; status?: number | undefined }>) => Promise<void>) | undefined }>;
export type StoryAgentProviderRouter = Readonly<{ complete: (input: CompletionInput) => Promise<LlmCompletion> }>;

const unavailable = (code: StoryAgentRouterError["code"], message: string): StoryAgentRouterError => Object.assign(new Error(message), { code });
export const isStoryAgentRouterError = (error: unknown): error is StoryAgentRouterError => error instanceof Error && "code" in error && ["providers_unavailable", "no_provider_configured", "provider_rejected", "unsupported_structured_output", "malformed_provider_response"].includes(String(error.code));

export const createStoryAgentProviderRouter = ({ config, createClient, logger, clock }: RouterDependencies): StoryAgentProviderRouter => {
  const providers = new Map(config.providers.map((provider) => [provider.name, provider]));
  const states = new Map<string, ProviderState>();
  const stateFor = (name: string): ProviderState => states.get(name) ?? (() => { const state = { consecutiveFailures: 0, trialInFlight: false }; states.set(name, state); return state; })();
  const eligible = (name: string): boolean => { const state = stateFor(name); if (state.cooldownUntil === undefined) return true; if (clock.now() < state.cooldownUntil || state.trialInFlight) return false; state.trialInFlight = true; return true; };
  const succeed = (state: ProviderState): void => { state.consecutiveFailures = 0; state.cooldownUntil = undefined; state.trialInFlight = false; state.lastFailure = undefined; };
  const fail = (name: string, state: ProviderState, kind: LlmTransportError["kind"]): void => { state.consecutiveFailures += 1; state.trialInFlight = false; state.lastFailure = kind; if (state.consecutiveFailures >= 2) { state.cooldownUntil = clock.now() + config.cooldownMs; recordProviderDecision("circuit_open"); logger.warn("Story Agent provider circuit opened.", { provider: name, cooldownMs: config.cooldownMs }); } };
  return Object.freeze({ complete: async ({ profile, messages, outputContract, excludeProviders, requireStructuredOutput, execution, stage, beforeAttempt, onFailure }): Promise<LlmCompletion> => {
    const route = config.routes[profile];
    if (route.length === 0) throw unavailable("no_provider_configured", `No providers configured for profile: ${profile}`);
    let previousProviderFailed = false;
    let configured = false;
    let temporaryFailure = false;
    let incompatible = false;
    let lastFailure: Readonly<{ provider: string; model: string; causeCode: string }> | undefined;
    let retryAfterMs = 0;
    for (const name of route) {
      const provider = providers.get(name);
      if (provider === undefined) { logger.warn("Story Agent route references unconfigured provider.", { provider: name }); continue; }
      configured = true;
      if (excludeProviders?.includes(name)) continue;
      const client = createClient(provider);
      if (requireStructuredOutput && !client.capabilities?.strictJsonSchema) { incompatible = true; continue; }
      const state = stateFor(name);
      if (!eligible(name)) { recordProviderDecision("circuit_skip"); temporaryFailure ||= state.lastFailure === "retryable" || state.trialInFlight; continue; }
      if (previousProviderFailed) recordProviderDecision("failover");
      previousProviderFailed = false;
      const startedAt = clock.now();
      // Admission is deliberately outside the transport catch: budget/lease/checkpoint
      // failures must never be misclassified as provider errors or trigger fan-out.
      let admission: Awaited<ReturnType<NonNullable<CompletionInput["beforeAttempt"]>>> | undefined;
      try { admission = await beforeAttempt?.(provider); }
      catch (error: unknown) { state.trialInFlight = false; throw error; }
      const fields = { ...executionCorrelation(execution), stage: stage ?? profile, providerAttempt: admission?.attempt, provider: name, model: provider.model, profile };
      try {
        const result = await withStorySpan("story_agent.llm.request", { "gen_ai.provider.name": provider.name, "gen_ai.request.model": provider.model, ...executionCorrelation(execution), stage: stage ?? profile, ...(admission ? { providerAttempt: admission.attempt } : {}) }, async (span) => {
          const completion = await client.complete({ messages, outputContract, requireStructuredOutput, timeoutMs: admission?.timeoutMs });
          span.setAttribute("outcome", "success");
          return completion;
        });
        recordLlmRequest(provider.name, provider.model, "success", clock.now() - startedAt);
        succeed(state);
        logger.info?.("Story Agent provider request succeeded.", { ...fields, finishReason: result.finishReason ?? "unknown" });
        return result;
      }
      catch (error: unknown) {
        recordLlmRequest(provider.name, provider.model, "error", clock.now() - startedAt);
        if (!isLlmTransportError(error)) { fail(name, state, "retryable"); throw error; }
        temporaryFailure ||= error.kind === "retryable";
        lastFailure = { provider: name, model: provider.model, causeCode: error.code ?? (error.kind === "auth" ? "provider_auth_failed" : error.kind === "retryable" ? "provider_temporarily_unavailable" : "provider_request_rejected") };
        retryAfterMs = Math.max(retryAfterMs, error.retryAfterMs ?? 0);
        previousProviderFailed = true;
        fail(name, state, error.kind);
        const reasonCode = error.status === 402 ? "provider_payment_required" : error.status === 404 ? "provider_model_or_endpoint_unavailable" : error.kind === "auth" ? "provider_auth_failed" : error.kind === "retryable" ? "provider_temporarily_unavailable" : "provider_request_rejected";
        logger.warn("Story Agent provider request failed; trying the next provider.", { ...fields, status: error.status, reasonCode, causeCode: lastFailure.causeCode });
        await onFailure?.({ provider: name, model: provider.model, code: lastFailure.causeCode, status: error.status });
        if (error.kind === "retryable") recordProviderDecision("retryable_failure");
      }
    }
    if (!configured) throw unavailable("no_provider_configured", "The route has no configured provider.");
    if (temporaryFailure) throw Object.assign(unavailable("providers_unavailable", "Story Agent providers are temporarily unavailable."), lastFailure, { retryAfterMs });
    if (lastFailure?.causeCode === "malformed_provider_response") throw Object.assign(unavailable("malformed_provider_response", "Providers returned unusable response envelopes."), lastFailure);
    if (incompatible || (requireStructuredOutput && excludeProviders?.length && !lastFailure)) throw unavailable("unsupported_structured_output", "No independent compatible provider is available for content recovery.");
    throw Object.assign(unavailable("provider_rejected", "Configured providers rejected the request. Check model availability, credentials and account limits."), lastFailure);
  } });
};

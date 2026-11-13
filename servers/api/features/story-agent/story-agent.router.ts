import type { Logger } from "@workspace/logging";
import type { ProviderConfig } from "../../types/index.js";
import { isLlmTransportError, type LlmChatMessage, type LlmClient, type LlmCompletion, type LlmTransportError } from "../../integrations/index.js";
import { recordLlmRequest, recordProviderDecision, withStorySpan } from "./story-agent.telemetry.js";

export type StoryAgentProviderProfile = "fast" | "generate" | "tools";
export type StoryAgentRouterError = Error & Readonly<{ code: "providers_unavailable" | "no_provider_configured" | "provider_rejected" }>;
export type StoryAgentRouterConfig = Readonly<{ providers: readonly ProviderConfig[]; routes: Readonly<Record<StoryAgentProviderProfile, readonly string[]>>; cooldownMs: number }>;
type ProviderState = { consecutiveFailures: number; cooldownUntil?: number | undefined; trialInFlight: boolean; lastFailure?: LlmTransportError["kind"] | undefined };
type Clock = Readonly<{ now: () => number }>;
type RouterDependencies = Readonly<{ config: StoryAgentRouterConfig; createClient: (config: ProviderConfig) => LlmClient; logger: Pick<Logger, "warn"> & Partial<Pick<Logger, "info">>; clock: Clock }>;
export type StoryAgentProviderRouter = Readonly<{ complete: (input: Readonly<{ profile: StoryAgentProviderProfile; messages: readonly LlmChatMessage[] }>) => Promise<LlmCompletion> }>;

const unavailable = (code: StoryAgentRouterError["code"], message: string): StoryAgentRouterError => Object.assign(new Error(message), { code });
export const isStoryAgentRouterError = (error: unknown): error is StoryAgentRouterError => error instanceof Error && "code" in error && (error.code === "providers_unavailable" || error.code === "no_provider_configured" || error.code === "provider_rejected");

export const createStoryAgentProviderRouter = ({ config, createClient, logger, clock }: RouterDependencies): StoryAgentProviderRouter => {
  const providers = new Map(config.providers.map((provider) => [provider.name, provider]));
  const states = new Map<string, ProviderState>();
  const stateFor = (name: string): ProviderState => states.get(name) ?? (() => { const state = { consecutiveFailures: 0, trialInFlight: false }; states.set(name, state); return state; })();
  const eligible = (name: string): boolean => { const state = stateFor(name); if (state.cooldownUntil === undefined) return true; if (clock.now() < state.cooldownUntil || state.trialInFlight) return false; state.trialInFlight = true; return true; };
  const succeed = (state: ProviderState): void => { state.consecutiveFailures = 0; state.cooldownUntil = undefined; state.trialInFlight = false; state.lastFailure = undefined; };
  const fail = (name: string, state: ProviderState, kind: LlmTransportError["kind"]): void => { state.consecutiveFailures += 1; state.trialInFlight = false; state.lastFailure = kind; if (state.consecutiveFailures >= 2) { state.cooldownUntil = clock.now() + config.cooldownMs; recordProviderDecision("circuit_open"); logger.warn("Story Agent provider circuit opened.", { provider: name, cooldownMs: config.cooldownMs }); } };
  return Object.freeze({ complete: async ({ profile, messages }): Promise<LlmCompletion> => {
    const route = config.routes[profile];
    if (route.length === 0) throw unavailable("no_provider_configured", `No providers configured for profile: ${profile}`);
    let previousProviderFailed = false;
    let configured = false;
    let temporaryFailure = false;
    for (const name of route) {
      const provider = providers.get(name);
      if (provider === undefined) { logger.warn("Story Agent route references unconfigured provider.", { provider: name }); continue; }
      configured = true;
      const state = stateFor(name);
      if (!eligible(name)) { recordProviderDecision("circuit_skip"); temporaryFailure ||= state.lastFailure === "retryable" || state.trialInFlight; continue; }
      if (previousProviderFailed) recordProviderDecision("failover");
      previousProviderFailed = false;
      const startedAt = clock.now();
      try {
        const result = await withStorySpan("story_agent.llm.request", { "gen_ai.provider.name": provider.name, "gen_ai.request.model": provider.model }, async (span) => {
          const completion = await createClient(provider).complete({ messages });
          span.setAttribute("outcome", "success");
          return completion;
        });
        recordLlmRequest(provider.name, provider.model, "success", clock.now() - startedAt);
        succeed(state);
        logger.info?.("Story Agent provider request succeeded.", { provider: name, model: provider.model, profile });
        return result;
      }
      catch (error: unknown) {
        recordLlmRequest(provider.name, provider.model, "error", clock.now() - startedAt);
        if (!isLlmTransportError(error)) { fail(name, state, "retryable"); throw error; }
        temporaryFailure ||= error.kind === "retryable";
        previousProviderFailed = true;
        fail(name, state, error.kind);
        const reasonCode = error.status === 402 ? "provider_payment_required" : error.status === 404 ? "provider_model_or_endpoint_unavailable" : error.kind === "auth" ? "provider_auth_failed" : error.kind === "retryable" ? "provider_temporarily_unavailable" : "provider_request_rejected";
        logger.warn("Story Agent provider request failed; trying the next provider.", { provider: name, model: provider.model, profile, status: error.status, reasonCode });
        if (error.kind === "retryable") recordProviderDecision("retryable_failure");
      }
    }
    if (!configured) throw unavailable("no_provider_configured", "The route has no configured provider.");
    if (temporaryFailure) throw unavailable("providers_unavailable", "All Story Agent providers are temporarily unavailable.");
    throw unavailable("provider_rejected", "Configured providers rejected the request. Check model availability, credentials and provider quota.");
  } });
};

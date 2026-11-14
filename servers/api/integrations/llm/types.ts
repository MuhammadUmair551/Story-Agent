import type { ProviderConfig } from "../../types/index.js";

export type LlmChatMessage = Readonly<{
  role: "system" | "user" | "assistant";
  content: string;
}>;

export type LlmUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}>;

export type LlmCompletion = Readonly<{
  text: string;
  usage: LlmUsage;
  provider: string;
  model: string;
  finishReason?: "stop" | "length" | "content_filter" | "tool_calls" | "unknown" | undefined;
}>;

export type LlmOutputContract = Readonly<{ name: string; schema: Readonly<Record<string, unknown>> }>;
export type LlmFailureCode = "provider_auth_failed" | "provider_account_restricted" | "provider_model_unavailable" | "provider_rate_limited" | "provider_timeout" | "provider_network_failed" | "provider_server_error" | "provider_request_rejected" | "malformed_provider_response" | "unsupported_structured_output";

export type LlmTransportError = Error & Readonly<{
  kind: "retryable" | "auth" | "bad-request" | "invalid-response" | "unsupported";
  status?: number | undefined;
  code?: LlmFailureCode | undefined;
  retryAfterMs?: number | undefined;
}>;

export type LlmClient = Readonly<{
  capabilities?: Readonly<{ strictJsonSchema: boolean }>;
  complete: (input: Readonly<{ messages: readonly LlmChatMessage[]; outputContract?: LlmOutputContract | undefined; requireStructuredOutput?: boolean | undefined; timeoutMs?: number | undefined }>) => Promise<LlmCompletion>;
}>;

export type LlmGateway = Readonly<{
  createClient: (config: ProviderConfig) => LlmClient;
}>;

export type LlmFetch = (input: string, init?: RequestInit) => Promise<Response>;

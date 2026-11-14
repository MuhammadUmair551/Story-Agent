import type { ProviderConfig } from "../../types/index.js";
import type { LlmClient, LlmCompletion, LlmFetch, LlmGateway, LlmTransportError, LlmUsage } from "./types.js";
import { providerCapabilities } from "./capabilities.js";

type OpenAiCompatibleGatewayDependencies = Readonly<{ fetch: LlmFetch }>;

const transportError = (
  kind: LlmTransportError["kind"],
  message: string,
  status?: number,
  code?: LlmTransportError["code"],
  retryAfterMs?: number
): LlmTransportError => Object.freeze(Object.assign(new Error(message), {
  kind,
  ...(status === undefined ? {} : { status }),
  ...(code === undefined ? {} : { code }),
  ...(retryAfterMs === undefined ? {} : { retryAfterMs })
}));

export const isLlmTransportError = (error: unknown): error is LlmTransportError =>
  typeof error === "object" && error !== null && "kind" in error
    && ["retryable", "auth", "bad-request", "invalid-response", "unsupported"].includes(String(error.kind));

const errorKindForStatus = (status: number): LlmTransportError["kind"] => {
  if (status === 401 || status === 403) return "auth";
  if (status === 429 || status >= 500) return "retryable";
  return "bad-request";
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const failureCode = (status: number): LlmTransportError["code"] => status === 401 || status === 403 ? "provider_auth_failed"
  : status === 402 ? "provider_account_restricted" : status === 404 ? "provider_model_unavailable"
  : status === 429 ? "provider_rate_limited" : status >= 500 ? "provider_server_error" : "provider_request_rejected";
const retryDelay = (response: Response): number | undefined => {
  const value = response.headers.get("Retry-After");
  if (!value) return undefined;
  const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.min(30 * 60_000, Math.max(0, delay)) : undefined;
};
const readCompletion = async (response: Response): Promise<Readonly<{ text: string; usage: LlmUsage; finishReason?: LlmCompletion["finishReason"] }>> => {
  // Reading can fail after headers arrive; keep transport/abort failures distinct
  // from a fully received but malformed JSON envelope.
  const body = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    throw transportError("invalid-response", "Provider returned an invalid response envelope.", undefined, "malformed_provider_response");
  }
  const record = asRecord(payload);
  if (!record) throw transportError("invalid-response", "Provider returned an invalid response envelope.", undefined, "malformed_provider_response");
  const choices = Array.isArray(record.choices) ? record.choices as unknown[] : [];
  const message = asRecord(choices[0])?.message;
  const text = asRecord(message)?.content;
  if (typeof text !== "string") throw transportError("invalid-response", "Provider response does not contain text content.", undefined, "malformed_provider_response");
  const finish = asRecord(choices[0])?.finish_reason;
  const finishReason = finish === "stop" || finish === "length" || finish === "content_filter" || finish === "tool_calls" ? finish : "unknown";
  const usage = asRecord(record.usage) ?? {};
  const numberAt = (key: string): number => typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key] : 0;
  return Object.freeze({
    text,
    ...(finish === undefined ? {} : { finishReason }),
    usage: Object.freeze({
      inputTokens: numberAt("prompt_tokens"),
      outputTokens: numberAt("completion_tokens"),
      totalTokens: numberAt("total_tokens")
    })
  });
};

const createClient = (config: ProviderConfig, fetcher: LlmFetch): LlmClient => Object.freeze({
  capabilities: providerCapabilities(config),
  complete: async ({ messages, outputContract, requireStructuredOutput, timeoutMs }: Parameters<LlmClient["complete"]>[0]): Promise<LlmCompletion> => {
    const supported = providerCapabilities(config).strictJsonSchema;
    if (requireStructuredOutput && !supported) throw transportError("unsupported", "Provider does not support the required output contract.", undefined, "unsupported_structured_output");
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, Math.min(config.timeoutMs, timeoutMs ?? config.timeoutMs));
    try {
      const response = await fetcher(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, messages, ...(outputContract && supported ? {
          response_format: { type: "json_schema", json_schema: { name: outputContract.name, strict: true, schema: outputContract.schema } }
        } : {}) }),
        signal: controller.signal
      });
      if (!response.ok) {
        // Upstream bodies can contain credentials, prompts or private request diagnostics.
        await response.body?.cancel().catch(() => undefined);
        throw transportError(errorKindForStatus(response.status), `Provider request failed with status ${String(response.status)}.`, response.status, failureCode(response.status), retryDelay(response));
      }
      const completion = await readCompletion(response);
      return Object.freeze({ ...completion, provider: config.name, model: config.model });
    } catch (error: unknown) {
      if (isLlmTransportError(error)) throw error;
      throw transportError("retryable", controller.signal.aborted ? "Provider request timed out." : "Provider transport failed.", undefined, controller.signal.aborted ? "provider_timeout" : "provider_network_failed");
    } finally {
      clearTimeout(timeout);
    }
  }
});

export const createOpenAiCompatibleLlmGateway = ({ fetch }: OpenAiCompatibleGatewayDependencies): LlmGateway =>
  Object.freeze({ createClient: (config) => createClient(config, fetch) });

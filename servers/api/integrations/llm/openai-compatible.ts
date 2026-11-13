import type { ProviderConfig } from "../../types/index.js";
import type { LlmChatMessage, LlmClient, LlmCompletion, LlmFetch, LlmGateway, LlmTransportError, LlmUsage } from "./types.js";

type OpenAiCompatibleGatewayDependencies = Readonly<{ fetch: LlmFetch }>;

const transportError = (
  kind: LlmTransportError["kind"],
  message: string,
  status?: number
): LlmTransportError => Object.freeze(Object.assign(new Error(message), {
  kind,
  ...(status === undefined ? {} : { status })
}));

export const isLlmTransportError = (error: unknown): error is LlmTransportError =>
  typeof error === "object" && error !== null && "kind" in error
    && ["retryable", "auth", "bad-request"].includes(String(error.kind));

const errorKindForStatus = (status: number): LlmTransportError["kind"] => {
  if (status === 401 || status === 403) return "auth";
  if (status === 429 || status >= 500) return "retryable";
  return "bad-request";
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const readCompletion = async (response: Response): Promise<Readonly<{ text: string; usage: LlmUsage }>> => {
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch {
    throw transportError("bad-request", "Provider returned invalid JSON.");
  }
  const record = asRecord(payload);
  if (!record) throw transportError("bad-request", "Provider returned an invalid response.");
  const choices = Array.isArray(record.choices) ? record.choices as unknown[] : [];
  const message = asRecord(choices[0])?.message;
  const text = asRecord(message)?.content;
  if (typeof text !== "string") throw transportError("bad-request", "Provider response does not contain message content.");
  const usage = asRecord(record.usage) ?? {};
  const numberAt = (key: string): number => typeof usage[key] === "number" ? usage[key] : 0;
  return Object.freeze({
    text,
    usage: Object.freeze({
      inputTokens: numberAt("prompt_tokens"),
      outputTokens: numberAt("completion_tokens"),
      totalTokens: numberAt("total_tokens")
    })
  });
};

const createClient = (config: ProviderConfig, fetcher: LlmFetch): LlmClient => Object.freeze({
  complete: async ({ messages }: Readonly<{ messages: readonly LlmChatMessage[] }>): Promise<LlmCompletion> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, config.timeoutMs);
    try {
      const response = await fetcher(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, messages }),
        signal: controller.signal
      });
      if (!response.ok) {
        // Upstream bodies can contain credentials, prompts or private request diagnostics.
        await response.body?.cancel();
        throw transportError(errorKindForStatus(response.status), `Provider request failed with status ${String(response.status)}.`, response.status);
      }
      const completion = await readCompletion(response);
      return Object.freeze({ ...completion, provider: config.name, model: config.model });
    } catch (error: unknown) {
      if (isLlmTransportError(error)) throw error;
      throw transportError("retryable", "Provider transport failed or timed out.");
    } finally {
      clearTimeout(timeout);
    }
  }
});

export const createOpenAiCompatibleLlmGateway = ({ fetch }: OpenAiCompatibleGatewayDependencies): LlmGateway =>
  Object.freeze({ createClient: (config) => createClient(config, fetch) });

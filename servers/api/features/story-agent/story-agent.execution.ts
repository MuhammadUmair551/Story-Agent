import type { StoryAgentUsage } from "@workspace/types";
import { trace, isSpanContextValid } from "@opentelemetry/api";

export type StoryAgentAccounting = Readonly<{
  physicalAttempts: number;
  usage: StoryAgentUsage;
  elapsedMs: number;
  providers: readonly string[];
  contentFailures: Readonly<Record<string, number>>;
  permanentFailures: Readonly<Record<string, string>>;
}>;
export type StoryAgentExecution = Readonly<{
  runId: string;
  requestId?: string | undefined;
  traceId?: string | undefined;
  leaseId?: string | undefined;
  accounting?: StoryAgentAccounting | undefined;
  checkpoint?: ((accounting: StoryAgentAccounting, stage: string) => Promise<void>) | undefined;
}>;
export const emptyAccounting = (): StoryAgentAccounting => ({ physicalAttempts: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, elapsedMs: 0, providers: [], contentFailures: {}, permanentFailures: {} });
export const executionCorrelation = (execution?: StoryAgentExecution): Readonly<Record<string, string>> => {
  const active = trace.getActiveSpan()?.spanContext();
  return execution ? {
  runId: execution.runId,
  ...(execution.requestId ? { requestId: execution.requestId } : {}),
  ...(execution.traceId ? { traceId: execution.traceId } : {}),
  ...(execution.leaseId ? { leaseId: execution.leaseId } : {}),
  ...(active && isSpanContextValid(active) ? { activeTraceId: active.traceId } : {})
} : {};
};
export const retryDelayMs = (base: number, attempts: number, random = Math.random): number => {
  const delay = Math.min(10 * 60_000, base * 2 ** Math.min(5, Math.max(0, attempts - 1)));
  return Math.ceil(delay + delay * 0.2 * Math.max(0, Math.min(1, random())));
};

import { metrics, trace, SpanStatusCode, type Span } from "@opentelemetry/api";

const meter = metrics.getMeter("story-agent-api.story-agent");
const tracer = trace.getTracer("story-agent-api.story-agent");
const generationCount = meter.createCounter("story_agent.generation.count", { description: "Completed Story Agent pipeline outcomes." });
const generationDuration = meter.createHistogram("story_agent.generation.duration", { unit: "ms", description: "Story Agent pipeline duration." });
const llmCount = meter.createCounter("story_agent.llm.request.count", { description: "LLM provider requests." });
const llmDuration = meter.createHistogram("story_agent.llm.request.duration", { unit: "ms", description: "LLM provider request duration." });
const queueCount = meter.createCounter("story_agent.queue.event.count", { description: "Queue lifecycle events." });
const validationCount = meter.createCounter("story_agent.validation.count", { description: "Story validation and repair events." });
const admissionCount = meter.createCounter("story_agent.admission.count", { description: "Story Agent admissions and capacity decisions." });
const providerDecisionCount = meter.createCounter("story_agent.provider.decision.count", { description: "Provider failover and circuit breaker decisions." });
const queueWaitDuration = meter.createHistogram("story_agent.queue.wait.duration", { unit: "ms", description: "Time a run waits before processing." });
const queueProcessingDuration = meter.createHistogram("story_agent.queue.processing.duration", { unit: "ms", description: "Time spent processing a queued run." });
const activeRuns = meter.createUpDownCounter("story_agent.active_runs", { description: "Currently executing Story Agent runs." });
const metricLabel = (value: string): string => value.slice(0, 128);
let currentQueueDepth = 0;
let currentQueueOldestAge = 0;
meter.createObservableGauge("story_agent.queue.depth", { description: "Number of persisted queued runs." })
  .addCallback((result) => { result.observe(currentQueueDepth); });
meter.createObservableGauge("story_agent.queue.oldest_age", { unit: "ms", description: "Age of the oldest persisted queued run." })
  .addCallback((result) => { result.observe(currentQueueOldestAge); });

export const recordGeneration = (status: string, durationMs: number): void => {
  const attributes = { outcome: status };
  generationCount.add(1, attributes);
  generationDuration.record(durationMs, attributes);
};

export const recordLlmRequest = (provider: string, model: string, outcome: "success" | "error", durationMs: number): void => {
  const attributes = { provider: metricLabel(provider), model: metricLabel(model), outcome };
  llmCount.add(1, attributes);
  llmDuration.record(durationMs, attributes);
};

export const recordQueueEvent = (event: "claimed" | "completed" | "failed" | "expired" | "retry"): void => {
  queueCount.add(1, { event });
};

export const recordValidationEvent = (event: "failed" | "repair_attempt" | "repair_succeeded"): void => {
  validationCount.add(1, { event });
};

export const recordAdmission = (decision: "accepted" | "queued" | "rate_limited" | "queue_full"): void => {
  admissionCount.add(1, { decision });
};
export const recordProviderDecision = (decision: "retryable_failure" | "failover" | "circuit_open" | "circuit_skip"): void => {
  providerDecisionCount.add(1, { decision });
};

export const recordQueueWait = (durationMs: number): void => { queueWaitDuration.record(Math.max(0, durationMs)); };
export const recordQueueProcessing = (durationMs: number, outcome: "draft" | "questions" | "queued" | "failed"): void => {
  queueProcessingDuration.record(Math.max(0, durationMs), { outcome });
};
export const recordActiveRun = (delta: 1 | -1): void => { activeRuns.add(delta); };
export const setQueueSnapshot = (depth: number, oldestAgeMs: number): void => {
  currentQueueDepth = Math.max(0, depth);
  currentQueueOldestAge = Math.max(0, oldestAgeMs);
};

export const withStorySpan = async <T>(name: string, attributes: Readonly<Record<string, string | number | boolean>>, operation: (span: Span) => Promise<T>, outcomeForResult: (value: T) => string = () => "success"): Promise<T> =>
  await tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const value = await operation(span);
      span.setAttribute("outcome", outcomeForResult(value));
      return value;
    } catch (error: unknown) {
      span.setAttribute("outcome", "error");
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute("error.type", error instanceof Error ? "operation_failed" : "unknown_error");
      throw error;
    } finally {
      span.end();
    }
  });

export const withStoryStageSpan = <T>(name: string, operation: () => T, outcomeForResult: (value: T) => string = () => "success"): T =>
  tracer.startActiveSpan(name, (span) => {
    try {
      const value = operation();
      span.setAttribute("outcome", outcomeForResult(value));
      return value;
    } catch (error: unknown) {
      span.setAttribute("outcome", "error");
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute("error.type", error instanceof Error ? "operation_failed" : "unknown_error");
      throw error;
    } finally {
      span.end();
    }
  });

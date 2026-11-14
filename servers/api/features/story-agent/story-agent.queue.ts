import type { Logger } from "@workspace/logging";
import type { StoryAgentRepository, StoryAgentRunDocument } from "./story-agent.repository.js";
import type { StoryAgentPipelineInput, StoryAgentPipelineResult } from "./story-agent.service.js";
import type { StoryAgentCapacity } from "./story-agent.capacity.js";
import { recordQueueEvent, recordQueueProcessing, recordQueueWait, setQueueSnapshot, withStorySpan } from "./story-agent.telemetry.js";
import { emptyAccounting, executionCorrelation, retryDelayMs, type StoryAgentAccounting } from "./story-agent.execution.js";
import { randomUUID } from "node:crypto";
import { validatePlan, validateStories } from "./story-agent.service.js";

type Clock = Readonly<{ now: () => number }>;
type Service = Readonly<{ run: (input: StoryAgentPipelineInput) => Promise<StoryAgentPipelineResult> }>;
type QueueDependencies = Readonly<{ repository: StoryAgentRepository; service: Service; logger: Logger; clock: Clock; intervalMs: number; capacity?: StoryAgentCapacity | undefined; random?: () => number }>;

const lockDurationMs = 5 * 60 * 1_000;
const maximumQueueAttempts = 5;
const toIso = (value: number): string => new Date(value).toISOString();
const clearQueueFields = Object.freeze({ nextAttemptAt: null, lockedUntil: null, leaseId: null, processing: false });

const isExpired = (run: StoryAgentRunDocument, now: string): boolean =>
  (run.queueAttempts ?? 0) > maximumQueueAttempts || (run.expiresAt !== undefined && run.expiresAt <= now);

const resultFields = (result: StoryAgentPipelineResult, now: string): Partial<StoryAgentRunDocument> => ({
  ...(result.questions ? { questions: [...result.questions] } : {}),
  ...(result.stories ? { stories: [...result.stories] } : {}),
  ...(result.plan ? { plan: result.plan } : {}),
  ...(result.quality ? { quality: result.quality } : {}),
  usage: result.usage,
  providers: [...result.providers],
  attempts: result.attempts,
  stages: [...result.stages],
  validationErrors: [...result.validationErrors],
  diagnostic: result.diagnostic ?? null,
  ...(result.accounting ? { accounting: result.accounting } : {}),
  reason: result.reason ?? null,
  error: result.reason ?? null,
  ...clearQueueFields,
  updatedAt: now
});

export const createStoryAgentQueue = ({ repository, service, logger, clock, intervalMs, capacity, random = Math.random }: QueueDependencies) => {
  let isProcessing = false;
  const processNext = async (): Promise<void> => {
    if (isProcessing) return;
    isProcessing = true;
    const admission = capacity?.acquireBackground();
    if (admission?.kind === "queued") {
      isProcessing = false;
      return;
    }
    try {
      const startedAt = clock.now();
      const now = toIso(startedAt);
      const queueStats = await repository.getQueueStats?.().catch(() => undefined);
      if (queueStats) setQueueSnapshot(queueStats.depth, queueStats.oldestCreatedAt ? startedAt - new Date(queueStats.oldestCreatedAt).getTime() : 0);
      const run = await withStorySpan("story_agent.queue.claim", {}, async (span) => {
        const claimed = await repository.claimQueuedRun(now, toIso(startedAt + lockDurationMs), randomUUID());
        span.setAttribute("outcome", claimed ? "claimed" : "empty");
        if (claimed) { span.setAttribute("runId", claimed.runId); if (claimed.leaseId) span.setAttribute("leaseId", claimed.leaseId); }
        return claimed;
      }, (claimed) => claimed ? "claimed" : "empty");
      if (!run) return;
      const leaseId = typeof run.leaseId === "string" ? run.leaseId : undefined;
      const correlation = { runId: run.runId, ...(run.requestId ? { requestId: run.requestId } : {}), ...(run.traceId ? { traceId: run.traceId } : {}), ...(leaseId ? { leaseId } : {}) };
      logger.info("Story Agent queue claimed run.", { ...correlation, stage: "queue_claim", queueAttempt: run.queueAttempts ?? 0 });
      recordQueueEvent("claimed");
      recordQueueWait(startedAt - new Date(run.createdAt).getTime());
      const processingStartedAt = clock.now();
      // A worker can lose its acknowledgement after saving valid output. Reconcile
      // the durable draft before spending another provider call or expiring it.
      const draft = await repository.getDraftByRun(run.runId);
      if (draft && draft.ownerId === run.ownerId && (draft.plan ? validatePlan(draft.plan, [], 10) : validateStories(draft.stories, [], 10)).length === 0) {
        await repository.updateRunStatus(run.runId, "draft", { stories: [...draft.stories], ...(draft.plan ? { plan: draft.plan } : {}), resultLeaseId: draft.leaseId ?? null, diagnostic: null, reason: null, error: null, ...clearQueueFields, updatedAt: now }, leaseId);
        recordQueueEvent("completed");
        recordQueueProcessing(clock.now() - processingStartedAt, "draft");
        return;
      }
      if (isExpired(run, now)) {
        await repository.updateRunStatus(run.runId, "failed", { reason: "expired", error: "expired", diagnostic: { category: "budget_exhausted", reason: "expired", stage: "queue", retryable: false }, ...clearQueueFields, updatedAt: now }, leaseId);
        recordQueueEvent("expired");
        recordQueueProcessing(clock.now() - processingStartedAt, "failed");
        return;
      }
      const accounting = run.accounting ?? (run.attempts === 0 && run.providers.length === 0 && run.reason !== "providers_unavailable" ? emptyAccounting() : undefined);
      if (!accounting) {
        await repository.updateRunStatus(run.runId, "failed", { reason: "budget_history_unavailable", error: "This older queued run has no reliable provider budget history. Submit a new run explicitly.", diagnostic: { category: "budget_exhausted", reason: "budget_history_unavailable", stage: "queue", retryable: false }, ...clearQueueFields, updatedAt: now }, leaseId);
        return;
      }
      let providerReturned = false;
      try {
        const execution = { ...correlation, accounting, checkpoint: async (snapshot: StoryAgentAccounting, stage: string) => {
          try { await repository.updateRunStatus(run.runId, "queued", { accounting: snapshot, updatedAt: toIso(clock.now()) }, leaseId); }
          catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "stale_lease") throw error; throw Object.assign(new Error("Queue accounting could not be persisted."), { code: "checkpoint_failed" }); }
          logger.info("Story Agent accounting persisted.", { ...executionCorrelation(correlation), stage, providerAttempts: snapshot.physicalAttempts });
        } };
        const result = await service.run({ requirement: run.requirement, ...(run.context ? { context: run.context } : {}), ...(run.projectId ? { projectId: run.projectId, projectRules: run.projectRules } : {}), execution });
        providerReturned = true;
        if (result.status === "draft") {
          if (leaseId) await repository.updateRunStatus(run.runId, "queued", { candidateLeaseId: leaseId }, leaseId);
          await repository.saveDraft({ runId: run.runId, ...(run.ownerId ? { ownerId: run.ownerId } : {}), ...(leaseId ? { leaseId } : {}), stories: result.stories ?? [], ...(result.plan ? { plan: result.plan } : {}), createdAt: now });
          await repository.updateRunStatus(run.runId, "draft", { ...resultFields(result, now), resultLeaseId: leaseId ?? null }, leaseId);
          recordQueueEvent("completed");
          recordQueueProcessing(clock.now() - processingStartedAt, "draft");
          return;
        }
        if (result.status === "questions") {
          await repository.updateRunStatus(run.runId, "questions", resultFields(result, now), leaseId);
          recordQueueEvent("completed");
          recordQueueProcessing(clock.now() - processingStartedAt, "questions");
          return;
        }
        if (result.status === "queued") {
          await repository.updateRunStatus(run.runId, "queued", { ...resultFields(result, now), nextAttemptAt: toIso(clock.now() + Math.max(retryDelayMs(intervalMs, run.queueAttempts ?? 1, random), result.retryAfterMs ?? 0)) }, leaseId);
          recordQueueEvent("retry");
          recordQueueProcessing(clock.now() - processingStartedAt, "queued");
          return;
        }
        await repository.updateRunStatus(run.runId, "failed", resultFields(result, now), leaseId);
        recordQueueEvent("failed");
        recordQueueProcessing(clock.now() - processingStartedAt, "failed");
      } catch (error: unknown) {
        // Persistence failures retain the lease for reconciliation/retry; they must
        // not turn a successful model result into a terminal generation failure.
        if (providerReturned || (error instanceof Error && "code" in error && (error.code === "stale_lease" || error.code === "checkpoint_failed"))) throw error;
        const reason = "queue_processing_failed";
        logger.error("Story Agent queue run failed.", { ...correlation, stage: "queue", reasonCode: "queue_processing_failed" });
        await repository.updateRunStatus(run.runId, "failed", { reason, error: reason, diagnostic: { category: "generation_failed", reason, stage: "queue", retryable: false }, ...clearQueueFields, updatedAt: now }, leaseId);
        recordQueueEvent("failed");
        recordQueueProcessing(clock.now() - processingStartedAt, "failed");
      }
    } finally {
      admission?.release();
      isProcessing = false;
    }
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  return Object.freeze({
    processNext,
    start: (): void => {
      if (timer) return;
      timer = setInterval(() => {
        void processNext().catch(() => { logger.error("Story Agent queue poll failed.", { reasonCode: "queue_poll_failed" }); });
      }, intervalMs);
    },
    stop: (): void => {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    }
  });
};

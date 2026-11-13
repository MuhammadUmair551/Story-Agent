import type { Logger } from "@workspace/logging";
import type { StoryAgentRepository, StoryAgentRunDocument } from "./story-agent.repository.js";
import type { StoryAgentPipelineInput, StoryAgentPipelineResult } from "./story-agent.service.js";
import type { StoryAgentCapacity } from "./story-agent.capacity.js";
import { recordQueueEvent, recordQueueProcessing, recordQueueWait, setQueueSnapshot, withStorySpan } from "./story-agent.telemetry.js";

type Clock = Readonly<{ now: () => number }>;
type Service = Readonly<{ run: (input: StoryAgentPipelineInput) => Promise<StoryAgentPipelineResult> }>;
type QueueDependencies = Readonly<{ repository: StoryAgentRepository; service: Service; logger: Logger; clock: Clock; intervalMs: number; capacity?: StoryAgentCapacity | undefined }>;

const lockDurationMs = 5 * 60 * 1_000;
const maximumQueueAttempts = 5;
const toIso = (value: number): string => new Date(value).toISOString();
const clearQueueFields = Object.freeze({ nextAttemptAt: null, lockedUntil: null });

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
  reason: result.reason ?? null,
  error: result.reason ?? null,
  ...clearQueueFields,
  updatedAt: now
});

export const createStoryAgentQueue = ({ repository, service, logger, clock, intervalMs, capacity }: QueueDependencies) => {
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
        const claimed = await repository.claimQueuedRun(now, toIso(startedAt + lockDurationMs));
        span.setAttribute("outcome", claimed ? "claimed" : "empty");
        return claimed;
      }, (claimed) => claimed ? "claimed" : "empty");
      if (!run) return;
      recordQueueEvent("claimed");
      recordQueueWait(startedAt - new Date(run.createdAt).getTime());
      const processingStartedAt = clock.now();
      // A worker can lose its acknowledgement after saving valid output. Reconcile
      // the durable draft before spending another provider call or expiring it.
      const draft = await repository.getDraftByRun(run.runId);
      if (draft && draft.ownerId === run.ownerId) {
        await repository.updateRunStatus(run.runId, "draft", { stories: [...draft.stories], ...(draft.plan ? { plan: draft.plan } : {}), reason: null, error: null, ...clearQueueFields, updatedAt: now });
        recordQueueEvent("completed");
        recordQueueProcessing(clock.now() - processingStartedAt, "draft");
        return;
      }
      if (isExpired(run, now)) {
        await repository.updateRunStatus(run.runId, "failed", { reason: "expired", error: "expired", ...clearQueueFields, updatedAt: now });
        recordQueueEvent("expired");
        recordQueueProcessing(clock.now() - processingStartedAt, "failed");
        return;
      }
      let providerReturned = false;
      try {
        const result = await service.run({ requirement: run.requirement, ...(run.context ? { context: run.context } : {}), ...(run.projectId ? { projectId: run.projectId, projectRules: run.projectRules } : {}) });
        providerReturned = true;
        if (result.status === "draft") {
          await repository.saveDraft({ runId: run.runId, ...(run.ownerId ? { ownerId: run.ownerId } : {}), stories: result.stories ?? [], ...(result.plan ? { plan: result.plan } : {}), createdAt: now });
          await repository.updateRunStatus(run.runId, "draft", resultFields(result, now));
          recordQueueEvent("completed");
          recordQueueProcessing(clock.now() - processingStartedAt, "draft");
          return;
        }
        if (result.status === "questions") {
          await repository.updateRunStatus(run.runId, "questions", resultFields(result, now));
          recordQueueEvent("completed");
          recordQueueProcessing(clock.now() - processingStartedAt, "questions");
          return;
        }
        if (result.status === "queued") {
          await repository.updateRunStatus(run.runId, "queued", { ...resultFields(result, now), nextAttemptAt: toIso(startedAt + intervalMs) });
          recordQueueEvent("retry");
          recordQueueProcessing(clock.now() - processingStartedAt, "queued");
          return;
        }
        await repository.updateRunStatus(run.runId, "failed", resultFields(result, now));
        recordQueueEvent("failed");
        recordQueueProcessing(clock.now() - processingStartedAt, "failed");
      } catch (error: unknown) {
        // Persistence failures retain the lease for reconciliation/retry; they must
        // not turn a successful model result into a terminal generation failure.
        if (providerReturned) throw error;
        const reason = "queue_processing_failed";
        logger.error("Story Agent queue run failed.", { runId: run.runId, reasonCode: "queue_processing_failed" });
        await repository.updateRunStatus(run.runId, "failed", { reason, error: reason, ...clearQueueFields, updatedAt: now });
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

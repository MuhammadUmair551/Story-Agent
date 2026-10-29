import type { Logger } from "@workspace/logging";
import type { StoryAgentRepository, StoryAgentRunDocument } from "./story-agent.repository.js";
import type { StoryAgentPipelineResult } from "./story-agent.service.js";
import type { StoryAgentCapacity } from "./story-agent.capacity.js";
import { recordQueueEvent, recordQueueProcessing, recordQueueWait, setQueueSnapshot, withStorySpan } from "./story-agent.telemetry.js";

type Clock = Readonly<{ now: () => number }>;
type Service = Readonly<{ run: (input: Readonly<{ requirement: string; context?: string | undefined }>) => Promise<StoryAgentPipelineResult> }>;
type QueueDependencies = Readonly<{ repository: StoryAgentRepository; service: Service; logger: Logger; clock: Clock; intervalMs: number; capacity?: StoryAgentCapacity | undefined }>;

const lockDurationMs = 5 * 60 * 1_000;
const maximumQueueAttempts = 5;
const toIso = (value: number): string => new Date(value).toISOString();
const clearQueueFields = Object.freeze({ nextAttemptAt: null, lockedUntil: null });

const isExpired = (run: StoryAgentRunDocument, now: string): boolean =>
  (run.queueAttempts ?? 0) >= maximumQueueAttempts || (run.expiresAt !== undefined && run.expiresAt < now);

const resultFields = (result: StoryAgentPipelineResult, now: string): Partial<StoryAgentRunDocument> => ({
  ...(result.questions ? { questions: [...result.questions] } : {}),
  ...(result.stories ? { stories: [...result.stories] } : {}),
  ...(result.plan ? { plan: result.plan } : {}),
  usage: result.usage,
  providers: [...result.providers],
  attempts: result.attempts,
  stages: [...result.stages],
  validationErrors: [...result.validationErrors],
  ...(result.reason ? { reason: result.reason, error: result.reason } : {}),
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
      if (isExpired(run, now)) {
        await repository.updateRunStatus(run.runId, "failed", { reason: "expired", error: "expired", ...clearQueueFields, updatedAt: now });
        recordQueueEvent("expired");
        recordQueueProcessing(clock.now() - processingStartedAt, "failed");
        return;
      }
      try {
        const result = await service.run({ requirement: run.requirement, ...(run.context ? { context: run.context } : {}) });
        if (result.status === "draft") {
          await repository.saveDraft({ runId: run.runId, stories: result.stories ?? [], ...(result.plan ? { plan: result.plan } : {}), createdAt: now });
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
        const reason = error instanceof Error ? error.message : "queue_processing_failed";
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

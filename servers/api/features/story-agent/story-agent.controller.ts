import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { ERROR_CODES, ERROR_MESSAGES, HTTP_STATUS } from "../../constants/index.js";
import { createApplicationError } from "../../errors/index.js";
import type { StoryAgentCapacity } from "./story-agent.capacity.js";
import { requirementInputSchema } from "./story-agent.validation.js";
import type { StoryAgentRepository, StoryAgentRunDocument } from "./story-agent.repository.js";
import type { StoryAgentPipelineResult } from "./story-agent.service.js";
import { recordAdmission, withStorySpan, withStoryStageSpan } from "./story-agent.telemetry.js";

type Clock = Readonly<{ now: () => number }>;
type Service = Readonly<{ run: (input: Readonly<{ requirement: string; context?: string | undefined }>) => Promise<StoryAgentPipelineResult> }>;
type ControllerDependencies = Readonly<{ repository: StoryAgentRepository; service: Service; capacity: StoryAgentCapacity; clock: Clock; createRunId?: () => string }>;
type JsonResponse = Pick<Response, "json" | "status">;

const toIso = (value: number): string => new Date(value).toISOString();
const queuedRetryDelayMs = 2 * 60 * 1_000;
const queuedExpiryMs = 30 * 60 * 1_000;
const queuedByCapacity = (): StoryAgentPipelineResult => ({
  status: "queued",
  attempts: 0,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  providers: [],
  stages: [{ stage: "admission", status: "skipped", detail: "Run queued because this API instance is at model capacity." }],
  validationErrors: [],
  reason: "capacity_queued"
});

type QueueWrite = Readonly<{ input: Readonly<{ requirement: string; context?: string | undefined }>; pipeline: StoryAgentPipelineResult; runId: string; now: number }>;

const runDocument = (runId: string, input: Readonly<{ requirement: string; context?: string | undefined }>, pipeline: StoryAgentPipelineResult, now: number): StoryAgentRunDocument => {
  const errorMessage = pipeline.status === "failed"
    ? pipeline.validationErrors[0] ?? pipeline.reason ?? "Story generation failed."
    : pipeline.reason;

  return {
    runId,
    status: pipeline.status,
    requirement: input.requirement,
    ...(input.context ? { context: input.context } : {}),
    ...(pipeline.questions ? { questions: pipeline.questions } : {}),
    ...(pipeline.stories ? { stories: pipeline.stories } : {}),
    ...(pipeline.plan ? { plan: pipeline.plan } : {}),
    usage: pipeline.usage,
    providers: pipeline.providers,
    attempts: pipeline.attempts,
    stages: pipeline.stages,
    validationErrors: pipeline.validationErrors,
    ...(pipeline.reason ? { reason: pipeline.reason } : {}),
    ...(errorMessage ? { error: errorMessage } : {}),
    ...(pipeline.status === "queued" ? { nextAttemptAt: toIso(now + queuedRetryDelayMs), expiresAt: toIso(now + queuedExpiryMs) } : {}),
    createdAt: toIso(now),
    updatedAt: toIso(now)
  };
};

export const createStoryAgentController = ({ repository, service, capacity, clock, createRunId = randomUUID }:
  ControllerDependencies) => {
  let queueWriteTail: Promise<void> = Promise.resolve();
  const saveQueuedRun = async ({ input, pipeline, runId, now }: QueueWrite): Promise<boolean> => {
    let release: (() => void) | undefined;
    const previous = queueWriteTail;
    queueWriteTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (await repository.countQueuedRuns() >= 20) return false;
      await withStorySpan("story_agent.run.persist", { "story_agent.status": pipeline.status }, async () => { await repository.saveRun(runDocument(runId, input, pipeline, now)); });
      return true;
    } finally { release?.(); }
  };
  return {
  createRun: async (request: Request, response: JsonResponse, next: NextFunction): Promise<void> => {
    try {
      const input = requirementInputSchema.parse(request.body);
      if (await repository.countQueuedRuns() >= 20) {
        recordAdmission("queue_full");
        response.status(HTTP_STATUS.serviceUnavailable).json({ error: "Story Agent queue is full. Please try again shortly." });
        return;
      }
      const admission = withStoryStageSpan("story_agent.capacity.admission", () => {
        const decision = capacity.acquire(request.socket.remoteAddress ?? "unknown");
        return decision;
      }, (decision) => decision.kind);
      if (admission.kind === "rate_limited") {
        recordAdmission("rate_limited");
        response.status(HTTP_STATUS.tooManyRequests).json({ error: "Too many Story Agent requests. Please try again shortly.", retryAfterMs: admission.retryAfterMs });
        return;
      }
      const pipeline = admission.kind === "queued"
        ? queuedByCapacity()
        : await (async (): Promise<StoryAgentPipelineResult> => {
          try { return await service.run(input); }
          finally { admission.release(); }
        })();
      recordAdmission(admission.kind === "queued" ? "queued" : "accepted");
      const runId = createRunId();
      const now = clock.now();
      if (pipeline.status === "queued") {
        if (!await saveQueuedRun({ input, pipeline, runId, now })) {
          response.status(HTTP_STATUS.serviceUnavailable).json({ error: "Story Agent queue is full. Please try again shortly." });
          return;
        }
        response.status(HTTP_STATUS.accepted).json({ runId, status: pipeline.status, message: "Providers are unavailable; the run is queued for retry." });
        return;
      }
      await withStorySpan("story_agent.run.persist", { "story_agent.status": pipeline.status }, async () => { await repository.saveRun(runDocument(runId, input, pipeline, now)); });
      if (pipeline.status === "draft") {
        await repository.saveDraft({ runId, stories: pipeline.stories ?? [], ...(pipeline.plan ? { plan: pipeline.plan } : {}), createdAt: toIso(now) });
        response.status(HTTP_STATUS.ok).json({ runId, status: pipeline.status, stories: pipeline.stories ?? [], ...(pipeline.plan ? { plan: pipeline.plan } : {}), usage: pipeline.usage });
        return;
      }
      if (pipeline.status === "questions") {
        response.status(HTTP_STATUS.ok).json({ runId, status: pipeline.status, questions: pipeline.questions ?? [], usage: pipeline.usage });
        return;
      }
      response.status(HTTP_STATUS.internalServerError).json({ runId, status: pipeline.status, error: pipeline.validationErrors[0] ?? pipeline.reason ?? "Story generation failed.", usage: pipeline.usage });
    } catch (error: unknown) {
      next(error);
    }
  },
  listRuns: async (request: Request, response: JsonResponse, next: NextFunction): Promise<void> => {
    try {
      const limit = Number(request.query.limit ?? 20);
      const skip = Number(request.query.skip ?? 0);
      const runs = await repository.listRuns({ limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20, skip: Number.isInteger(skip) && skip >= 0 ? skip : 0 });
      response.status(HTTP_STATUS.ok).json({ runs });
    } catch (error: unknown) {
      next(error);
    }
  },
  getRun: async (request: Request, response: JsonResponse, next: NextFunction): Promise<void> => {
    try {
      const runIdParam = request.params.id;
      const runId = Array.isArray(runIdParam) ? runIdParam[0] : runIdParam;
      if (!runId) {
        next(createApplicationError({
          code: ERROR_CODES.routeNotFound,
          message: ERROR_MESSAGES.routeNotFound,
          status: HTTP_STATUS.notFound,
          details: { path: "story-agent/runs" }
        }));
        return;
      }
      const run = await repository.getRun(runId);
      if (!run) {
        next(createApplicationError({
          code: ERROR_CODES.routeNotFound,
          message: ERROR_MESSAGES.routeNotFound,
          status: HTTP_STATUS.notFound,
          details: { path: `story-agent/runs/${runId}` }
        }));
        return;
      }
      const draft = await repository.getDraftByRun(run.runId);
      response.status(HTTP_STATUS.ok).json({ run, draft });
    } catch (error: unknown) {
      next(error);
    }
  }
  };
};

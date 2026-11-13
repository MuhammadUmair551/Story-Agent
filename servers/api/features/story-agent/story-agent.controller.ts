import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { ERROR_CODES, ERROR_MESSAGES, HTTP_STATUS } from "../../constants/index.js";
import { createApplicationError } from "../../errors/index.js";
import type { StoryAgentCapacity } from "./story-agent.capacity.js";
import { requirementInputSchema } from "./story-agent.validation.js";
import type { StoryAgentRepository, StoryAgentRunDocument } from "./story-agent.repository.js";
import type { StoryAgentPipelineResult, StoryAgentPipelineInput } from "./story-agent.service.js";
import { recordAdmission, withStorySpan, withStoryStageSpan } from "./story-agent.telemetry.js";
import { refinementInputSchema, refinementDecisionSchema } from "./story-agent.validation.js";
import { hasStoryContext, withStoryContext } from "./story-agent.metadata.js";
import { activePlan, activeRequirement, refinementChanges } from "./story-agent.refinement.js";
import { analysisIsCurrent } from "./story-agent.intelligence.js";
import { explainQuality, planArtifacts } from "./story-agent.quality.js";
import { flattenPlan, legacyPlan, validatePlan } from "./story-agent.service.js";
import type { StoryAgentRefinement } from "@workspace/types";
import type { StoryAgentProjectRepository } from "./story-agent.projects.repository.js";
import { presentAnalysisFreshness } from "./story-agent.findings.controller.js";

type Clock = Readonly<{ now: () => number }>;
type Service = Readonly<{ run: (input: StoryAgentPipelineInput) => Promise<StoryAgentPipelineResult> }>;
type ControllerDependencies = Readonly<{ repository: StoryAgentRepository; service: Service; capacity: StoryAgentCapacity; clock: Clock; projects?: StoryAgentProjectRepository; createRunId?: () => string; serializeQueueWrite?: QueueWriteGate }>;
type JsonResponse = Pick<Response, "json" | "status">;

const toIso = (value: number): string => new Date(value).toISOString();
const queuedRetryDelayMs = 2 * 60 * 1_000;
const queuedExpiryMs = 30 * 60 * 1_000;
const rejectedProviderMessage = "No provider could accept this request. Check provider model availability, credentials and account limits.";
const queuedByCapacity = (): StoryAgentPipelineResult => ({
  status: "queued",
  attempts: 0,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  providers: [],
  stages: [{ stage: "admission", status: "skipped", detail: "Run queued because this API instance is at model capacity." }],
  validationErrors: [],
  reason: "capacity_queued"
});

type QueueWrite = Readonly<{ input: StoryAgentPipelineInput; pipeline: StoryAgentPipelineResult; runId: string; now: number }>;

const runDocument = (runId: string, input: StoryAgentPipelineInput, pipeline: StoryAgentPipelineResult, now: number): StoryAgentRunDocument => {
  const errorMessage = pipeline.status === "failed"
    ? pipeline.reason === "provider_rejected" ? rejectedProviderMessage : pipeline.validationErrors[0] ?? pipeline.reason ?? "Story generation failed."
    : pipeline.reason;

  return {
    runId,
    status: pipeline.status,
    requirement: input.requirement,
    ...(input.projectId ? { projectId: input.projectId, projectRules: input.projectRules } : {}),
    ...(input.context ? { context: input.context } : {}),
    ...(pipeline.questions ? { questions: pipeline.questions } : {}),
    ...(pipeline.stories ? { stories: pipeline.stories } : {}),
    ...(pipeline.plan ? { plan: pipeline.plan } : {}),
    ...(pipeline.quality ? { quality: pipeline.quality } : {}),
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

const presentRun = (stored: StoryAgentRunDocument): StoryAgentRunDocument => {
  const run = { ...stored, requirement: activeRequirement(stored) };
  let plan = activePlan(run) ?? (run.status === "draft" && run.stories?.length ? legacyPlan(run.requirement, run.stories) : undefined);
  if (!plan) return { ...run, quality: explainQuality(undefined, run.validationErrors) };
  if (run.refinements?.some((proposal) => proposal.status === "accepted")) {
    try { plan = withStoryContext(run.runId, plan, run.stories); }
    catch (error: unknown) { return { ...run, plan, error: error instanceof Error ? error.message : "Story context mapping is uncertain; the original stories are retained.", quality: explainQuality(plan, validatePlan(plan, [], 10)) }; }
    return { ...run, plan, stories: flattenPlan(plan), quality: explainQuality(plan, validatePlan(plan, [], 10), run.projectRules) };
  }
  return { ...run, plan, quality: explainQuality(plan, validatePlan(plan, [], 10), run.projectRules) };
};

export type QueueWriteGate = <T>(write: () => Promise<T>) => Promise<T>;
export const createQueueWriteGate = (): QueueWriteGate => {
  let tail: Promise<void> = Promise.resolve();
  return async (write) => {
    let release: (() => void) | undefined;
    const previous = tail;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await write(); } finally { release?.(); }
  };
};

export const createStoryAgentController = ({ repository, service, capacity, clock, projects, createRunId = randomUUID, serializeQueueWrite = createQueueWriteGate() }:
  ControllerDependencies) => {
  const saveQueuedRun = async ({ input, pipeline, runId, now }: QueueWrite): Promise<boolean> =>
    await serializeQueueWrite(async () => {
      if (await repository.countQueuedRuns() >= 20) return false;
      await withStorySpan("story_agent.run.persist", { "story_agent.status": pipeline.status }, async () => { await repository.saveRun(runDocument(runId, input, pipeline, now)); });
      return true;
    });
  return {
  deleteRun: async (request: Request, response: JsonResponse, next: NextFunction): Promise<void> => {
    try {
      const id = request.params.id;
      if (typeof id !== "string" || !id) { response.status(HTTP_STATUS.badRequest).json({ error: "A run id is required." }); return; }
      const outcome = await repository.deleteRun(id, toIso(clock.now()));
      if (outcome === "missing") { response.status(HTTP_STATUS.notFound).json({ error: "History entry not found." }); return; }
      if (outcome === "busy") { response.status(HTTP_STATUS.conflict).json({ error: "This entry is being processed. Try deleting it after processing finishes." }); return; }
      response.status(HTTP_STATUS.ok).json({ runId: id, deleted: true });
    } catch (error: unknown) { next(error); }
  },
  proposeRefinement: async (request: Request, response: JsonResponse, next: NextFunction): Promise<void> => {
    try {
      const input = refinementInputSchema.parse(request.body);
      const id = request.params.id;
      const run = typeof id === "string" ? await repository.getRun(id) : null;
      if (!run) { response.status(HTTP_STATUS.notFound).json({ error: "History entry not found." }); return; }
      const currentPlan = presentRun(run).plan;
      if (run.status !== "draft" || !currentPlan || run.deletingAt) { response.status(HTTP_STATUS.conflict).json({ error: "Only an available saved draft can be refined." }); return; }
      let original: NonNullable<StoryAgentRunDocument["plan"]>;
      try { original = withStoryContext(run.runId, currentPlan, run.stories); }
      catch (error: unknown) { response.status(HTTP_STATUS.conflict).json({ error: error instanceof Error ? error.message : "Story context mapping is uncertain; the original is unchanged." }); return; }
      if ((run.refinementVersion ?? 0) !== input.version || run.refinements?.some((proposal) => proposal.status === "pending")) { response.status(HTTP_STATUS.conflict).json({ error: "The draft changed or has a pending proposal. Reload it before continuing." }); return; }
      if ((run.refinements?.length ?? 0) >= 20 || JSON.stringify(original).length > 24_000) { response.status(HTTP_STATUS.badRequest).json({ error: "This entry exceeds the refinement history or input size limit. Generate a smaller plan to continue." }); return; }
      if (!planArtifacts(original).some((artifact) => artifact.path === input.artifactPath)) { response.status(HTTP_STATUS.badRequest).json({ error: "The selected artifact does not exist." }); return; }
      const analysis = input.analysisId ? run.analyses?.find((item) => item.id === input.analysisId) : undefined;
      let reviewVersion = run.intelligenceReviewVersion;
      if (input.analysisId) {
        const finding = analysis?.findings.find((item) => item.id === input.findingId && item.artifactPath === input.artifactPath);
        const compared = await Promise.all((analysis?.compared ?? []).map(async (item) => await repository.getRun(item.runId)));
        if (!analysis || !finding || finding.review?.status === "dismissed" || compared.some((item) => !item) || !analysisIsCurrent(analysis, run, compared.filter((item): item is StoryAgentRunDocument => item !== null))) { response.status(HTTP_STATUS.conflict).json({ error: "This analysis is stale, dismissed or the selected finding does not match. Analyze the saved entry again." }); return; }
      }
      const requirement = analysis?.updatedRequirement ?? activeRequirement(run);
      const admission = capacity.acquire(request.socket.remoteAddress ?? "unknown");
      if (admission.kind !== "accepted") { response.status(admission.kind === "rate_limited" ? HTTP_STATUS.tooManyRequests : HTTP_STATUS.serviceUnavailable).json({ error: "Refinement capacity is unavailable. Try again shortly." }); return; }
      let pipeline: StoryAgentPipelineResult;
      try { pipeline = await service.run({ requirement, ...(run.context ? { context: run.context } : {}), projectRules: run.projectRules, refinement: { original, artifactPath: input.artifactPath, instructions: input.instructions } }); }
      finally { admission.release(); }
      if (pipeline.status !== "draft" || !pipeline.plan) { response.status(HTTP_STATUS.serviceUnavailable).json({ error: "No valid refinement proposal was produced. The original is unchanged.", reason: pipeline.reason }); return; }
      const changes = pipeline.refinementChanges ?? refinementChanges(original, pipeline.plan, input.artifactPath);
      if (!changes.length) { response.status(HTTP_STATUS.unprocessableEntity).json({ error: "The provider proposed no changes to the selected artifact." }); return; }
      if (analysis) {
        if (analysis.evidenceVersion === 2) {
          const current = await repository.getRun(run.runId);
          const currentFinding = current?.analyses?.find((item) => item.id === analysis.id)?.findings.find((item) => item.id === input.findingId);
          if (!current || !currentFinding || currentFinding.review?.status === "dismissed") { response.status(HTTP_STATUS.conflict).json({ error: "The finding was dismissed or removed while preparing the proposal." }); return; }
          reviewVersion = current.intelligenceReviewVersion;
        }
        const compared = await Promise.all(analysis.compared.map(async (item) => await repository.getRun(item.runId)));
        if (compared.some((item) => !item) || !analysisIsCurrent(analysis, run, compared.filter((item): item is StoryAgentRunDocument => item !== null))) { response.status(HTTP_STATUS.conflict).json({ error: "A compared entry changed while preparing the proposal. Analyze again." }); return; }
      }
      const now = toIso(clock.now());
      const proposal: StoryAgentRefinement = { id: randomUUID(), artifactPath: input.artifactPath, status: "pending", original, proposed: pipeline.plan, changes, quality: pipeline.quality ?? explainQuality(pipeline.plan, [], run.projectRules), createdAt: now, ...(analysis ? { analysisId: analysis.id, findingId: input.findingId } : {}), ...(analysis?.updatedRequirement ? { requirementChange: { original: activeRequirement(run), proposed: requirement } } : {}) };
      if (!await repository.saveRefinements(run.runId, input.version, [...(run.refinements ?? []), proposal], now, analysis?.evidenceVersion === 2 ? reviewVersion : undefined)) { response.status(HTTP_STATUS.conflict).json({ error: "The draft or finding changed during refinement. Reload it and try again." }); return; }
      response.status(HTTP_STATUS.ok).json({ proposal, version: input.version + 1 });
    } catch (error: unknown) { next(error); }
  },
  decideRefinement: async (request: Request, response: JsonResponse, next: NextFunction): Promise<void> => {
    try {
      const input = refinementDecisionSchema.parse(request.body);
      const id = request.params.id;
      const run = typeof id === "string" ? await repository.getRun(id) : null;
      if (!run) { response.status(HTTP_STATUS.notFound).json({ error: "History entry not found." }); return; }
      const proposal = run.refinements?.find((item) => item.id === request.params.proposalId);
      if (!proposal) { response.status(HTTP_STATUS.notFound).json({ error: "Refinement proposal not found." }); return; }
      if (run.deletingAt || proposal.status !== "pending" || (run.refinementVersion ?? 0) !== input.version) { response.status(HTTP_STATUS.conflict).json({ error: "The proposal changed or has already been decided. Reload this entry." }); return; }
      if (input.decision === "accept" && (!hasStoryContext(proposal.original) || !hasStoryContext(proposal.proposed))) { response.status(HTTP_STATUS.conflict).json({ error: "This proposal predates stable story context mapping. Reject it and request a new proposal; original content is retained." }); return; }
      if (input.decision === "accept" && proposal.analysisId) {
        const analysis = run.analyses?.find((item) => item.id === proposal.analysisId);
        if (analysis?.evidenceVersion === 2) {
          const finding = analysis.findings.find((item) => item.id === proposal.findingId);
          if (!finding || finding.review?.status === "dismissed") { response.status(HTTP_STATUS.conflict).json({ error: "This finding is missing or dismissed. Reject the proposal or reopen the finding before accepting." }); return; }
        }
        const compared = await Promise.all((analysis?.compared ?? []).map(async (item) => await repository.getRun(item.runId)));
        if (!analysis || compared.some((item) => !item) || !analysisIsCurrent(analysis, run, compared.filter((item): item is StoryAgentRunDocument => item !== null), "decision")) { response.status(HTTP_STATUS.conflict).json({ error: "The analysis is stale. Reject this proposal and analyze again before accepting an update." }); return; }
      }
      const now = toIso(clock.now());
      const refinements = (run.refinements ?? []).map((item) => item.id === proposal.id ? { ...item, status: input.decision === "accept" ? "accepted" as const : "rejected" as const, decidedAt: now } : item);
      if (!await repository.saveRefinements(run.runId, input.version, refinements, now, proposal.findingId ? run.intelligenceReviewVersion : undefined)) { response.status(HTTP_STATUS.conflict).json({ error: "The entry changed. Reload it before deciding again." }); return; }
      response.status(HTTP_STATUS.ok).json({ run: presentRun({ ...run, refinements, refinementVersion: input.version + 1, updatedAt: now }) });
    } catch (error: unknown) { next(error); }
  },
  createRun: async (request: Request, response: JsonResponse, next: NextFunction): Promise<void> => {
    try {
      const parsed = requirementInputSchema.parse(request.body);
      const project = parsed.projectId ? await projects?.get(parsed.projectId) : undefined;
      if (parsed.projectId && !project) { response.status(HTTP_STATUS.notFound).json({ error: "Project not found. Select an available project." }); return; }
      const input: StoryAgentPipelineInput = { ...parsed, ...(project ? { projectRules: project.rules } : {}) };
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
        response.status(HTTP_STATUS.ok).json({ runId, status: pipeline.status, stories: pipeline.stories ?? [], ...(pipeline.plan ? { plan: pipeline.plan } : {}), ...(pipeline.quality ? { quality: pipeline.quality } : {}), usage: pipeline.usage });
        return;
      }
      if (pipeline.status === "questions") {
        response.status(HTTP_STATUS.ok).json({ runId, status: pipeline.status, questions: pipeline.questions ?? [], usage: pipeline.usage });
        return;
      }
      const unavailable = pipeline.reason === "provider_rejected" || pipeline.reason === "no_provider_configured";
      response.status(unavailable ? HTTP_STATUS.serviceUnavailable : HTTP_STATUS.internalServerError).json({ runId, status: pipeline.status, reason: pipeline.reason, error: pipeline.reason === "provider_rejected" ? rejectedProviderMessage : pipeline.validationErrors[0] ?? pipeline.reason ?? "Story generation failed.", quality: pipeline.quality, usage: pipeline.usage });
    } catch (error: unknown) {
      next(error);
    }
  },
  listRuns: async (request: Request, response: JsonResponse, next: NextFunction): Promise<void> => {
    try {
      const limit = Number(request.query.limit ?? 20);
      const skip = Number(request.query.skip ?? 0);
      const runs = await repository.listRuns({ limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20, skip: Number.isInteger(skip) && skip >= 0 ? skip : 0 });
      response.status(HTTP_STATUS.ok).json({ runs: runs.map((run) => {
        const presented = run.refinements?.some((proposal) => proposal.status === "accepted") ? presentRun(run) : run;
        return { ...presented, refinements: undefined, analyses: undefined };
      }) });
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
      const presented = presentRun(await presentAnalysisFreshness(run, repository));
      response.status(HTTP_STATUS.ok).json({ run: presented, draft: draft ? { ...draft, ...(presented.plan ? { plan: presented.plan } : {}), stories: presented.stories ?? draft.stories } : null });
    } catch (error: unknown) {
      next(error);
    }
  }
  };
};

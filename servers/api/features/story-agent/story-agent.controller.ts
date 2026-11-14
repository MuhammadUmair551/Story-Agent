import { createHash, randomUUID } from "node:crypto";
import { trace, isSpanContextValid } from "@opentelemetry/api";
import type { Logger } from "@workspace/logging";
import { emptyAccounting, executionCorrelation } from "./story-agent.execution.js";
import type { NextFunction, Request, Response } from "express";
import { ERROR_CODES, ERROR_MESSAGES, HTTP_STATUS } from "../../constants/index.js";
import { createApplicationError } from "../../errors/index.js";
import type { StoryAgentCapacity } from "./story-agent.capacity.js";
import { requirementInputSchema, planSchema } from "./story-agent.validation.js";
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
type ControllerDependencies = Readonly<{ repository: StoryAgentRepository; service: Service; capacity: StoryAgentCapacity; clock: Clock; projects?: StoryAgentProjectRepository; createRunId?: () => string; serializeQueueWrite?: QueueWriteGate; foregroundRuns?: Set<string>; ownerId?: string | undefined; logger?: Logger | undefined }>;
type JsonResponse = Pick<Response, "json" | "status"> & Partial<Pick<Response, "getHeader">>;

const toIso = (value: number): string => new Date(value).toISOString();
const queuedRetryDelayMs = 2 * 60 * 1_000;
const queuedExpiryMs = 30 * 60 * 1_000;
const rejectedProviderMessage = "No provider could accept this request. Check provider model availability, credentials and account limits.";
const requestCorrelation = (request: Request, response: JsonResponse) => {
  const header = request.headers["x-request-id"] ?? response.getHeader?.("x-request-id");
  const requestId = typeof header === "string" && /^[\w-]{1,128}$/.test(header) ? header : randomUUID();
  const span = trace.getActiveSpan()?.spanContext();
  return { requestId, ...(span && isSpanContextValid(span) ? { traceId: span.traceId } : {}) };
};
const queuedByCapacity = (): StoryAgentPipelineResult => ({
  status: "queued",
  attempts: 0,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  providers: [],
  stages: [{ stage: "admission", status: "skipped", detail: "Run queued because this API instance is at model capacity." }],
  validationErrors: [],
  reason: "capacity_queued"
});

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
    ...(pipeline.diagnostic ? { diagnostic: pipeline.diagnostic } : {}),
    ...(pipeline.accounting ? { accounting: pipeline.accounting } : {}),
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
  if (run.status !== "draft") return { ...run, plan: undefined, stories: undefined, refinements: undefined, quality: { status: "not_evaluated", checks: [] } };
  let plan = activePlan(run) ?? (run.stories?.length ? legacyPlan(run.requirement, run.stories) : undefined);
  if (!plan || !planSchema.safeParse(plan).success) return { ...run, status: "failed", plan: undefined, stories: undefined, refinements: undefined, reason: "invalid_saved_plan", error: "The saved plan is incomplete and cannot be used.", diagnostic: { category: "invalid_story_structure", reason: "invalid_saved_plan", stage: "read", retryable: false }, quality: { status: "not_evaluated", checks: [] } };
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

export const createStoryAgentController = ({ repository, service, capacity, clock, projects, createRunId = randomUUID, serializeQueueWrite = createQueueWriteGate(), foregroundRuns = new Set<string>(), ownerId, logger }:
  ControllerDependencies) => {
  const respond = (stored: StoryAgentRunDocument, response: JsonResponse): void => {
    const run = presentRun(stored);
    const status = run.status === "queued" ? HTTP_STATUS.accepted : run.status === "failed"
      ? ["provider_rejected", "no_provider_configured", "unsupported_structured_output", "malformed_provider_response"].includes(run.reason ?? "") ? HTTP_STATUS.serviceUnavailable : HTTP_STATUS.internalServerError : HTTP_STATUS.ok;
    response.status(status).json({ runId: run.runId, status: run.status, usage: run.usage,
      ...(run.status === "draft" ? { plan: run.plan, stories: run.stories, quality: run.quality } : {}),
      ...(run.status === "questions" ? { questions: run.questions ?? [] } : {}),
      ...(run.status === "queued" ? { message: run.processing ? "This saved run is processing." : "This saved run is queued for retry.", lockedUntil: run.lockedUntil } : {}),
      ...(run.reason ? { reason: run.reason } : {}), ...(run.error ? { error: run.error } : {}),
      ...(run.diagnostic ? { diagnostic: { ...run.diagnostic, httpStatus: status } } : {}) });
  };
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
      try { pipeline = await service.run({ requirement, ...(run.context ? { context: run.context } : {}), projectRules: run.projectRules, refinement: { original, artifactPath: input.artifactPath, instructions: input.instructions }, execution: { runId: run.runId, ...requestCorrelation(request, response) } }); }
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
    let release: (() => void) | undefined;
    let foregroundRunId: string | undefined;
    let savedRun: StoryAgentRunDocument | undefined;
    try {
      const parsed = requirementInputSchema.parse(request.body);
      const project = parsed.projectId ? await projects?.get(parsed.projectId) : undefined;
      if (parsed.projectId && !project) { response.status(HTTP_STATUS.notFound).json({ error: "Project not found. Select an available project." }); return; }
      const input: StoryAgentPipelineInput = { ...parsed, ...(project ? { projectRules: project.rules } : {}) };
      const admission = withStoryStageSpan("story_agent.capacity.admission", () => {
        const decision = capacity.acquire(request.socket.remoteAddress ?? "unknown");
        return decision;
      }, (decision) => decision.kind);
      if (admission.kind === "rate_limited") {
        recordAdmission("rate_limited");
        response.status(HTTP_STATUS.tooManyRequests).json({ error: "Too many Story Agent requests. Please try again shortly.", retryAfterMs: admission.retryAfterMs });
        return;
      }
      if (admission.kind === "accepted") release = admission.release;
      const correlation = requestCorrelation(request, response);
      const { requestId } = correlation;
      const key = ownerId && createRunId === randomUUID ? createHash("sha256").update(`${ownerId}:${requestId}`).digest("hex") : undefined;
      const runId = key ? `${key.slice(0, 8)}-${key.slice(8, 12)}-5${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}` : createRunId();
      const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const now = clock.now();
      const leaseId = admission.kind === "accepted" ? randomUUID() : undefined;
      const initial: StoryAgentRunDocument = { ...runDocument(runId, input, queuedByCapacity(), now), ...correlation, requestHash, accounting: emptyAccounting(), processing: !!leaseId,
        ...(leaseId ? { leaseId, reason: "processing", error: null, lockedUntil: toIso(now + 5 * 60_000), nextAttemptAt: toIso(now + 5 * 60_000) } : { lockedUntil: null }) };
      const reservation = await serializeQueueWrite(async () => {
        const existing = await repository.getRun(runId);
        if (existing) return { existing };
        if (await repository.countQueuedRuns() - foregroundRuns.size >= 20) return { full: true };
        try { await withStorySpan("story_agent.run.persist", { "story_agent.status": initial.status, "story_agent.run.id": runId }, async () => { await repository.saveRun(initial); }); }
        catch (error: unknown) {
          if (!(typeof error === "object" && error !== null && "code" in error && error.code === 11000)) throw error;
          const duplicate = await repository.getRun(runId); if (!duplicate) throw error; return { existing: duplicate };
        }
        if (leaseId) { foregroundRuns.add(runId); foregroundRunId = runId; }
        return { created: true };
      });
      if (reservation.existing) {
        if (reservation.existing.requestHash !== requestHash) response.status(HTTP_STATUS.conflict).json({ error: "This request identifier belongs to a different submission." });
        else respond(reservation.existing, response);
        return;
      }
      if (reservation.full) { recordAdmission("queue_full"); response.status(HTTP_STATUS.serviceUnavailable).json({ error: "Story Agent queue is full. Please try again shortly." }); return; }
      savedRun = initial;
      logger?.info("Story Agent run persisted.", { ...correlation, runId, leaseId, stage: "admission" });
      recordAdmission(admission.kind === "queued" ? "queued" : "accepted");
      if (!leaseId) { respond(initial, response); return; }
      const execution = { runId, ...correlation, leaseId, accounting: initial.accounting,
        checkpoint: async (accounting: NonNullable<StoryAgentRunDocument["accounting"]>, stage: string) => {
          try { await repository.updateRunStatus(runId, "queued", { accounting, updatedAt: toIso(clock.now()) }, leaseId); }
          catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "stale_lease") throw error; throw Object.assign(new Error("Run accounting could not be persisted."), { code: "checkpoint_failed" }); }
          logger?.info("Story Agent accounting persisted.", { ...executionCorrelation({ runId, ...correlation, leaseId }), stage, providerAttempts: accounting.physicalAttempts });
        } };
      const pipeline = await service.run({ ...input, execution });
      if (pipeline.status === "draft") {
        await repository.updateRunStatus(runId, "queued", { candidateLeaseId: leaseId }, leaseId);
        await repository.saveDraft({ runId, leaseId, stories: pipeline.stories ?? [], ...(pipeline.plan ? { plan: pipeline.plan } : {}), createdAt: toIso(clock.now()) });
      }
      const completed: StoryAgentRunDocument = { ...initial, ...runDocument(runId, input, pipeline, now), createdAt: initial.createdAt, updatedAt: toIso(clock.now()), processing: false, lockedUntil: null, leaseId: null,
        diagnostic: pipeline.diagnostic ?? null,
        ...(pipeline.status === "draft" ? { resultLeaseId: leaseId } : {}),
        ...(pipeline.status === "queued" ? { nextAttemptAt: toIso(clock.now() + Math.max(queuedRetryDelayMs, pipeline.retryAfterMs ?? 0)) } : { nextAttemptAt: null }),
        reason: pipeline.reason ?? null, error: pipeline.status === "failed" ? pipeline.reason === "provider_rejected" ? rejectedProviderMessage : pipeline.validationErrors[0] ?? pipeline.reason ?? "Story generation failed." : pipeline.reason ?? null };
      await serializeQueueWrite(async () => {
        await repository.updateRunStatus(runId, completed.status, completed, leaseId);
        foregroundRuns.delete(runId);
      });
      logger?.info("Story Agent run persisted.", { ...correlation, runId, leaseId, stage: "complete", status: pipeline.status });
      respond(completed, response);
    } catch (error: unknown) {
      if (!savedRun) { next(error); return; }
      logger?.error("Story Agent saved run needs recovery.", { runId: savedRun.runId, requestId: savedRun.requestId, traceId: savedRun.traceId, leaseId: savedRun.leaseId, stage: "persistence", reasonCode: "execution_interrupted" });
      try {
        const current = await repository.getRun(savedRun.runId);
        if (current && current.status !== "queued") { respond(current, response); return; }
      } catch { /* A database outage cannot erase the already reserved run identity. */ }
      response.status(HTTP_STATUS.serviceUnavailable).json({ runId: savedRun.runId, status: "queued", reason: "execution_interrupted", error: "The saved run is waiting for recovery. Do not submit it again.", diagnostic: { category: "generation_failed", reason: "execution_interrupted", stage: "persistence", retryable: true, httpStatus: HTTP_STATUS.serviceUnavailable } });
    } finally { if (foregroundRunId) foregroundRuns.delete(foregroundRunId); release?.(); }
  },
  listRuns: async (request: Request, response: JsonResponse, next: NextFunction): Promise<void> => {
    try {
      const limit = Number(request.query.limit ?? 20);
      const skip = Number(request.query.skip ?? 0);
      const runs = await repository.listRuns({ limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20, skip: Number.isInteger(skip) && skip >= 0 ? skip : 0 });
      response.status(HTTP_STATUS.ok).json({ runs: runs.map((run) => {
        const presented = presentRun(run);
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

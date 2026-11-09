import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { StoryAgentAnalysis } from "@workspace/types";
import { HTTP_STATUS } from "../../constants/index.js";
import type { StoryAgentRepository, StoryAgentRunDocument } from "./story-agent.repository.js";
import type { StoryAgentCapacity } from "./story-agent.capacity.js";
import { analysisRequestSchema, runFingerprint, type IntelligenceInput } from "./story-agent.intelligence.js";
import type { createIntelligenceRepository } from "./story-agent.intelligence.repository.js";
import { activePlan, activeRequirement } from "./story-agent.refinement.js";
import { legacyPlan } from "./story-agent.service.js";
import { withStoryContext } from "./story-agent.metadata.js";
import type { StoryAgentIntelligenceResult } from "./story-agent.service.js";

export const createIntelligenceController = (dependencies: Readonly<{ repository: StoryAgentRepository; reviews: ReturnType<typeof createIntelligenceRepository>; capacity: StoryAgentCapacity; analyze?: ((input: IntelligenceInput) => Promise<StoryAgentIntelligenceResult>) | undefined; now: () => number }>) => async (request: Request, response: Response, next: NextFunction): Promise<void> => {
  try {
    const input = analysisRequestSchema.parse(request.body);
    const id = request.params.id; const found = typeof id === "string" ? await dependencies.repository.getRun(id) : null;
    const source = found ? structuredClone(found) : null;
    if (!source) { response.status(HTTP_STATUS.notFound).json({ error: "History entry not found." }); return; }
    if (source.status !== "draft" || source.deletingAt || (source.refinementVersion ?? 0) !== input.version || source.refinements?.some((proposal) => proposal.status === "pending")) { response.status(HTTP_STATUS.conflict).json({ error: "Reload an available draft without a pending proposal before analysis." }); return; }
    if ((source.analyses?.length ?? 0) >= 20) { response.status(HTTP_STATUS.badRequest).json({ error: "This entry reached its 20-analysis history limit." }); return; }
    const requirement = activeRequirement(source);
    if (input.updatedRequirement === requirement) { response.status(HTTP_STATUS.badRequest).json({ error: "The updated requirement must differ from the current requirement." }); return; }
    let backlog: readonly StoryAgentRunDocument[];
    if (input.compareRunIds) {
      const selected = await Promise.all(input.compareRunIds.map(async (runId) => await dependencies.repository.getRun(runId)));
      if (selected.some((run) => !run || run.runId === source.runId || run.status !== "draft" || run.deletingAt || run.projectId !== source.projectId)) { response.status(HTTP_STATUS.badRequest).json({ error: "Comparison entries must be available drafts in the same project, excluding this entry." }); return; }
      backlog = selected.filter((run): run is StoryAgentRunDocument => run !== null).map((run) => structuredClone(run));
    } else backlog = source.projectId ? (await dependencies.reviews.projectBacklog(source.projectId)).filter((run) => run.runId !== source.runId) : [];
    if (backlog.length > 25) { response.status(HTTP_STATUS.badRequest).json({ error: "More than 25 comparison entries. Select comparison IDs explicitly to limit scope." }); return; }
    const planFor = (run: StoryAgentRunDocument) => withStoryContext(run.runId, activePlan(run) ?? legacyPlan(activeRequirement(run), run.stories ?? []), run.stories);
    let analysisInput: IntelligenceInput;
    try { analysisInput = { runId: source.runId, requirement, plan: planFor(source), updatedRequirement: input.updatedRequirement, projectRules: source.projectRules, backlog: backlog.map((run) => ({ runId: run.runId, requirement: activeRequirement(run), plan: planFor(run) })) }; }
    catch { response.status(HTTP_STATUS.conflict).json({ error: "Some story context cannot be mapped safely. Reconcile the saved entries before analysis." }); return; }
    if (!dependencies.analyze) { response.status(HTTP_STATUS.serviceUnavailable).json({ error: "Semantic review is unavailable." }); return; }
    const admission = dependencies.capacity.acquire(request.socket.remoteAddress ?? "unknown");
    if (admission.kind !== "accepted") { response.status(admission.kind === "rate_limited" ? HTTP_STATUS.tooManyRequests : HTTP_STATUS.serviceUnavailable).json({ error: "Analysis capacity is unavailable. Try again shortly." }); return; }
    let result: StoryAgentIntelligenceResult;
    try { result = await dependencies.analyze(analysisInput); } finally { admission.release(); }
    if (result.status !== "completed") { response.status(result.reason === "context_limit" ? HTTP_STATUS.badRequest : HTTP_STATUS.serviceUnavailable).json({ error: result.reason === "context_limit" ? "Analysis exceeds the context limit. Select fewer comparison entries or shorten the plan/rules." : "No validated semantic review was produced. Saved artifacts are unchanged.", reason: result.reason }); return; }
    // Compare every source again after the provider call; no stale review is saved.
    for (const run of [source, ...backlog]) {
      const current = await dependencies.repository.getRun(run.runId);
      if (!current || current.deletingAt || runFingerprint(current) !== runFingerprint(run)) { response.status(HTTP_STATUS.conflict).json({ error: "A compared entry changed during analysis. Reload and analyze again." }); return; }
    }
    const now = new Date(dependencies.now()).toISOString();
    const analysis: StoryAgentAnalysis = { id: randomUUID(), kind: input.kind, originalRequirement: requirement, ...(input.updatedRequirement ? { updatedRequirement: input.updatedRequirement } : {}), sourceVersion: input.version, sourceFingerprint: runFingerprint(source), compared: backlog.map((run) => ({ runId: run.runId, fingerprint: runFingerprint(run) })), findings: result.findings, createdAt: now };
    if (!await dependencies.reviews.save(source, analysis, now)) { response.status(HTTP_STATUS.conflict).json({ error: "The entry changed during analysis. Reload and analyze again." }); return; }
    response.json({ analysis, version: input.version + 1 });
  } catch (error: unknown) { next(error); }
};

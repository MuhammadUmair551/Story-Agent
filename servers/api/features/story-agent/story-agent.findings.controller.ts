import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { StoryAgentAnalysis } from "@workspace/types";
import { HTTP_STATUS } from "../../constants/index.js";
import type { StoryAgentRepository, StoryAgentRunDocument } from "./story-agent.repository.js";
import type { StoryAgentIntelligenceRepository } from "./story-agent.intelligence.repository.js";
import { analysisIsCurrent } from "./story-agent.intelligence.js";
import { activePlan, activeRequirement } from "./story-agent.refinement.js";

const decisionSchema = z.object({ decision: z.enum(["confirm", "dismiss", "reopen"]), reason: z.string().trim().max(1000).default(""), reviewVersion: z.number().int().nonnegative() }).strict().superRefine((input, ctx) => {
  if (input.decision === "dismiss" && !input.reason) ctx.addIssue({ code: "custom", path: ["reason"], message: "Explain why this finding is a false positive or should be dismissed." });
});

export const analysisFreshness = async (analysis: StoryAgentAnalysis, run: StoryAgentRunDocument, repository: StoryAgentRepository): Promise<boolean> => {
  const comparisons = await Promise.all(analysis.compared.map(async (ref) => await repository.getRun(ref.runId)));
  if (run.status !== "draft" || run.deletingAt || comparisons.some((item) => !item || item.status !== "draft" || item.projectId !== run.projectId)) return false;
  const pending = run.refinements?.some((proposal) => proposal.analysisId === analysis.id && proposal.status === "pending");
  return analysisIsCurrent(analysis, run, comparisons.filter((item): item is StoryAgentRunDocument => item !== null), pending ? "decision" : "proposal");
};

export const presentAnalysisFreshness = async (run: StoryAgentRunDocument, repository: StoryAgentRepository): Promise<StoryAgentRunDocument> => ({
  ...run,
  ...(run.analyses ? { analyses: await Promise.all(run.analyses.map(async (analysis) => analysis.evidenceVersion === 2 ? { ...analysis, stale: !await analysisFreshness(analysis, run, repository) } : analysis)) } : {})
});

export const createFindingDecisionController = (repository: StoryAgentRepository, reviews: StoryAgentIntelligenceRepository, now: () => number) => async (request: Request, response: Response, next: NextFunction): Promise<void> => {
  try {
    const input = decisionSchema.parse(request.body);
    const found = typeof request.params.id === "string" ? await repository.getRun(request.params.id) : null;
    const run = found ? structuredClone(found) : null;
    const analysis = run?.analyses?.find((item) => item.id === request.params.analysisId);
    const finding = analysis?.findings.find((item) => item.id === request.params.findingId);
    if (!run || !analysis || !finding) { response.status(HTTP_STATUS.notFound).json({ error: "Finding not found in this saved entry." }); return; }
    if (analysis.evidenceVersion !== 2 || !await analysisFreshness(analysis, run, repository) || (analysis.reviewVersion ?? 0) !== input.reviewVersion) { response.status(HTTP_STATUS.conflict).json({ error: "This finding or review changed. Reload and analyze again when stale." }); return; }
    const status = input.decision === "confirm" ? "confirmed" : input.decision === "dismiss" ? "dismissed" : "open";
    if ((finding.review?.status ?? "open") === status) { response.status(HTTP_STATUS.conflict).json({ error: "The finding already has this review status." }); return; }
    if ((finding.review?.history.length ?? 0) >= 20) { response.status(HTTP_STATUS.badRequest).json({ error: "This finding reached its 20-decision history limit." }); return; }
    const at = new Date(now()).toISOString();
    const updated: StoryAgentAnalysis = { ...analysis, reviewVersion: input.reviewVersion + 1, findings: analysis.findings.map((item) => item.id === finding.id ? { ...item, review: { status, history: [...(item.review?.history ?? []), { decision: input.decision, reason: input.reason, at }] } } : item) };
    if (Buffer.byteLength(JSON.stringify((run.analyses ?? []).map((item) => item.id === updated.id ? updated : item))) > 4_000_000) { response.status(HTTP_STATUS.badRequest).json({ error: "Evidence history exceeds the storage budget." }); return; }
    if (!await reviews.saveDecision(run, updated, at)) { response.status(HTTP_STATUS.conflict).json({ error: "The entry or finding changed while saving. Reload before deciding." }); return; }
    response.json({ analysis: updated });
  } catch (error: unknown) { next(error); }
};

export const createComparisonPageController = (repository: StoryAgentRepository, reviews: StoryAgentIntelligenceRepository) => async (request: Request, response: Response, next: NextFunction): Promise<void> => {
  try {
    const page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(100), skip: z.coerce.number().int().min(0).max(100_000).default(0) }).parse(request.query);
    const source = typeof request.params.id === "string" ? await repository.getRun(request.params.id) : null;
    if (!source || source.deletingAt) { response.status(HTTP_STATUS.notFound).json({ error: "History entry not found." }); return; }
    const result = await reviews.comparisonPage(source, page.limit, page.skip);
    response.json({ ...result, runs: result.runs.map((run) => ({ ...run, requirement: activeRequirement(run), ...(activePlan(run) ? { plan: activePlan(run) } : {}), analyses: undefined, refinements: undefined })) });
  } catch (error: unknown) { next(error); }
};

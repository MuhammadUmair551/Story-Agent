import { z } from "zod";
import type { StoryAgentAnalysis, StoryAgentIntelligenceFinding } from "@workspace/types";
import type { StoryAgentRun } from "./story-agent.types";

const reference = z.object({ runId: z.string(), artifactPath: z.string(), level: z.enum(["initiative", "epic", "feature", "story", "task"]).optional(), breadcrumb: z.array(z.string()).optional(), fingerprint: z.string().optional() });
const review = z.object({ status: z.enum(["open", "confirmed", "dismissed"]), history: z.array(z.object({ decision: z.enum(["confirm", "dismiss", "reopen"]), reason: z.string(), at: z.string() })) });
export const analysisSchema = z.object({
  id: z.string(), kind: z.enum(["backlog", "impact"]), originalRequirement: z.string(), updatedRequirement: z.string().optional(),
  sourceFingerprint: z.string(), sourceVersion: z.number().int().nonnegative(), compared: z.array(z.object({ runId: z.string(), fingerprint: z.string() })), createdAt: z.string(),
  evidenceVersion: z.literal(2).optional(), reviewVersion: z.number().int().nonnegative().optional(), stale: z.boolean().optional(),
  coverage: z.object({ scope: z.literal("selected_entries"), status: z.enum(["complete", "partial"]), totalArtifacts: z.number().int().nonnegative(), reviewedArtifacts: z.number().int().nonnegative(), excluded: z.array(reference), reasons: z.array(z.string()) }).optional(),
  findings: z.array(z.object({ id: z.string(), kind: z.enum(["duplicate_behavior", "contradiction", "terminology", "affected", "stale", "incomplete"]), artifactPath: z.string(), method: z.enum(["title_match", "semantic_review"]), reason: z.string(), suggestedUpdate: z.string(), evidence: z.array(reference.extend({ quote: z.string(), fieldPath: z.string().optional(), fieldValue: z.string().optional(), start: z.number().int().nonnegative().optional(), end: z.number().int().nonnegative().optional() })), dependencies: z.array(reference), counterparts: z.array(reference).optional(), fingerprint: z.string().optional(), review: review.optional() }))
}) satisfies z.ZodType<StoryAgentAnalysis>;

export const analysisIsStale = (run: StoryAgentRun, analysis: StoryAgentAnalysis): boolean => {
  if (analysis.stale !== undefined) return analysis.stale;
  const pending = analysis.evidenceVersion === 2 && run.refinements?.some((item) => item.analysisId === analysis.id && item.status === "pending");
  return (run.refinementVersion ?? 0) !== analysis.sourceVersion + (pending ? 2 : 1);
};

export const filterFindings = (findings: readonly StoryAgentIntelligenceFinding[], filters: Readonly<{ level: string; kind: string; status: string }>): readonly StoryAgentIntelligenceFinding[] => findings.filter((finding) => {
  const level = finding.evidence.find((item) => item.artifactPath === finding.artifactPath)?.level ?? (finding.artifactPath.includes(".tasks.") ? "task" : finding.artifactPath.includes(".stories.") ? "story" : finding.artifactPath.includes(".features.") ? "feature" : finding.artifactPath.includes(".epics.") ? "epic" : "initiative");
  return (filters.level === "all" || filters.level === level) && (filters.kind === "all" || filters.kind === finding.kind) && (filters.status === "all" || filters.status === (finding.review?.status ?? "open"));
});

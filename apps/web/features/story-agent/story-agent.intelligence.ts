import { z } from "zod";
import type { StoryAgentAnalysis } from "@workspace/types";

const reference = z.object({ runId: z.string(), artifactPath: z.string() });
export const analysisSchema = z.object({
  id: z.string(), kind: z.enum(["backlog", "impact"]), originalRequirement: z.string(), updatedRequirement: z.string().optional(),
  sourceFingerprint: z.string(), sourceVersion: z.number().int().nonnegative(), compared: z.array(z.object({ runId: z.string(), fingerprint: z.string() })), createdAt: z.string(),
  findings: z.array(z.object({ id: z.string(), kind: z.enum(["duplicate_behavior", "contradiction", "terminology", "affected", "stale", "incomplete"]), artifactPath: z.string(), method: z.enum(["title_match", "semantic_review"]), reason: z.string(), suggestedUpdate: z.string(), evidence: z.array(reference.extend({ quote: z.string() })), dependencies: z.array(reference) }))
}) satisfies z.ZodType<StoryAgentAnalysis>;

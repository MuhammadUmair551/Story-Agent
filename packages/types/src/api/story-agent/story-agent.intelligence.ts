import type { StoryAgentArtifactLevel } from "./story-agent.js";

export type StoryAgentArtifactReference = Readonly<{
  runId: string;
  artifactPath: string;
  level?: StoryAgentArtifactLevel | undefined;
  breadcrumb?: readonly string[] | undefined;
  fingerprint?: string | undefined;
}>;
export type StoryAgentIntelligenceFinding = Readonly<{
  id: string;
  kind: "duplicate_behavior" | "contradiction" | "terminology" | "affected" | "stale" | "incomplete";
  artifactPath: string;
  method: "title_match" | "semantic_review";
  reason: string;
  suggestedUpdate: string;
  evidence: readonly Readonly<StoryAgentArtifactReference & {
    quote: string;
    fieldPath?: string | undefined;
    fieldValue?: string | undefined;
    start?: number | undefined;
    end?: number | undefined;
  }>[];
  dependencies: readonly StoryAgentArtifactReference[];
  counterparts?: readonly StoryAgentArtifactReference[] | undefined;
  fingerprint?: string | undefined;
  review?: Readonly<{
    status: "open" | "confirmed" | "dismissed";
    history: readonly Readonly<{ decision: "confirm" | "dismiss" | "reopen"; reason: string; at: string }>[];
  }> | undefined;
}>;
export type StoryAgentAnalysis = Readonly<{
  id: string;
  kind: "backlog" | "impact";
  originalRequirement: string;
  updatedRequirement?: string | undefined;
  sourceFingerprint: string;
  sourceVersion: number;
  compared: readonly Readonly<{ runId: string; fingerprint: string }>[];
  findings: readonly StoryAgentIntelligenceFinding[];
  createdAt: string;
  evidenceVersion?: 2 | undefined;
  reviewVersion?: number | undefined;
  stale?: boolean | undefined;
  coverage?: Readonly<{
    scope: "selected_entries";
    status: "complete" | "partial";
    totalArtifacts: number;
    reviewedArtifacts: number;
    excluded: readonly StoryAgentArtifactReference[];
    reasons: readonly string[];
  }> | undefined;
}>;

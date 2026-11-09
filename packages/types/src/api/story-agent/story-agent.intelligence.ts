export type StoryAgentArtifactReference = Readonly<{ runId: string; artifactPath: string }>;
export type StoryAgentIntelligenceFinding = Readonly<{
  id: string;
  kind: "duplicate_behavior" | "contradiction" | "terminology" | "affected" | "stale" | "incomplete";
  artifactPath: string;
  method: "title_match" | "semantic_review";
  reason: string;
  suggestedUpdate: string;
  evidence: readonly Readonly<StoryAgentArtifactReference & { quote: string }>[];
  dependencies: readonly StoryAgentArtifactReference[];
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
}>;

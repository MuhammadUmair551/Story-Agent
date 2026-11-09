export type StoryAgentRunStatus = "questions" | "draft" | "failed" | "queued";

export type StoryAgentRequirementInput = Readonly<{
  requirement: string;
  projectId?: string | undefined;
  context?: string | undefined;
}>;

export type StoryAgentClarifications = Readonly<{
  questions: readonly string[];
  assumptions: readonly string[];
}>;

export type StoryAgentStory = Readonly<{
  title: string;
  intent: string;
  epic: string;
  size: "S" | "M" | "L";
  acceptanceCriteria: readonly string[];
  states: readonly string[];
  dependsOn: readonly string[];
  openQuestions: readonly string[];
  sliceRationale: string;
}>;

export type StoryAgentTask = Readonly<{
  title: string;
  description: string;
  effort: "S" | "M" | "L";
}>;

export type StoryAgentPlannedStory = Readonly<{
  artifactId?: string | undefined;
  metadata?: StoryAgentStoryMetadata | undefined;
  title: string;
  intent: string;
  acceptanceCriteria: readonly string[];
  tasks: readonly StoryAgentTask[];
}>;

export type StoryAgentStoryMetadata = Readonly<Pick<StoryAgentStory, "states" | "dependsOn" | "openQuestions" | "sliceRationale">>;

export type StoryAgentFeature = Readonly<{
  title: string;
  outcome: string;
  stories: readonly StoryAgentPlannedStory[];
}>;

export type StoryAgentEpic = Readonly<{
  title: string;
  objective: string;
  features: readonly StoryAgentFeature[];
}>;

export type StoryAgentPlan = Readonly<{
  initiative: Readonly<{
    title: string;
    outcome: string;
    epics: readonly StoryAgentEpic[];
  }>;
}>;

export type StoryAgentUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}>;

export type StoryAgentArtifactLevel = "initiative" | "epic" | "feature" | "story" | "task";
export type StoryAgentQualityCheck = Readonly<{
  artifactPath: string;
  level: StoryAgentArtifactLevel;
  dimension: "scope" | "ambiguity" | "completeness" | "independence" | "testability" | "requirement_coverage" | "duplicate_behavior";
  status: "passed" | "warning" | "failed" | "needs_review";
  issue: string;
  reason: string;
  impact: string;
  suggestedFix: string;
}>;

export type StoryAgentQualityReport = Readonly<{
  status: "passed" | "failed";
  checks: readonly StoryAgentQualityCheck[];
}>;

export type StoryAgentRefinementChange = Readonly<{
  path: string;
  explanation: string;
  reason: string;
}>;

export type StoryAgentRefinement = Readonly<{
  id: string;
  artifactPath: string;
  status: "pending" | "accepted" | "rejected";
  original: StoryAgentPlan;
  proposed: StoryAgentPlan;
  changes: readonly StoryAgentRefinementChange[];
  quality: StoryAgentQualityReport;
  createdAt: string;
  decidedAt?: string | undefined;
  analysisId?: string | undefined;
  findingId?: string | undefined;
  requirementChange?: Readonly<{ original: string; proposed: string }> | undefined;
}>;

export type StoryAgentRunResponse = Readonly<{
  runId: string;
  status: StoryAgentRunStatus;
  usage: StoryAgentUsage;
  questions?: readonly string[] | undefined;
  stories?: readonly StoryAgentStory[] | undefined;
  plan?: StoryAgentPlan | undefined;
  quality?: StoryAgentQualityReport | undefined;
  error?: string | undefined;
}>;

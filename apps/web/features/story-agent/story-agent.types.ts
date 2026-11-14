import type { StoryAgentPlan, StoryAgentQualityReport, StoryAgentRefinement, StoryAgentDiagnostic } from "@workspace/types";
import type { StoryAgentAnalysis } from "@workspace/types";
export type { StoryAgentPlan, StoryAgentTask, StoryAgentPlannedStory, StoryAgentFeature, StoryAgentEpic, StoryAgentQualityReport, StoryAgentRefinement, StoryAgentStoryMetadata } from "@workspace/types";
export type StoryAgentStatus = "questions" | "draft" | "failed" | "queued";

export type StoryAgentStory = {
  title: string;
  intent: string;
  epic: string;
  size: "S" | "M" | "L";
  acceptanceCriteria: string[];
  states: string[];
  dependsOn: string[];
  openQuestions: string[];
  sliceRationale: string;
  assumptions?: string[] | undefined;
};

export type StoryAgentUsage = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
};

export type StoryAgentRun = {
  runId: string;
  status: StoryAgentStatus;
  requirement: string;
  projectId?: string | undefined;
  deletingAt?: string | undefined;
  lockedUntil?: string | null | undefined;
  questions?: string[] | undefined;
  stories?: StoryAgentStory[] | undefined;
  plan?: StoryAgentPlan | undefined;
  quality?: StoryAgentQualityReport | undefined;
  refinements?: readonly StoryAgentRefinement[] | undefined;
  refinementVersion?: number | undefined;
  analyses?: readonly StoryAgentAnalysis[] | undefined;
  usage?: StoryAgentUsage | undefined;
  error?: string | undefined;
  reason?: string | undefined;
  diagnostic?: StoryAgentDiagnostic | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  message?: string | undefined;
};

export type StoryAgentRunResponse = Pick<
  StoryAgentRun,
  "runId" | "status" | "questions" | "stories" | "plan" | "usage" | "error" | "reason" | "quality" | "diagnostic" | "lockedUntil"
> & {
  message?: string | undefined;
};

export type StoryAgentRunDetail = {
  run: StoryAgentRun;
  draft: { stories: StoryAgentStory[]; plan?: StoryAgentPlan | undefined } | null;
};

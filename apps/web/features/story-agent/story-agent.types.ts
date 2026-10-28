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

export type StoryAgentTask = { title: string; description: string; effort: "S" | "M" | "L" };
export type StoryAgentPlannedStory = { title: string; intent: string; acceptanceCriteria: string[]; tasks: StoryAgentTask[] };
export type StoryAgentFeature = { title: string; outcome: string; stories: StoryAgentPlannedStory[] };
export type StoryAgentEpic = { title: string; objective: string; features: StoryAgentFeature[] };
export type StoryAgentPlan = { initiative: { title: string; outcome: string; epics: StoryAgentEpic[] } };

export type StoryAgentRun = {
  runId: string;
  status: StoryAgentStatus;
  requirement: string;
  questions?: string[] | undefined;
  stories?: StoryAgentStory[] | undefined;
  plan?: StoryAgentPlan | undefined;
  usage?: StoryAgentUsage | undefined;
  error?: string | undefined;
  reason?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  message?: string | undefined;
};

export type StoryAgentRunResponse = Pick<
  StoryAgentRun,
  "runId" | "status" | "questions" | "stories" | "plan" | "usage" | "error" | "reason"
> & {
  message?: string | undefined;
};

export type StoryAgentRunDetail = {
  run: StoryAgentRun;
  draft: { stories: StoryAgentStory[]; plan?: StoryAgentPlan | undefined } | null;
};

import type {
  StoryAgentRun,
  StoryAgentRunDetail,
  StoryAgentRunResponse,
  StoryAgentStatus,
  StoryAgentStory,
  StoryAgentTask,
  StoryAgentPlan,
  StoryAgentUsage
} from "./story-agent.types";

export const filterStoryAgentRuns = (runs: StoryAgentRun[], query: string): StoryAgentRun[] => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return runs;

  return runs.filter((run) => {
    const searchable = [run.requirement, ...(run.stories ?? []).map((story) => story.title), ...(run.stories ?? []).map((story) => story.epic), ...(run.questions ?? [])].join(" ").toLowerCase();
    return searchable.includes(normalizedQuery);
  });
};

export const buildStoryAgentRunCopyText = (run: StoryAgentRun): string => {
  const sections: string[] = [];
  sections.push(`Requirement: ${run.requirement || "Untitled requirement"}`);
  if (run.status) sections.push(`Status: ${run.status}`);
  if (run.error) sections.push(`Error: ${run.error}`);
  if (run.reason) sections.push(`Reason: ${run.reason}`);
  const stories = run.stories ?? [];
  if (stories.length === 0) return sections.join("\n");

  sections.push("\nStories:");
  for (const story of stories) {
    sections.push(`\n- ${story.title} (${story.size})`);
    sections.push(`  Intent: ${story.intent}`);
    sections.push(`  Epic: ${story.epic}`);
    if (story.acceptanceCriteria.length > 0) {
      sections.push("  Acceptance criteria:");
      for (const criterion of story.acceptanceCriteria) sections.push(`    • ${criterion}`);
    }
    if (story.states.length > 0) sections.push(`  States: ${story.states.join(", ")}`);
    if (story.dependsOn.length > 0) sections.push(`  Depends on: ${story.dependsOn.join(", ")}`);
    if (story.openQuestions.length > 0) sections.push(`  Open questions: ${story.openQuestions.join(", ")}`);
    if (story.sliceRationale) sections.push(`  Slice rationale: ${story.sliceRationale}`);
  }
  return sections.join("\n");
};

type Fetch = typeof fetch;

type CreateRunInput = {
  requirement: string;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

const asStatus = (value: unknown): StoryAgentStatus => {
  if (value === "questions" || value === "draft" || value === "failed" || value === "queued") {
    return value;
  }

  return "failed";
};

const asStrings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

const asUsage = (value: unknown): StoryAgentUsage | undefined => {
  const record = asRecord(value);
  const inputTokens = typeof record.inputTokens === "number" ? record.inputTokens : undefined;
  const outputTokens = typeof record.outputTokens === "number" ? record.outputTokens : undefined;
  const totalTokens = typeof record.totalTokens === "number" ? record.totalTokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(totalTokens === undefined ? {} : { totalTokens }) };
};

const asStory = (value: unknown): StoryAgentStory | undefined => {
  const record = asRecord(value);
  const size = record.size;
  const acceptanceCriteria = asStrings(record.acceptanceCriteria);
  const states = asStrings(record.states);
  const dependsOn = asStrings(record.dependsOn);
  const openQuestions = asStrings(record.openQuestions);
  if (typeof record.title !== "string" || typeof record.intent !== "string" || typeof record.epic !== "string" || (size !== "S" && size !== "M" && size !== "L") || acceptanceCriteria === undefined || states === undefined || dependsOn === undefined || openQuestions === undefined || typeof record.sliceRationale !== "string") return undefined;
  const assumptions = asStrings(record.assumptions);
  return { title: record.title, intent: record.intent, epic: record.epic, size, acceptanceCriteria, states, dependsOn, openQuestions, sliceRationale: record.sliceRationale, ...(assumptions === undefined ? {} : { assumptions }) };
};

const asStories = (value: unknown): StoryAgentStory[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const stories = value.map(asStory);
  if (!stories.every((story): story is StoryAgentStory => story !== undefined)) return undefined;
  return stories;
};

const asTask = (value: unknown): StoryAgentTask | undefined => {
  const record = asRecord(value);
  if (typeof record.title !== "string" || typeof record.description !== "string" || (record.effort !== "S" && record.effort !== "M" && record.effort !== "L")) return undefined;
  return { title: record.title, description: record.description, effort: record.effort };
};

const asPlan = (value: unknown): StoryAgentPlan | undefined => {
  const root = asRecord(value); const initiative = asRecord(root.initiative);
  const epics = Array.isArray(initiative.epics) ? initiative.epics.map((epicValue) => {
    const epic = asRecord(epicValue); const features = Array.isArray(epic.features) ? epic.features.map((featureValue) => {
      const feature = asRecord(featureValue); const stories = Array.isArray(feature.stories) ? feature.stories.map((storyValue) => {
        const story = asRecord(storyValue); const tasks = Array.isArray(story.tasks) ? story.tasks.map(asTask) : [];
        return typeof story.title === "string" && typeof story.intent === "string" && asStrings(story.acceptanceCriteria) !== undefined && tasks.every((task) => task !== undefined) && tasks.length > 0 ? { title: story.title, intent: story.intent, acceptanceCriteria: asStrings(story.acceptanceCriteria) ?? [], tasks: tasks as NonNullable<typeof tasks[number]>[] } : undefined;
      }) : [];
      return typeof feature.title === "string" && typeof feature.outcome === "string" && stories.every((story) => story !== undefined) && stories.length > 0 ? { title: feature.title, outcome: feature.outcome, stories: stories as NonNullable<typeof stories[number]>[] } : undefined;
    }) : [];
    return typeof epic.title === "string" && typeof epic.objective === "string" && features.every((feature) => feature !== undefined) && features.length > 0 ? { title: epic.title, objective: epic.objective, features: features as NonNullable<typeof features[number]>[] } : undefined;
  }) : [];
  return typeof initiative.title === "string" && typeof initiative.outcome === "string" && epics.every((epic) => epic !== undefined) && epics.length > 0 ? { initiative: { title: initiative.title, outcome: initiative.outcome, epics: epics as NonNullable<typeof epics[number]>[] } } : undefined;
};

export const parseStoryAgentRun = (value: unknown): StoryAgentRun => {
  const record = asRecord(value);
  const status = asStatus(record.status);
  const stories = asStories(record.stories);
  const plan = asPlan(record.plan);
  const invalidDraft = status === "draft" && stories === undefined && plan === undefined;

  return {
    runId: typeof record.runId === "string" ? record.runId : "",
    status: invalidDraft ? "failed" : status,
    requirement: typeof record.requirement === "string" ? record.requirement : "",
    questions: asStrings(record.questions),
    stories,
    plan,
    usage: asUsage(record.usage),
    error: invalidDraft ? "Saved draft data is incomplete." : typeof record.error === "string" ? record.error : undefined,
    reason: typeof record.reason === "string" ? record.reason : undefined,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined
  };
};

const readJson = async (response: Response): Promise<unknown> => response.json() as Promise<unknown>;

const getErrorMessage = (payload: unknown): string => {
  const record = asRecord(payload);
  return typeof record.message === "string"
    ? record.message
    : typeof record.error === "string"
      ? record.error
      : "Story Agent could not complete that request.";
};

const request = async (fetcher: Fetch, url: string, init?: RequestInit): Promise<unknown> => {
  const requestId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const headers = new Headers(init?.headers);
  headers.set("x-request-id", requestId);
  const response = await fetcher(url, { ...init, headers });
  const payload = await readJson(response);

  if (!response.ok) {
    throw new Error(getErrorMessage(payload));
  }

  return payload;
};

export const createStoryAgentClient = (baseUrl: string, fetcher: Fetch = fetch) => {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/story-agent/runs`;

  return {
    createRun: async (input: CreateRunInput): Promise<StoryAgentRunResponse> => {
      const payload = asRecord(await request(fetcher, endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      }));

      const run = parseStoryAgentRun(payload);
      return {
        runId: run.runId,
        status: run.status,
        questions: run.questions,
        stories: run.stories,
        plan: run.plan,
        usage: run.usage,
        error: run.error,
        reason: run.reason,
        message: typeof payload.message === "string" ? payload.message : undefined
      };
    },
    listRuns: async (): Promise<StoryAgentRun[]> => {
      const payload = asRecord(await request(fetcher, `${endpoint}?limit=20&skip=0`));
      const runs = Array.isArray(payload.runs) ? payload.runs : [];
      return runs.map(parseStoryAgentRun);
    },
    getRun: async (runId: string): Promise<StoryAgentRunDetail> => {
      const payload = asRecord(await request(fetcher, `${endpoint}/${encodeURIComponent(runId)}`));
      const draft = asRecord(payload.draft);

      return {
        run: parseStoryAgentRun(payload.run),
        draft: payload.draft === null ? null : { stories: asStories(draft.stories) ?? [], ...(asPlan(draft.plan) ? { plan: asPlan(draft.plan) } : {}) }
      };
    }
  };
};

import { z } from "zod";
import type { StoryAgentProject, StoryAgentProjectInput } from "@workspace/types";
import { projectSchema } from "./story-agent.projects";
import { analysisSchema } from "./story-agent.intelligence";
import type {
  StoryAgentRun,
  StoryAgentRunDetail,
  StoryAgentRunResponse,
  StoryAgentStatus,
  StoryAgentStory,
  StoryAgentTask,
  StoryAgentPlan,
  StoryAgentUsage,
  StoryAgentQualityReport,
  StoryAgentRefinement,
  StoryAgentStoryMetadata
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
  projectId?: string | undefined;
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

const asMetadata = (value: unknown): StoryAgentStoryMetadata | undefined => {
  const record = asRecord(value);
  const states = asStrings(record.states), dependsOn = asStrings(record.dependsOn), openQuestions = asStrings(record.openQuestions);
  return states && dependsOn && openQuestions && typeof record.sliceRationale === "string" ? { states, dependsOn, openQuestions, sliceRationale: record.sliceRationale } : undefined;
};

const asPlan = (value: unknown): StoryAgentPlan | undefined => {
  const root = asRecord(value); const initiative = asRecord(root.initiative);
  const epics = Array.isArray(initiative.epics) ? initiative.epics.map((epicValue) => {
    const epic = asRecord(epicValue); const features = Array.isArray(epic.features) ? epic.features.map((featureValue) => {
      const feature = asRecord(featureValue); const stories = Array.isArray(feature.stories) ? feature.stories.map((storyValue) => {
        const story = asRecord(storyValue); const metadata = asMetadata(story.metadata);
        if ((story.metadata !== undefined && !metadata) || (story.artifactId !== undefined && typeof story.artifactId !== "string")) return undefined;
        const tasks = Array.isArray(story.tasks) ? story.tasks.map(asTask) : [];
        return typeof story.title === "string" && typeof story.intent === "string" && asStrings(story.acceptanceCriteria) !== undefined && tasks.every((task) => task !== undefined) && tasks.length > 0 ? { ...(typeof story.artifactId === "string" ? { artifactId: story.artifactId } : {}), ...(metadata ? { metadata } : {}), title: story.title, intent: story.intent, acceptanceCriteria: asStrings(story.acceptanceCriteria) ?? [], tasks: tasks as NonNullable<typeof tasks[number]>[] } : undefined;
      }) : [];
      return typeof feature.title === "string" && typeof feature.outcome === "string" && stories.every((story) => story !== undefined) && stories.length > 0 ? { title: feature.title, outcome: feature.outcome, stories: stories as NonNullable<typeof stories[number]>[] } : undefined;
    }) : [];
    return typeof epic.title === "string" && typeof epic.objective === "string" && features.every((feature) => feature !== undefined) && features.length > 0 ? { title: epic.title, objective: epic.objective, features: features as NonNullable<typeof features[number]>[] } : undefined;
  }) : [];
  return typeof initiative.title === "string" && typeof initiative.outcome === "string" && epics.every((epic) => epic !== undefined) && epics.length > 0 ? { initiative: { title: initiative.title, outcome: initiative.outcome, epics: epics as NonNullable<typeof epics[number]>[] } } : undefined;
};

const qualitySchema = z.object({ status: z.enum(["passed", "failed"]), checks: z.array(z.object({
  artifactPath: z.string(), level: z.enum(["initiative", "epic", "feature", "story", "task"]),
  dimension: z.enum(["scope", "ambiguity", "completeness", "independence", "testability", "requirement_coverage", "duplicate_behavior"]),
  status: z.enum(["passed", "failed", "warning", "needs_review"]), issue: z.string(), reason: z.string(), impact: z.string(), suggestedFix: z.string()
})) }) satisfies z.ZodType<StoryAgentQualityReport>;

const refinementSchema = z.object({
  id: z.string(), artifactPath: z.string(), status: z.enum(["pending", "accepted", "rejected"]),
  original: z.unknown().transform((value, ctx) => { const plan = asPlan(value); if (plan) return plan; ctx.addIssue({ code: "custom", message: "Invalid original plan." }); return z.NEVER; }),
  proposed: z.unknown().transform((value, ctx) => { const plan = asPlan(value); if (plan) return plan; ctx.addIssue({ code: "custom", message: "Invalid proposed plan." }); return z.NEVER; }),
  changes: z.array(z.object({ path: z.string(), explanation: z.string(), reason: z.string() })),
  quality: qualitySchema, createdAt: z.string(), decidedAt: z.string().optional(), analysisId: z.string().optional(), findingId: z.string().optional(), requirementChange: z.object({ original: z.string(), proposed: z.string() }).optional()
}) satisfies z.ZodType<StoryAgentRefinement>;

export const parseStoryAgentRun = (value: unknown): StoryAgentRun => {
  const record = asRecord(value);
  const status = asStatus(record.status);
  const stories = asStories(record.stories);
  const plan = asPlan(record.plan);
  const quality = qualitySchema.safeParse(record.quality);
  const refinements = z.array(refinementSchema).safeParse(record.refinements);
  const invalidDraft = status === "draft" && stories === undefined && plan === undefined;

  return {
    runId: typeof record.runId === "string" ? record.runId : "",
    status: invalidDraft ? "failed" : status,
    requirement: typeof record.requirement === "string" ? record.requirement : "",
    projectId: typeof record.projectId === "string" ? record.projectId : undefined,
    deletingAt: typeof record.deletingAt === "string" ? record.deletingAt : undefined,
    questions: asStrings(record.questions),
    stories,
    plan,
    quality: quality.success ? quality.data : undefined,
    refinements: refinements.success ? refinements.data : undefined,
    refinementVersion: typeof record.refinementVersion === "number" ? record.refinementVersion : 0,
    analyses: z.array(analysisSchema).optional().parse(record.analyses),
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
  const nested = asRecord(record.error);
  if (typeof nested.message === "string") {
    const issues = Array.isArray(nested.details) ? nested.details.slice(0, 3).map((value: unknown) => {
      const issue = asRecord(value); const path = Array.isArray(issue.path) ? issue.path.filter((part: unknown) => typeof part === "string" || typeof part === "number").join(".") : "";
      return typeof issue.message === "string" ? `${path ? `${path}: ` : ""}${issue.message}` : "";
    }).filter(Boolean) : [];
    return `${nested.message}${issues.length ? ` ${issues.join("; ")}` : ""}`;
  }
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
    throw Object.assign(new Error(getErrorMessage(payload)), { status: response.status });
  }

  return payload;
};

export const createStoryAgentClient = (baseUrl: string, fetcher: Fetch = fetch) => {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/story-agent/runs`;

  return {
    listProjects: async (): Promise<readonly StoryAgentProject[]> => z.object({ projects: z.array(projectSchema) }).parse(await request(fetcher, `${baseUrl.replace(/\/$/, "")}/story-agent/projects`)).projects,
    saveProject: async (input: StoryAgentProjectInput, current?: StoryAgentProject): Promise<StoryAgentProject> => {
      const url = `${baseUrl.replace(/\/$/, "")}/story-agent/projects${current ? `/${encodeURIComponent(current.projectId)}` : ""}`;
      return z.object({ project: projectSchema }).parse(await request(fetcher, url, { method: current ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, ...(current ? { version: current.version } : {}) }) })).project;
    },
    deleteRun: async (runId: string): Promise<void> => {
      await request(fetcher, `${endpoint}/${encodeURIComponent(runId)}`, { method: "DELETE" });
    },
    listComparisons: async (runId: string, skip = 0): Promise<Readonly<{ runs: readonly StoryAgentRun[]; hasMore: boolean; nextSkip: number }>> => {
      const page = z.object({ runs: z.array(z.unknown()), hasMore: z.boolean(), nextSkip: z.number().int().nonnegative() }).parse(await request(fetcher, `${endpoint}/${encodeURIComponent(runId)}/comparisons?limit=100&skip=${String(skip)}`));
      return { ...page, runs: page.runs.map(parseStoryAgentRun) };
    },
    decideFinding: async (runId: string, analysisId: string, findingId: string, input: Readonly<{ decision: "confirm" | "dismiss" | "reopen"; reason: string; reviewVersion: number }>): Promise<void> => {
      await request(fetcher, `${endpoint}/${encodeURIComponent(runId)}/analyses/${encodeURIComponent(analysisId)}/findings/${encodeURIComponent(findingId)}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    },
    analyzeRun: async (runId: string, input: Readonly<{ kind: "backlog" | "impact"; version: number; updatedRequirement?: string | undefined; compareRunIds?: readonly string[] | undefined; evidenceVersion?: 2 | undefined }>): Promise<void> => {
      await request(fetcher, `${endpoint}/${encodeURIComponent(runId)}/analyses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    },
    proposeRefinement: async (runId: string, input: Readonly<{ artifactPath: string; instructions: string; version: number; analysisId?: string | undefined; findingId?: string | undefined }>): Promise<void> => {
      await request(fetcher, `${endpoint}/${encodeURIComponent(runId)}/refinements`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    },
    decideRefinement: async (runId: string, proposalId: string, decision: "accept" | "reject", version: number): Promise<void> => {
      await request(fetcher, `${endpoint}/${encodeURIComponent(runId)}/refinements/${encodeURIComponent(proposalId)}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, version }) });
    },
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
        quality: run.quality,
        usage: run.usage,
        error: run.error,
        reason: run.reason,
        message: typeof payload.message === "string" ? payload.message : undefined
      };
    },
    listRuns: async (input: Readonly<{ limit?: number; skip?: number }> = {}): Promise<StoryAgentRun[]> => {
      const payload = asRecord(await request(fetcher, `${endpoint}?limit=${String(input.limit ?? 20)}&skip=${String(input.skip ?? 0)}`));
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

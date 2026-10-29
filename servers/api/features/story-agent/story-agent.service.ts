import { z } from "zod";
import type { StoryAgentClarifications, StoryAgentPlan, StoryAgentStory, StoryAgentUsage } from "@workspace/types";
import { extractJson } from "./story-agent.json.js";
import { isStoryAgentRouterError, type StoryAgentProviderRouter } from "./story-agent.router.js";
import { clarificationsSchema, planSchema, storySchema } from "./story-agent.validation.js";
import * as clarifyPrompt from "./story-agent.clarify.prompt.js";
import * as generatePrompt from "./story-agent.generate.prompt.js";
import * as repairPrompt from "./story-agent.repair.prompt.js";
import { recordValidationEvent, withStoryStageSpan } from "./story-agent.telemetry.js";

export type StoryAgentExistingItem = Readonly<{ level: "initiative" | "epic" | "feature" | "story"; title: string }>;
export type StoryAgentBudget = Readonly<{ maxCalls: number; maxTotalTokens: number; timeoutMs: number; contextTokenLimit: number; maxStories: number }>;
export type StoryAgentStageOutcome = Readonly<{ stage: string; status: "completed" | "skipped" | "failed"; detail?: string }>;
export type StoryAgentPipelineResult = Readonly<{
  status: "questions" | "draft" | "failed" | "queued";
  questions?: readonly string[];
  stories?: readonly StoryAgentStory[];
  plan?: StoryAgentPlan;
  attempts: number;
  usage: StoryAgentUsage;
  providers: readonly string[];
  stages: readonly StoryAgentStageOutcome[];
  validationErrors: readonly string[];
  reason?: string;
}>;

export type StoryAgentPipelineInput = Readonly<{ requirement: string; context?: string | undefined; existingItems?: readonly StoryAgentExistingItem[] | undefined }>;
type PipelineDependencies = Readonly<{ route: StoryAgentProviderRouter; now: () => number; budget: StoryAgentBudget }>;
type GatheredContext = Readonly<{ text: string; titles: readonly string[] }>;
type CompletionLedger = { calls: number; usage: StoryAgentUsage; providers: string[]; stages: StoryAgentStageOutcome[] };

const intakeSchema = z.object({ requirement: z.string().trim().min(1).max(4_000), context: z.string().trim().max(8_000).optional() });
const clarifyResponseSchema = z.object({
  needsClarification: z.boolean(),
  questions: z.array(z.string().trim().min(1)).default([]),
  assumptions: z.array(z.string().trim().min(1)).default([])
});
const refusalSchema = z.object({ refusal: z.object({ reason: z.string().trim().min(1).max(1_000) }) });
const generatedStoriesSchema = z.object({ stories: z.array(storySchema) });
const maxRepairOutputCharacters = 12_000;
const maxRepairErrors = 10;
const maxRepairErrorCharacters = 500;
const emptyUsage = (): StoryAgentUsage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
const emptyLedger = (): CompletionLedger => ({ calls: 0, usage: emptyUsage(), providers: [], stages: [] });
const normalizeTitle = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const keywords = (value: string): readonly string[] => normalizeTitle(value).split(" ").filter((word) => word.length > 2);
const stage = (name: string, status: StoryAgentStageOutcome["status"], detail?: string): StoryAgentStageOutcome => ({ stage: name, status, ...(detail ? { detail } : {}) });

export const intake = (input: StoryAgentPipelineInput): Readonly<{ requirement: string; context?: string | undefined }> => intakeSchema.parse(input);

export const gatherContext = (requirement: string, items: readonly StoryAgentExistingItem[], tokenLimit: number): GatheredContext => {
  const requirementKeywords = new Set(keywords(requirement));
  const ranked = items.map((item, index) => ({ item, index, score: keywords(item.title).filter((word) => requirementKeywords.has(word)).length }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const titles: string[] = [];
  let characters = 0;
  for (const { item } of ranked) {
    const nextCharacters = item.title.length + (titles.length === 0 ? 0 : 1);
    if (characters + nextCharacters > tokenLimit * 4) break;
    titles.push(item.title);
    characters += nextCharacters;
  }
  return Object.freeze({ titles, text: titles.join("\n") });
};

export const validateStories = (stories: unknown, existingTitles: readonly string[], maxStories: number): readonly string[] => {
  const parsed = generatedStoriesSchema.safeParse({ stories });
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  if (parsed.data.stories.length === 0) return ["At least one story is required."];
  if (parsed.data.stories.length > maxStories) return [`At most ${String(maxStories)} stories are allowed.`];
  const known = new Set(existingTitles.map(normalizeTitle));
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const story of parsed.data.stories) {
    const title = normalizeTitle(story.title);
    if (seen.has(title)) errors.push(`Duplicate generated title: ${story.title}`);
    if (known.has(title)) errors.push(`Duplicate existing title: ${story.title}`);
    seen.add(title);
  }
  return errors;
};

const flattenPlan = (plan: StoryAgentPlan): readonly StoryAgentStory[] => plan.initiative.epics.flatMap((epic) => epic.features.flatMap((feature) => feature.stories.map((story) => ({
  title: story.title,
  intent: story.intent,
  epic: epic.title,
  size: story.tasks.some((task) => task.effort === "L") ? "L" : story.tasks.some((task) => task.effort === "M") ? "M" : "S",
  acceptanceCriteria: story.acceptanceCriteria,
  states: [],
  dependsOn: [],
  openQuestions: [],
  sliceRationale: `${feature.title}: ${feature.outcome}`
}))));

const legacyPlan = (requirement: string, stories: readonly StoryAgentStory[]): StoryAgentPlan => ({
  initiative: {
    title: requirement.slice(0, 240), outcome: requirement,
    epics: Array.from(stories.reduce<Map<string, StoryAgentStory[]>>((groups, story) => {
      const current = groups.get(story.epic) ?? [];
      current.push(story);
      groups.set(story.epic, current);
      return groups;
    }, new Map()).values()).map((group) => {
      const first = group[0];
      return {
        title: first?.epic ?? "Delivery", objective: first?.intent ?? requirement,
        features: [{ title: "Core experience", outcome: first?.intent ?? requirement, stories: group.map((story) => ({
          title: story.title, intent: story.intent, acceptanceCriteria: story.acceptanceCriteria,
          tasks: story.acceptanceCriteria.map((criterion) => ({ title: criterion, description: "Implement and verify this acceptance criterion.", effort: story.size }))
        })) }]
      };
    })
  }
});

const validatePlan = (plan: unknown, existingTitles: readonly string[], maxStories: number): readonly string[] => {
  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  return validateStories(flattenPlan(parsed.data), existingTitles, maxStories);
};

const planFromCandidate = (candidate: unknown): unknown => {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  if ("plan" in candidate) return candidate.plan;
  return "initiative" in candidate ? candidate : undefined;
};

const isObjectWithStories = (value: unknown): value is { stories: unknown } =>
  typeof value === "object" && value !== null && "stories" in value;

const result = (ledger: CompletionLedger, status: StoryAgentPipelineResult["status"], validationErrors: readonly string[], fields: Partial<StoryAgentPipelineResult> = {}): StoryAgentPipelineResult => ({
  status,
  attempts: ledger.calls,
  usage: ledger.usage,
  providers: ledger.providers,
  stages: ledger.stages,
  validationErrors,
  ...fields
});

const addCompletion = (ledger: CompletionLedger, name: string, completion: Readonly<{ provider: string; usage: StoryAgentUsage }>): void => {
  ledger.calls += 1;
  ledger.usage = {
    inputTokens: ledger.usage.inputTokens + completion.usage.inputTokens,
    outputTokens: ledger.usage.outputTokens + completion.usage.outputTokens,
    totalTokens: ledger.usage.totalTokens + completion.usage.totalTokens
  };
  if (!ledger.providers.includes(completion.provider)) ledger.providers.push(completion.provider);
  ledger.stages.push(stage(name, "completed"));
};

const runtimeBudgetExceeded = (ledger: CompletionLedger, startedAt: number, dependencies: PipelineDependencies): boolean =>
  ledger.usage.totalTokens > dependencies.budget.maxTotalTokens
  || dependencies.now() - startedAt > dependencies.budget.timeoutMs;

const request = async (
  name: string,
  profile: "fast" | "generate",
  prompt: string,
  ledger: CompletionLedger,
  startedAt: number,
  dependencies: PipelineDependencies
): Promise<Readonly<{ text: string }> | StoryAgentPipelineResult> => {
  if (ledger.calls >= dependencies.budget.maxCalls || runtimeBudgetExceeded(ledger, startedAt, dependencies)) {
    return result(ledger, "failed", [], { reason: "over_budget" });
  }
  try {
    const completion = await dependencies.route.complete({ profile, messages: [{ role: "user", content: prompt }] });
    addCompletion(ledger, name, completion);
    if (runtimeBudgetExceeded(ledger, startedAt, dependencies)) return result(ledger, "failed", [], { reason: "over_budget" });
    return { text: completion.text };
  } catch (error: unknown) {
    if (isStoryAgentRouterError(error)) {
      if (error.code === "providers_unavailable") return result(ledger, "queued", [], { reason: error.code });
      return result(ledger, "failed", [], { reason: error.code });
    }
    ledger.stages.push(stage(name, "failed", error instanceof Error ? error.message : "Provider request failed."));
    return result(ledger, "failed", [], { reason: error instanceof Error ? error.message : "provider_failed" });
  }
};

const isPipelineResult = (value: Readonly<{ text: string }> | StoryAgentPipelineResult): value is StoryAgentPipelineResult => "status" in value;

export const createStoryAgentService = (dependencies: PipelineDependencies) => ({
  run: async (input: StoryAgentPipelineInput): Promise<StoryAgentPipelineResult> => {
    const ledger = emptyLedger();
    const startedAt = dependencies.now();
    let accepted: Readonly<{ requirement: string; context?: string | undefined }>;
    try {
      accepted = withStoryStageSpan("story_agent.requirement.validate", () => intake(input));
      ledger.stages.push(stage("intake", "completed"));
    } catch (error: unknown) {
      ledger.stages.push(stage("intake", "failed", "Invalid requirement input."));
      return result(ledger, "failed", [], { reason: error instanceof Error ? error.message : "invalid_input" });
    }
    const gathered = withStoryStageSpan("story_agent.context.gather", () => gatherContext(accepted.requirement, input.existingItems ?? [], dependencies.budget.contextTokenLimit));
    ledger.stages.push(stage("gatherContext", "completed"));
    const context = [accepted.context, gathered.text].filter(Boolean).join("\n");
    const clarify = await request("clarify", "fast", clarifyPrompt.build({ requirement: accepted.requirement, ...(context ? { context } : {}) }), ledger, startedAt, dependencies);
    if (isPipelineResult(clarify)) return clarify;
    let clarifications: StoryAgentClarifications;
    try {
      const clarificationOutput = extractJson(clarify.text);
      if (refusalSchema.safeParse(clarificationOutput).success) {
        ledger.stages.push(stage("clarify", "failed", "Model refused request."));
        return result(ledger, "failed", [], { reason: "model_refusal" });
      }
      const parsed = clarifyResponseSchema.parse(clarificationOutput);
      clarifications = clarificationsSchema.parse({ questions: parsed.questions, assumptions: parsed.assumptions });
      if (parsed.needsClarification && clarifications.questions.length > 0) {
        return result(ledger, "questions", [], { questions: clarifications.questions });
      }
    } catch {
      ledger.stages.push(stage("clarify", "failed", "Invalid clarification output."));
      return result(ledger, "failed", [], { reason: "invalid_clarification_output" });
    }

    let generated = await request("generate", "generate", generatePrompt.build({
      requirement: accepted.requirement,
      ...(context ? { context } : {}),
      clarifications,
      existingTitles: gathered.titles
    }), ledger, startedAt, dependencies);
    if (isPipelineResult(generated)) return generated;
    let errors: readonly string[] = [];
    for (let repair = 0; repair <= 2; repair += 1) {
      let candidate: unknown;
      try { candidate = extractJson(generated.text); } catch { candidate = undefined; }
      if (refusalSchema.safeParse(candidate).success) {
        ledger.stages.push(stage("validate", "failed", "Model refused request."));
        return result(ledger, "failed", [], { reason: "model_refusal" });
      }
      const plan = planFromCandidate(candidate);
      if (plan !== undefined) {
        errors = withStoryStageSpan("story_agent.output.validate", () => validatePlan(plan, gathered.titles, dependencies.budget.maxStories), (validationErrors) => validationErrors.length === 0 ? "passed" : "failed");
        if (errors.length === 0) {
          if (repair > 0) recordValidationEvent("repair_succeeded");
          const parsedPlan = planSchema.parse(plan);
          return result(ledger, "draft", [], { plan: parsedPlan, stories: flattenPlan(parsedPlan) });
        }
      } else {
        const stories = isObjectWithStories(candidate) ? candidate.stories : undefined;
        errors = withStoryStageSpan("story_agent.output.validate", () => validateStories(stories, gathered.titles, dependencies.budget.maxStories), (validationErrors) => validationErrors.length === 0 ? "passed" : "failed");
        if (errors.length === 0) {
          if (repair > 0) recordValidationEvent("repair_succeeded");
          const parsedStories = generatedStoriesSchema.parse(candidate).stories;
          return result(ledger, "draft", [], { plan: legacyPlan(accepted.requirement, parsedStories), stories: parsedStories });
        }
      }
      ledger.stages.push(stage("validate", "failed", errors.join("; ")));
      recordValidationEvent("failed");
      if (repair === 2) return result(ledger, "failed", errors, { reason: "validation_failed" });
      recordValidationEvent("repair_attempt");
      generated = await request("repair", "generate", repairPrompt.build({
        requirement: accepted.requirement,
        clarifications,
        previousOutput: generated.text.slice(0, maxRepairOutputCharacters),
        validationErrors: errors.slice(0, maxRepairErrors).map((error) => error.slice(0, maxRepairErrorCharacters))
      }), ledger, startedAt, dependencies);
      if (isPipelineResult(generated)) return generated;
    }
    return result(ledger, "failed", errors, { reason: "validation_failed" });
  }
});

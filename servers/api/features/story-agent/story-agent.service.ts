import { z } from "zod";
import type { StoryAgentProjectRules, StoryAgentDiagnostic } from "@workspace/types";
import type { LlmCompletion, LlmOutputContract } from "../../integrations/index.js";
import { emptyAccounting, type StoryAgentAccounting, type StoryAgentExecution } from "./story-agent.execution.js";
import { clarificationOutputContract, generationOutputContract, refinementOutputContract, parseGeneratedOutput } from "./story-agent.output.js";
import { projectRulesPrompt } from "./story-agent.projects.js";
import { intelligencePrompt, titleMatchFindings, validateIntelligence, type IntelligenceInput } from "./story-agent.intelligence.js";
import { evidencePrompt, exactTitleFindings, uniqueFindings, validateEvidence } from "./story-agent.evidence.js";
import type { StoryAgentAnalysis } from "@workspace/types";
import type { StoryAgentIntelligenceFinding } from "@workspace/types";
import type { StoryAgentClarifications, StoryAgentPlan, StoryAgentStory, StoryAgentUsage, StoryAgentQualityReport, StoryAgentRefinementChange } from "@workspace/types";
import { explainQuality } from "./story-agent.quality.js";
import { mergeRefinedArtifact, refinementPrompt, refinementChanges, type RefinementInput } from "./story-agent.refinement.js";
import { extractJson } from "./story-agent.json.js";
import { isStoryAgentRouterError, type StoryAgentProviderRouter } from "./story-agent.router.js";
import { clarificationsSchema, planSchema, storySchema } from "./story-agent.validation.js";
import * as clarifyPrompt from "./story-agent.clarify.prompt.js";
import * as generatePrompt from "./story-agent.generate.prompt.js";
import * as repairPrompt from "./story-agent.repair.prompt.js";
import { recordValidationEvent, withStoryStageSpan } from "./story-agent.telemetry.js";

export type StoryAgentExistingItem = Readonly<{ level: "initiative" | "epic" | "feature" | "story"; title: string }>;
export type StoryAgentBudget = Readonly<{ maxCalls: number; maxTotalTokens: number; timeoutMs: number; contextTokenLimit: number; maxPromptCharacters?: number; maxStories: number }>;
export type StoryAgentStageOutcome = Readonly<{ stage: string; status: "completed" | "skipped" | "failed"; detail?: string }>;
export type StoryAgentPipelineResult = Readonly<{
  status: "questions" | "draft" | "failed" | "queued";
  questions?: readonly string[];
  stories?: readonly StoryAgentStory[];
  plan?: StoryAgentPlan;
  quality?: StoryAgentQualityReport;
  refinementChanges?: readonly StoryAgentRefinementChange[];
  attempts: number;
  usage: StoryAgentUsage;
  providers: readonly string[];
  stages: readonly StoryAgentStageOutcome[];
  validationErrors: readonly string[];
  reason?: string;
  diagnostic?: StoryAgentDiagnostic | undefined;
  accounting?: StoryAgentAccounting | undefined;
  retryAfterMs?: number | undefined;
}>;

export type StoryAgentPipelineInput = Readonly<{ requirement: string; context?: string | undefined; projectId?: string | undefined; projectRules?: StoryAgentProjectRules | undefined; existingItems?: readonly StoryAgentExistingItem[] | undefined; refinement?: RefinementInput; execution?: StoryAgentExecution | undefined }>;
type PipelineDependencies = Readonly<{ route: StoryAgentProviderRouter; now: () => number; budget: StoryAgentBudget; execution?: StoryAgentExecution | undefined }>;
export type StoryAgentIntelligenceResult = Readonly<{ status: "completed"; findings: readonly StoryAgentIntelligenceFinding[]; coverage?: StoryAgentAnalysis["coverage"] }> | Readonly<{ status: "failed"; reason: string }>;
type GatheredContext = Readonly<{ text: string; titles: readonly string[] }>;
type CompletionLedger = { calls: number; usage: StoryAgentUsage; providers: string[]; stages: StoryAgentStageOutcome[]; elapsedMs: number; priorElapsedMs: number; contentFailures: Record<string, number>; permanentFailures: Record<string, string> };
const promptCharacterLimit = (budget: StoryAgentBudget): number => budget.maxPromptCharacters ?? 24_000;

const intakeSchema = z.object({ requirement: z.string().trim().min(1).max(4_000), context: z.string().trim().max(8_000).optional() });
const clarifyResponseSchema = z.object({
  needsClarification: z.boolean(),
  questions: z.array(z.string().trim().min(1)).default([]),
  assumptions: z.array(z.string().trim().min(1)).default([])
});
const refusalSchema = z.object({ refusal: z.object({ reason: z.string().trim().min(1).max(1_000) }) });
const generatedStoriesSchema = z.object({ stories: z.array(storySchema) });
const refinementReasonsSchema = z.object({ changes: z.array(z.object({ path: z.string().trim().min(1).max(300), explanation: z.string().trim().min(1).max(1_000), reason: z.string().trim().min(1).max(1_000) })).min(1).max(300) });
const maxRepairOutputCharacters = 12_000;
const maxRepairErrors = 10;
const maxRepairErrorCharacters = 500;
const emptyLedger = (accounting = emptyAccounting()): CompletionLedger => ({ calls: accounting.physicalAttempts, usage: { ...accounting.usage }, providers: [...accounting.providers], stages: [], elapsedMs: accounting.elapsedMs, priorElapsedMs: accounting.elapsedMs, contentFailures: { ...accounting.contentFailures }, permanentFailures: { ...accounting.permanentFailures } });
const accountingSnapshot = (ledger: CompletionLedger, elapsedMs = ledger.elapsedMs): StoryAgentAccounting => ({ physicalAttempts: ledger.calls, usage: { ...ledger.usage }, elapsedMs, providers: [...ledger.providers], contentFailures: { ...ledger.contentFailures }, permanentFailures: { ...ledger.permanentFailures } });
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

export const flattenPlan = (plan: StoryAgentPlan): readonly StoryAgentStory[] => plan.initiative.epics.flatMap((epic) => epic.features.flatMap((feature) => feature.stories.map((story) => ({
  title: story.title,
  intent: story.intent,
  epic: epic.title,
  size: story.tasks.some((task) => task.effort === "L") ? "L" : story.tasks.some((task) => task.effort === "M") ? "M" : "S",
  acceptanceCriteria: story.acceptanceCriteria,
  states: story.metadata?.states ?? [],
  dependsOn: story.metadata?.dependsOn ?? [],
  openQuestions: story.metadata?.openQuestions ?? [],
  sliceRationale: story.metadata?.sliceRationale ?? `${feature.title}: ${feature.outcome}`
}))));

export const legacyPlan = (requirement: string, stories: readonly StoryAgentStory[]): StoryAgentPlan => ({
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

export const validatePlan = (plan: unknown, existingTitles: readonly string[], maxStories: number): readonly string[] => {
  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  return validateStories(flattenPlan(parsed.data), existingTitles, maxStories);
};

const result = (ledger: CompletionLedger, status: StoryAgentPipelineResult["status"], validationErrors: readonly string[], fields: Partial<StoryAgentPipelineResult> = {}): StoryAgentPipelineResult => ({
  status,
  attempts: ledger.calls,
  usage: ledger.usage,
  providers: ledger.providers,
  stages: ledger.stages,
  validationErrors,
  accounting: accountingSnapshot(ledger),
  ...fields
});

const addCompletion = (ledger: CompletionLedger, name: string, completion: Readonly<{ provider: string; usage: StoryAgentUsage }>): void => {
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
  || ledger.priorElapsedMs + dependencies.now() - startedAt >= dependencies.budget.timeoutMs;

const request = async (
  name: string,
  profile: "fast" | "generate",
  prompt: string,
  ledger: CompletionLedger,
  startedAt: number,
  dependencies: PipelineDependencies,
  outputContract?: LlmOutputContract
): Promise<LlmCompletion | StoryAgentPipelineResult> => {
  const checkpoint = async (reserveMs = 0): Promise<void> => {
    ledger.elapsedMs = ledger.priorElapsedMs + Math.max(0, dependencies.now() - startedAt);
    await dependencies.execution?.checkpoint?.(accountingSnapshot(ledger, ledger.elapsedMs + reserveMs), name);
  };
  const budgetFailure = (): StoryAgentPipelineResult => result(ledger, "failed", [], { reason: "over_budget", diagnostic: { category: "budget_exhausted", reason: "over_budget", stage: name, retryable: false } });
  if (ledger.calls >= dependencies.budget.maxCalls || runtimeBudgetExceeded(ledger, startedAt, dependencies)) {
    return budgetFailure();
  }
  if (prompt.length > promptCharacterLimit(dependencies.budget)) {
    ledger.stages.push(stage(name, "failed", "The assembled provider prompt exceeds the configured context limit."));
    return result(ledger, "failed", [], { reason: "context_limit" });
  }
  const callsBefore = ledger.calls;
  try {
    const contentExcluded = name === "clarify" ? [] : Object.keys(ledger.contentFailures).filter(provider => (ledger.contentFailures[provider] ?? 0) >= 2);
    const excluded = [...new Set([...contentExcluded, ...Object.keys(ledger.permanentFailures)])];
    const completion = await dependencies.route.complete({ profile, messages: [{ role: "user", content: prompt }], outputContract, excludeProviders: excluded,
      requireStructuredOutput: contentExcluded.length > 0 && outputContract !== undefined, execution: dependencies.execution, stage: name,
      onFailure: async (failure) => {
        if ([401, 403, 402, 404].includes(failure.status ?? 0)) ledger.permanentFailures[failure.provider] = failure.code;
        await checkpoint();
      },
      beforeAttempt: async (provider) => {
        const remaining = dependencies.budget.timeoutMs - ledger.priorElapsedMs - (dependencies.now() - startedAt);
        if (remaining <= 0 || ledger.calls >= dependencies.budget.maxCalls || ledger.usage.totalTokens >= dependencies.budget.maxTotalTokens) throw Object.assign(new Error("Provider execution budget exhausted."), { code: "over_budget" });
        const timeoutMs = Math.min(remaining, provider.timeoutMs); ledger.calls++;
        // Reserve the timeout durably before sending. A crash cannot refund an
        // unobserved request or restart its effective processing-time allowance.
        await checkpoint(timeoutMs);
        const remainingAfterCheckpoint = dependencies.budget.timeoutMs - ledger.priorElapsedMs - (dependencies.now() - startedAt);
        if (remainingAfterCheckpoint <= 0) throw Object.assign(new Error("Provider execution budget exhausted."), { code: "over_budget" });
        return { timeoutMs: Math.min(timeoutMs, remainingAfterCheckpoint), attempt: ledger.calls };
      }
    });
    // Direct deterministic router fakes have no transport admission hook.
    if (ledger.calls === callsBefore) ledger.calls++;
    addCompletion(ledger, name, completion);
    await checkpoint();
    if (runtimeBudgetExceeded(ledger, startedAt, dependencies)) return budgetFailure();
    return completion;
  } catch (error: unknown) {
    await checkpoint();
    if (error instanceof Error && "code" in error && error.code === "over_budget") return budgetFailure();
    if (error instanceof Error && "code" in error && (error.code === "stale_lease" || error.code === "checkpoint_failed")) throw error;
    if (isStoryAgentRouterError(error)) {
      if (error.code === "providers_unavailable" && ledger.calls >= dependencies.budget.maxCalls) return budgetFailure();
      ledger.stages.push(stage(name, error.code === "providers_unavailable" ? "skipped" : "failed", error.message));
      const temporary = error.code === "providers_unavailable";
      const diagnostic: StoryAgentDiagnostic = { category: temporary || error.code === "malformed_provider_response" ? "provider_transport" : error.code === "unsupported_structured_output" ? "unsupported_capability" : "provider_configuration", reason: error.causeCode ?? (error.code === "provider_rejected" ? Object.values(ledger.permanentFailures)[0] ?? error.code : error.code), stage: name, retryable: temporary, ...(error.provider ? { provider: error.provider } : {}), ...(error.model ? { model: error.model } : {}) };
      return result(ledger, temporary ? "queued" : "failed", [], { reason: error.code, diagnostic, ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) });
    }
    ledger.stages.push(stage(name, "failed", "Provider request failed."));
    return result(ledger, "failed", [], { reason: "provider_failed", diagnostic: { category: "provider_transport", reason: "provider_failed", stage: name, retryable: false } });
  }
};

const isPipelineResult = (value: Pick<LlmCompletion, "text"> | StoryAgentPipelineResult): value is StoryAgentPipelineResult => "status" in value;

export const createStoryAgentService = (dependencies: PipelineDependencies) => {
  const service = {
  analyze: async (input: IntelligenceInput): Promise<StoryAgentIntelligenceResult> => {
    const ledger = emptyLedger(); const startedAt = dependencies.now();
    let prompt: string;
    try { prompt = input.evidenceVersion === 2 ? evidencePrompt(input, promptCharacterLimit(dependencies.budget)) : intelligencePrompt(input, promptCharacterLimit(dependencies.budget) / 4); }
    catch { return { status: "failed", reason: "context_limit" }; }
    let correction = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const completion = await request("intelligence", "generate", prompt + correction, ledger, startedAt, dependencies);
      if (isPipelineResult(completion)) return { status: "failed", reason: completion.reason ?? "provider_failed" };
      try {
        if (input.evidenceVersion === 2) {
          const validated = validateEvidence(extractJson(completion.text), input);
          const findings = uniqueFindings([...exactTitleFindings(input), ...validated.findings]);
          const limited = findings.length > 50;
          return { status: "completed", findings: findings.slice(0, 50), coverage: { ...validated.coverage, status: limited ? "partial" : validated.coverage.status, reasons: [...validated.coverage.reasons, ...(limited ? ["The combined finding limit was reached; additional findings may exist."] : [])] } };
        }
        return { status: "completed", findings: [...titleMatchFindings(input), ...validateIntelligence(extractJson(completion.text), input)] };
      } catch { correction = input.evidenceVersion === 2 ? "\nThe previous review failed schema/reference/evidence validation. Return the specified findings JSON using only exact existing fields, counterpart quotes and reviewedArtifacts. Do not invent references." : "\nThe previous review failed schema/reference/evidence validation. Return the specified findings JSON using only exact existing paths and quotes. Do not invent references."; }
    }
    return { status: "failed", reason: "invalid_intelligence_output" };
  },
  run: async (input: StoryAgentPipelineInput): Promise<StoryAgentPipelineResult> => {
    const ledger = emptyLedger(input.execution?.accounting);
    const operation: PipelineDependencies = { ...dependencies, execution: input.execution };
    const startedAt = dependencies.now();
    let accepted: Readonly<{ requirement: string; context?: string | undefined }>;
    try {
      accepted = withStoryStageSpan("story_agent.requirement.validate", () => intake(input));
      ledger.stages.push(stage("intake", "completed"));
    } catch {
      ledger.stages.push(stage("intake", "failed", "Invalid requirement input."));
      return result(ledger, "failed", [], { reason: "invalid_input" });
    }
    const gathered = withStoryStageSpan("story_agent.context.gather", () => gatherContext(accepted.requirement, input.existingItems ?? [], dependencies.budget.contextTokenLimit));
    ledger.stages.push(stage("gatherContext", "completed"));
    let rulesContext: string;
    try { rulesContext = projectRulesPrompt(input.projectRules); }
    catch { return result(ledger, "failed", [], { reason: "invalid_project_rules" }); }
    const context = [accepted.context, gathered.text].filter(Boolean).join("\n");
    const clarify = input.refinement ? { text: JSON.stringify({ needsClarification: false, questions: [], assumptions: [] }) } : await request("clarify", "fast", rulesContext + clarifyPrompt.build({ requirement: accepted.requirement, ...(context ? { context } : {}) }), ledger, startedAt, operation, clarificationOutputContract);
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

    let generated = await request("generate", "generate", rulesContext + (input.refinement ? refinementPrompt(input.refinement) : "") + generatePrompt.build({
      requirement: accepted.requirement,
      ...(context ? { context } : {}),
      clarifications,
      existingTitles: gathered.titles
    }), ledger, startedAt, operation, input.refinement ? refinementOutputContract : generationOutputContract);
    if (isPipelineResult(generated)) return generated;
    let errors: readonly string[] = [];
    for (let repair = 0; repair <= 2; repair += 1) {
      const decoded = parseGeneratedOutput(generated);
      let candidate: unknown;
      try { candidate = extractJson(generated.text); } catch { candidate = undefined; }
      if (decoded.kind === "refusal") {
        ledger.stages.push(stage("validate", "failed", "Model refused request."));
        return result(ledger, "failed", [], { reason: "model_refusal" });
      }
      let plan: unknown = decoded.kind === "plan" ? decoded.plan : undefined;
      let diagnostic: StoryAgentDiagnostic = { category: decoded.kind === "invalid" ? decoded.category : "validation_failed", reason: "validation_failed", stage: repair ? "repair" : "generate", retryable: false, provider: generated.provider, model: generated.model, ...(decoded.kind === "invalid" ? { issues: decoded.issues } : {}) };
      errors = decoded.kind === "invalid" ? decoded.errors : [];
      if (input.refinement && decoded.kind === "plan") {
        try { plan = mergeRefinedArtifact(input.refinement, decoded.plan); }
        catch (error: unknown) {
          errors = [error instanceof Error ? error.message : "Story identity/context mapping could not be verified."];
          plan = undefined; candidate = undefined;
        }
      }
      if (plan !== undefined) {
        errors = withStoryStageSpan("story_agent.output.validate", () => validatePlan(plan, gathered.titles, dependencies.budget.maxStories), (validationErrors) => validationErrors.length === 0 ? "passed" : "failed");
        let explainedChanges: StoryAgentRefinementChange[] | undefined;
        if (input.refinement && errors.length === 0) {
          const reasons = refinementReasonsSchema.safeParse(candidate);
          const actual = refinementChanges(input.refinement.original, planSchema.parse(plan), input.refinement.artifactPath);
          if (!actual.length || !reasons.success || actual.some((change) => reasons.data.changes.filter((item) => item.path === change.path).length !== 1) || reasons.data.changes.length !== actual.length) {
            errors = ["Refinement must change the selected artifact and explain every changed field exactly once in changes[{path,explanation,reason}]."];
          } else explainedChanges = reasons.data.changes;
        }
        if (errors.length === 0) {
          if (repair > 0) recordValidationEvent("repair_succeeded");
          const parsedPlan = planSchema.parse(plan);
          return result(ledger, "draft", [], { plan: parsedPlan, stories: flattenPlan(parsedPlan), quality: explainQuality(parsedPlan, [], input.projectRules), ...(explainedChanges ? { refinementChanges: explainedChanges } : {}) });
        }
      } else if (!input.refinement && decoded.kind === "legacy") {
        const stories = decoded.stories;
        errors = withStoryStageSpan("story_agent.output.validate", () => validateStories(stories, gathered.titles, dependencies.budget.maxStories), (validationErrors) => validationErrors.length === 0 ? "passed" : "failed");
        if (errors.length === 0) {
          if (repair > 0) recordValidationEvent("repair_succeeded");
          const parsedStories = generatedStoriesSchema.parse(candidate).stories;
          return result(ledger, "draft", [], { plan: legacyPlan(accepted.requirement, parsedStories), stories: parsedStories, quality: explainQuality(legacyPlan(accepted.requirement, parsedStories), [], input.projectRules) });
        }
      }
      if (errors.length === 0) errors = ["The generated content does not satisfy the requested operation."];
      diagnostic = { ...diagnostic, issues: diagnostic.issues ?? errors.map(message => ({ path: "", code: "validation_failed", message })) };
      ledger.contentFailures[generated.provider] = (ledger.contentFailures[generated.provider] ?? 0) + 1;
      await input.execution?.checkpoint?.(accountingSnapshot(ledger), "validate");
      ledger.stages.push(stage("validate", "failed", errors.join("; ")));
      recordValidationEvent("failed");
      if (repair === 2) return result(ledger, "failed", errors, { reason: "validation_failed", diagnostic });
      recordValidationEvent("repair_attempt");
      generated = await request("repair", "generate", rulesContext + (input.refinement ? refinementPrompt(input.refinement) : "") + repairPrompt.build({
        requirement: accepted.requirement,
        context,
        existingTitles: gathered.titles,
        clarifications,
        previousOutput: generated.text.slice(0, maxRepairOutputCharacters),
        validationErrors: errors.slice(0, maxRepairErrors).map((error) => error.slice(0, maxRepairErrorCharacters))
      }), ledger, startedAt, operation, input.refinement ? refinementOutputContract : generationOutputContract);
      if (isPipelineResult(generated)) return { ...generated, validationErrors: errors, diagnostic: generated.diagnostic ? { ...generated.diagnostic, issues: diagnostic.issues } : diagnostic };
    }
    return result(ledger, "failed", errors, { reason: "validation_failed" });
  }
  };
  return { ...service, run: async (input: StoryAgentPipelineInput): Promise<StoryAgentPipelineResult> => {
    const startedAt = dependencies.now();
    const output = await service.run(input);
    const accounting = { ...(output.accounting ?? input.execution?.accounting ?? emptyAccounting()), elapsedMs: (input.execution?.accounting?.elapsedMs ?? 0) + Math.max(0, dependencies.now() - startedAt) };
    await input.execution?.checkpoint?.(accounting, "complete");
    if (output.status !== "failed" && accounting.elapsedMs >= dependencies.budget.timeoutMs) return {
      status: "failed", attempts: output.attempts, usage: output.usage, providers: output.providers, stages: output.stages,
      validationErrors: [], accounting, reason: "over_budget", diagnostic: { category: "budget_exhausted", reason: "over_budget", stage: "complete", retryable: false }
    };
    const diagnostic = output.diagnostic ?? (output.status === "failed" || output.status === "queued" ? {
      category: "generation_failed" as const, reason: output.reason ?? "generation_failed", stage: output.stages.at(-1)?.stage ?? "complete", retryable: output.status === "queued"
    } : undefined);
    return { ...output, accounting, diagnostic };
  } };
};

import { z } from "zod";
import type {
  StoryAgentClarifications,
  StoryAgentPlan,
  StoryAgentRequirementInput,
  StoryAgentRunStatus,
  StoryAgentStory
} from "@workspace/types";

const text = z.string().trim().min(1);

export const requirementInputSchema = z.object({
  requirement: text.max(4_000),
  context: z.string().trim().max(8_000).optional()
}) satisfies z.ZodType<StoryAgentRequirementInput>;

export const clarificationsSchema = z.object({
  questions: z.array(text).max(10),
  assumptions: z.array(text).max(10)
}) satisfies z.ZodType<StoryAgentClarifications>;

export const storySchema = z.object({
  title: text.max(240),
  intent: text.max(2_000),
  epic: text.max(240),
  size: z.enum(["S", "M", "L"]),
  acceptanceCriteria: z.array(text.max(1_000)).min(1).max(20),
  states: z.array(text.max(240)).max(20),
  dependsOn: z.array(text.max(240)).max(20),
  openQuestions: z.array(text.max(1_000)).max(20),
  sliceRationale: text.max(2_000)
}) satisfies z.ZodType<StoryAgentStory>;

const taskSchema = z.object({
  title: text.max(240),
  description: text.max(2_000),
  effort: z.enum(["S", "M", "L"])
});

const plannedStorySchema = z.object({
  title: text.max(240),
  intent: text.max(2_000),
  acceptanceCriteria: z.array(text.max(1_000)).min(1).max(20),
  tasks: z.array(taskSchema).min(1).max(20)
});

const featureSchema = z.object({
  title: text.max(240),
  outcome: text.max(2_000),
  stories: z.array(plannedStorySchema).min(1).max(20)
});

const epicSchema = z.object({
  title: text.max(240),
  objective: text.max(2_000),
  features: z.array(featureSchema).min(1).max(20)
});

export const planSchema = z.object({
  initiative: z.object({
    title: text.max(240),
    outcome: text.max(2_000),
    epics: z.array(epicSchema).min(1).max(10)
  })
}) satisfies z.ZodType<StoryAgentPlan>;

export const runStatusSchema = z.enum(["questions", "draft", "failed", "queued"]) satisfies z.ZodType<StoryAgentRunStatus>;

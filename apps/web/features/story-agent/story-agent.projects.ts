import { z } from "zod";
import type { StoryAgentProject, StoryAgentProjectRules } from "@workspace/types";

const level = z.enum(["initiative", "epic", "feature", "story", "task"]);
export const projectRulesSchema = z.object({
  glossary: z.array(z.object({ term: z.string(), definition: z.string(), aliases: z.array(z.string()) })),
  roles: z.array(z.object({ name: z.string(), description: z.string() })),
  naming: z.array(z.object({ level, prefix: z.string(), instructions: z.string() })),
  acceptanceCriteria: z.object({ format: z.enum(["given_when_then", "checklist", "custom"]), instructions: z.string(), examples: z.array(z.string()) }),
  rules: z.array(z.object({ id: z.string(), group: z.string(), level: z.enum(["all", "initiative", "epic", "feature", "story", "task"]), instruction: z.string(), enabled: z.boolean() }))
}) satisfies z.ZodType<StoryAgentProjectRules>;
export const projectSchema = z.object({ projectId: z.string(), name: z.string(), rules: projectRulesSchema, version: z.number().int().positive(), updatedAt: z.string() }) satisfies z.ZodType<StoryAgentProject>;
export const emptyProjectRules = (): StoryAgentProjectRules => ({ glossary: [], roles: [], naming: [], acceptanceCriteria: { format: "given_when_then", instructions: "", examples: [] }, rules: [] });

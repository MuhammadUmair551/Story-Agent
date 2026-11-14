import { z } from "zod";
import type { StoryAgentDiagnostic, StoryAgentPlan, StoryAgentStory } from "@workspace/types";
import type { LlmCompletion, LlmOutputContract } from "../../integrations/index.js";
import { planSchema, storySchema } from "./story-agent.validation.js";
import { extractJson, extractJsonText } from "./story-agent.json.js";

type Issue = NonNullable<StoryAgentDiagnostic["issues"]>[number];
type ParsedOutput = Readonly<{ kind: "plan"; plan: StoryAgentPlan }> | Readonly<{ kind: "legacy"; stories: readonly StoryAgentStory[] }>
  | Readonly<{ kind: "refusal" }> | Readonly<{ kind: "invalid"; category: StoryAgentDiagnostic["category"]; issues: readonly Issue[]; errors: readonly string[] }>;
const record = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const atPath = (value: unknown, path: readonly PropertyKey[]): unknown => path.reduce<unknown>((current, part) => typeof current === "object" && current !== null ? Reflect.get(current, part) : undefined, value);
const invalid = (category: StoryAgentDiagnostic["category"], message: string): ParsedOutput => ({ kind: "invalid", category, issues: [{ path: "", code: category, message }], errors: [message] });
const incomplete = (text: string): boolean => {
  const json = extractJsonText(text); let quoted = false; let escaped = false; let depth = 0;
  for (const character of json) {
    if (quoted) { if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') quoted = false; }
    else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") depth++;
    else if (character === "}" || character === "]") depth--;
  }
  return /^[{[]/.test(json.trim()) && (quoted || depth > 0);
};

export const parseGeneratedOutput = (completion: Pick<LlmCompletion, "text" | "finishReason">): ParsedOutput => {
  if (completion.finishReason === "length") return invalid("truncated_json", "The provider ended the output at its completion limit.");
  let candidate: unknown;
  try { candidate = extractJson(completion.text); }
  catch { return invalid(incomplete(completion.text) ? "truncated_json" : "invalid_json", incomplete(completion.text) ? "The generated JSON is incomplete." : "The generated content is not valid JSON."); }
  const root = record(candidate);
  if (!root) return invalid("unsupported_response_shape", "Expected a plan object or an explicit legacy stories object.");
  if (record(root.refusal) && typeof record(root.refusal)?.reason === "string") return { kind: "refusal" };
  const isPlan = "plan" in root || "initiative" in root;
  if (!isPlan && !("stories" in root)) return invalid("unsupported_response_shape", "Expected plan.initiative, initiative, or an explicit legacy stories array.");
  const value = isPlan ? ("plan" in root ? root.plan : root) : root;
  const parsed = isPlan ? planSchema.safeParse(value) : z.object({ stories: z.array(storySchema) }).safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => ({ path: issue.path.join("."), code: issue.code, message: issue.message }));
    const missing = parsed.error.issues.some(issue => issue.code === "invalid_type" && atPath(value, issue.path) === undefined);
    const category = missing ? "missing_required_field" : parsed.error.issues.some(issue => issue.code === "invalid_type") ? "invalid_field_type"
      : issues.some(issue => /stories|acceptanceCriteria|tasks/.test(issue.path)) ? "invalid_story_structure" : "validation_failed";
    return { kind: "invalid", category, issues, errors: issues.map(issue => `${issue.path}: ${issue.message}`) };
  }
  return isPlan ? { kind: "plan", plan: parsed.data as StoryAgentPlan } : { kind: "legacy", stories: (parsed.data as { stories: StoryAgentStory[] }).stories };
};

// Use the authoritative Zod contract, projecting only the portable strict subset.
// Optional historical metadata is outside new generation's wire contract. Full local
// validation still enforces all size/count/nonempty and semantic constraints.
const strictProjection = (value: unknown, historicalMetadata = false): Record<string, unknown> => {
  const schema = record(value) ?? {};
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  const properties = record(schema.properties);
  if (properties) {
    const keys = historicalMetadata ? Object.keys(properties) : required;
    return { type: "object", properties: Object.fromEntries(keys.map(key => [key, strictProjection(properties[key], historicalMetadata)])), required: keys, additionalProperties: false };
  }
  if (schema.type === "array") return { type: "array", items: strictProjection(schema.items, historicalMetadata) };
  return { ...(typeof schema.type === "string" ? { type: schema.type } : {}), ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {}) };
};
export const generationOutputContract: LlmOutputContract = Object.freeze({ name: "story_agent_plan", schema: strictProjection(z.toJSONSchema(z.object({ plan: planSchema }))) });
export const clarificationOutputContract: LlmOutputContract = Object.freeze({ name: "story_agent_clarification", schema: strictProjection(z.toJSONSchema(z.object({ needsClarification: z.boolean(), questions: z.array(z.string()), assumptions: z.array(z.string()) }))) });
export const refinementOutputContract: LlmOutputContract = Object.freeze({ name: "story_agent_refinement", schema: strictProjection(z.toJSONSchema(z.object({ plan: planSchema,
  changes: z.array(z.object({ path: z.string(), explanation: z.string(), reason: z.string() }))
})), true) });

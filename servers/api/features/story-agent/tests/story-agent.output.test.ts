import test from "node:test";
import assert from "node:assert/strict";
import { generationOutputContract, refinementOutputContract, parseGeneratedOutput } from "../story-agent.output.js";
import { plan } from "./story-agent.fixture.js";

const parsed = (value: unknown) => parseGeneratedOutput({ text: JSON.stringify(value) });
const missing = (field: string) => {
  const candidate = structuredClone(plan);
  Reflect.deleteProperty(candidate.initiative.epics[0]?.features[0] ?? {}, field);
  return parsed({ plan: candidate });
};
void test("missing nested feature outcome is reported at its exact schema path", () => {
  const result = missing("outcome");
  if (result.kind !== "invalid") assert.fail();
  assert.equal(result.category, "missing_required_field");
  assert.equal(result.issues[0]?.path, "initiative.epics.0.features.0.outcome");
});
void test("missing nested stories is a real stories-field error, not a root fallback", () => {
  const result = missing("stories"); if (result.kind !== "invalid") assert.fail();
  assert.equal(result.category, "missing_required_field");
  assert.equal(result.issues[0]?.path, "initiative.epics.0.features.0.stories");
});
for (const fixture of [
  { label: "invalid JSON", text: '{"plan": nope}', category: "invalid_json" },
  { label: "truncated JSON", text: '{"plan":{"initiative":', category: "truncated_json" },
  { label: "unsupported wrapper", text: JSON.stringify({ deliveryPlan: plan }), category: "unsupported_response_shape" },
  { label: "array root", text: "[]", category: "unsupported_response_shape" },
  { label: "invalid field type", text: JSON.stringify({ stories: "wrong" }), category: "invalid_field_type" }
]) void test(`distinguishes ${fixture.label} without inventing missing legacy stories`, () => {
  const result = parseGeneratedOutput({ text: fixture.text }); if (result.kind !== "invalid") assert.fail();
  assert.equal(result.category, fixture.category);
  if (fixture.category !== "invalid_field_type") assert.doesNotMatch(result.errors.join(" "), /stories: Invalid input/);
});
void test("provider truncation metadata is retained even when the JSON prefix parses", () => {
  const result = parseGeneratedOutput({ text: JSON.stringify({ plan }), finishReason: "length" });
  if (result.kind !== "invalid") assert.fail(); assert.equal(result.category, "truncated_json");
});
void test("invalid acceptance criteria are distinct from JSON and missing-field failures", () => {
  const candidate = structuredClone(plan); const story = candidate.initiative.epics[0]?.features[0]?.stories[0]; assert.ok(story);
  Reflect.set(story, "acceptanceCriteria", []);
  const result = parsed({ plan: candidate }); if (result.kind !== "invalid") assert.fail();
  assert.equal(result.category, "invalid_story_structure"); assert.match(result.issues[0]?.path ?? "", /acceptanceCriteria/);
});
void test("valid wrapped and unwrapped plans retain every required field", () => {
  assert.equal(parsed({ plan }).kind, "plan"); assert.equal(parsed(plan).kind, "plan");
  assert.equal(parsed({ refusal: { reason: "Fixture refusal" } }).kind, "refusal");
});
void test("strict generation contract derives required nested fields from the authoritative schema", () => {
  const schema = JSON.stringify(generationOutputContract.schema);
  for (const field of ["outcome", "objective", "description", "stories", "acceptanceCriteria", "tasks"]) assert.ok(schema.includes(`"${field}"`));
  assert.ok(schema.includes('"additionalProperties":false'));
  assert.equal(schema.includes('"artifactId"'), false);
  assert.equal(schema.includes('"metadata"'), false);
});

void test("strict refinement contract retains stable story context and exact change explanations", () => {
  const schema = JSON.stringify(refinementOutputContract.schema);
  for (const field of ["artifactId", "metadata", "states", "dependsOn", "openQuestions", "sliceRationale", "changes", "path", "explanation", "reason"]) assert.ok(schema.includes(`"${field}"`));
});

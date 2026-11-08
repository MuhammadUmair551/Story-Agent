import test from "node:test";
import assert from "node:assert/strict";
import { flattenPlan, createStoryAgentService } from "../story-agent.service.js";
import { hasStoryContext, plannedStories, withStoryContext } from "../story-agent.metadata.js";
import { mergeRefinedArtifact, refinementChanges } from "../story-agent.refinement.js";
import { plan } from "./story-agent.fixture.js";

const saved = flattenPlan(plan).map((story, index) => ({ ...story, states: [`ready-${String(index)}`], dependsOn: [`prerequisite-${String(index)}`], openQuestions: [`question-${String(index)}`], sliceRationale: `Original rationale ${String(index)}` }));
const identified = (): typeof plan => withStoryContext("run-one", plan, saved);
const featurePath = "initiative.epics.0.features.0";
const storyPath = `${featurePath}.stories.0`;

void test("title-only refinement retains every legacy context field by stable ID", () => {
  const original = identified(); const candidate = structuredClone(original);
  const story = candidate.initiative.epics[0]?.features[0]?.stories[0]; assert.ok(story);
  const proposed = mergeRefinedArtifact({ original, artifactPath: storyPath, instructions: "Clarify title" }, { initiative: { ...candidate.initiative, epics: candidate.initiative.epics.map((epic) => ({ ...epic, features: epic.features.map((feature) => ({ ...feature, stories: feature.stories.map((item, index) => index === 0 ? { ...item, title: "A reader returns to the saved chapter", metadata: undefined } : item) })) })) } });
  assert.equal(plannedStories(proposed)[0]?.artifactId, story.artifactId);
  assert.deepEqual(plannedStories(proposed)[0]?.metadata, plannedStories(original)[0]?.metadata);
  assert.deepEqual(flattenPlan(proposed)[0]?.states, saved[0]?.states);
  assert.deepEqual(flattenPlan(proposed)[0]?.dependsOn, saved[0]?.dependsOn);
  assert.deepEqual(flattenPlan(proposed)[0]?.openQuestions, saved[0]?.openQuestions);
  assert.equal(flattenPlan(proposed)[0]?.sliceRationale, saved[0]?.sliceRationale);
  assert.deepEqual(plannedStories(proposed)[1], plannedStories(original)[1]);
});

void test("content edits preserve context and unaffected hierarchy artifacts across repeated revisions", () => {
  const original = identified();
  const candidate = { initiative: { ...original.initiative, outcome: "Unrelated edit", epics: original.initiative.epics.map((epic) => ({ ...epic, features: epic.features.map((feature) => ({ ...feature, stories: feature.stories.map((story, index) => index === 0 ? { ...story, title: "A renamed story", intent: "Resume from the stored offset", acceptanceCriteria: ["Given a saved offset, when opened, then reading resumes there."], metadata: undefined } : story) })) })) } };
  const first = mergeRefinedArtifact({ original, artifactPath: storyPath, instructions: "Clarify benefit" }, candidate);
  const second = mergeRefinedArtifact({ original: first, artifactPath: "initiative", instructions: "Clarify initiative title" }, { initiative: { ...first.initiative, title: "Reader confidence" } });
  assert.deepEqual(plannedStories(second)[0]?.metadata, plannedStories(original)[0]?.metadata);
  assert.deepEqual(plannedStories(second)[1], plannedStories(original)[1]);
  assert.equal(second.initiative.outcome, original.initiative.outcome);
});

void test("subtree reorder/move carries each story's own metadata rather than the slot's context", () => {
  const original = identified();
  const candidate = { initiative: { ...original.initiative, epics: original.initiative.epics.map((epic) => ({ ...epic, features: epic.features.map((feature) => ({ ...feature, stories: [...feature.stories].reverse().map((story) => ({ ...story, title: `${story.title} clarified`, metadata: undefined })) })) })) } };
  const proposed = mergeRefinedArtifact({ original, artifactPath: featurePath, instructions: "Reorder delivery slices" }, candidate);
  assert.deepEqual(flattenPlan(proposed).map((story) => story.states), [saved[1]?.states, saved[0]?.states]);
  assert.deepEqual(plannedStories(proposed).map((story) => story.artifactId), plannedStories(original).map((story) => story.artifactId).reverse());
});

void test("explicit added/removed stories keep retained context and receive new stable IDs", () => {
  const original = identified(); const first = plannedStories(original)[0]; assert.ok(first);
  const candidate = { initiative: { ...original.initiative, epics: original.initiative.epics.map((epic) => ({ ...epic, features: epic.features.map((feature) => ({ ...feature, stories: [{ ...first, artifactId: "new:bookmark", metadata: undefined, title: "A reader bookmarks a chapter" }] })) })) } };
  const proposed = mergeRefinedArtifact({ original, artifactPath: featurePath, instructions: "Replace these slices with bookmark work" }, candidate);
  assert.ok(hasStoryContext(proposed));
  assert.notEqual(plannedStories(proposed)[0]?.artifactId, first.artifactId);
  assert.match(plannedStories(proposed)[0]?.artifactId ?? "", /^story:/);
  assert.ok(refinementChanges(original, proposed, featurePath).some((change) => change.path.includes("metadata")));
  assert.deepEqual(plannedStories(original)[0]?.metadata, { states: saved[0]?.states, dependsOn: saved[0]?.dependsOn, openQuestions: saved[0]?.openQuestions, sliceRationale: saved[0]?.sliceRationale });
});

void test("bootstrap validates original flat/nested links, including a different flat story order", () => {
  assert.deepEqual(withStoryContext("run-one", plan, [...saved].reverse()), identified());
  assert.notEqual(plannedStories(withStoryContext("another-run", plan, saved))[0]?.artifactId, plannedStories(identified())[0]?.artifactId);
  assert.throws(() => withStoryContext("run-one", plan, [...saved, saved[0] as NonNullable<typeof saved[0]>]), /unambiguously|no matching/);
  assert.throws(() => withStoryContext("run-one", plan, saved.map((story) => ({ ...story, title: "Unknown renamed legacy story" }))), /unambiguously/);
});

void test("uncertain, missing and duplicate identities fail explicitly without mutating originals", () => {
  const original = identified(); const before = JSON.stringify(original); const first = plannedStories(original)[0]; assert.ok(first);
  for (const id of [undefined, "story:unknown", plannedStories(original)[1]?.artifactId]) {
    const candidate = { initiative: { ...original.initiative, epics: original.initiative.epics.map((epic) => ({ ...epic, features: epic.features.map((feature) => ({ ...feature, stories: feature.stories.map((story, index) => index === 0 ? { ...story, artifactId: id } : story) })) })) } };
    assert.throws(() => mergeRefinedArtifact({ original, artifactPath: featurePath, instructions: "Refine safely" }, candidate), /identity|artifactId/);
  }
  assert.equal(JSON.stringify(original), before);
});

void test("metadata edits participate in the same explanation gate and proposal snapshots", async () => {
  const original = identified(); const first = plannedStories(original)[0]; assert.ok(first?.metadata);
  const metadata = first.metadata;
  const proposed = { initiative: { ...original.initiative, epics: original.initiative.epics.map((epic) => ({ ...epic, features: epic.features.map((feature) => ({ ...feature, stories: feature.stories.map((story, index) => index === 0 ? { ...story, metadata: { ...metadata, states: ["reviewed"] } } : story) })) })) } };
  const changes = refinementChanges(original, proposed, storyPath).map((change) => ({ ...change, explanation: "Changed the story state from ready to reviewed.", reason: "Apply the requested context correction." }));
  assert.deepEqual(changes.map((change) => change.path), [`${storyPath}.metadata.states.0`]);
  const service = createStoryAgentService({ now: () => 0, budget: { maxCalls: 6, maxTotalTokens: 1000, timeoutMs: 10000, contextTokenLimit: 6000, maxStories: 10 }, route: { complete: () => Promise.resolve({ text: JSON.stringify({ plan: proposed, changes }), provider: "fake", model: "test", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }) } });
  const result = await service.run({ requirement: "Readers resume a chapter", refinement: { original, artifactPath: storyPath, instructions: "Change state to reviewed" } });
  assert.equal(result.status, "draft"); assert.deepEqual(result.refinementChanges, changes);
  assert.deepEqual(flattenPlan(result.plan ?? original)[0]?.states, ["reviewed"]);
  assert.deepEqual(flattenPlan(original)[0]?.states, saved[0]?.states);
});

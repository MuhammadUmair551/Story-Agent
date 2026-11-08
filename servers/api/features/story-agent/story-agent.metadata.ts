import { createHash } from "node:crypto";
import type { StoryAgentPlan, StoryAgentPlannedStory, StoryAgentStory } from "@workspace/types";
import { storyMetadataSchema } from "./story-agent.validation.js";

const storyId = (source: string): string => `story:${createHash("sha256").update(source).digest("hex").slice(0, 24)}`;

export const mapPlanStories = (plan: StoryAgentPlan, map: (story: StoryAgentPlannedStory, path: string, epic: string, rationale: string) => StoryAgentPlannedStory): StoryAgentPlan => ({
  initiative: { ...plan.initiative, epics: plan.initiative.epics.map((epic, e) => ({ ...epic, features: epic.features.map((feature, f) => ({ ...feature,
    stories: feature.stories.map((story, s) => map(story, `initiative.epics.${String(e)}.features.${String(f)}.stories.${String(s)}`, epic.title, `${feature.title}: ${feature.outcome}`))
  })) })) }
});

export const plannedStories = (plan: StoryAgentPlan): readonly StoryAgentPlannedStory[] => plan.initiative.epics.flatMap((epic) => epic.features.flatMap((feature) => feature.stories));

export const hasStoryContext = (plan: StoryAgentPlan): boolean => {
  const stories = plannedStories(plan);
  return stories.length > 0 && stories.every((story) => story.artifactId !== undefined && /^story:[a-f0-9]{24}$/.test(story.artifactId) && storyMetadataSchema.safeParse(story.metadata).success)
    && new Set(stories.map((story) => story.artifactId)).size === stories.length;
};

// Bootstrap the existing generation-owned flat/nested relationship once. Subsequent
// revisions carry context by immutable ID, never by a mutable title or array position.
export const withStoryContext = (runId: string, plan: StoryAgentPlan, savedStories: readonly StoryAgentStory[] | undefined): StoryAgentPlan => {
  if (hasStoryContext(plan)) return plan;
  if (plannedStories(plan).some((story) => story.artifactId !== undefined || story.metadata !== undefined)) throw new Error("Story identity/context mapping is incomplete. Original content is retained; reconcile this entry before refining it.");
  const matched = new Set<number>();
  const identified = mapPlanStories(plan, (story, path, epic, rationale) => {
    const matches = (savedStories ?? []).map((saved, index) => ({ saved, index })).filter(({ saved }) => saved.title === story.title && saved.epic === epic && saved.intent === story.intent && JSON.stringify(saved.acceptanceCriteria) === JSON.stringify(story.acceptanceCriteria));
    const match = matches[0];
    if (savedStories?.length && (matches.length !== 1 || !match || matched.has(match.index))) throw new Error("Legacy story context cannot be mapped unambiguously. Original content is retained; reconcile this entry before refining it.");
    if (match) matched.add(match.index);
    return { ...story, artifactId: storyId(`${runId}:${path}`), metadata: match ? { states: match.saved.states, dependsOn: match.saved.dependsOn, openQuestions: match.saved.openQuestions, sliceRationale: match.saved.sliceRationale } : { states: [], dependsOn: [], openQuestions: [], sliceRationale: rationale } };
  });
  if (matched.size !== (savedStories?.length ?? 0)) throw new Error("Some legacy context has no matching hierarchy artifact. Original content is retained; reconcile this entry before refining it.");
  return identified;
};

export const preserveStoryContext = (original: StoryAgentPlan, proposed: StoryAgentPlan): StoryAgentPlan => {
  if (!hasStoryContext(original)) throw new Error("Refinement requires stable story IDs and context. Reload the saved entry before refining it.");
  const known = new Map(plannedStories(original).map((story) => [story.artifactId, story]));
  const seen = new Set<string>();
  return mapPlanStories(proposed, (story, _path, _epic, rationale) => {
    const id = story.artifactId;
    if (!id || seen.has(id)) throw new Error("Preserve each existing artifactId exactly once; use a unique new:<name> ID only for an explicitly added story.");
    seen.add(id);
    const prior = known.get(id);
    if (prior) return { ...story, metadata: story.metadata ?? prior.metadata };
    if (!/^new:[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("Unknown story identity. Keep the original artifactId when renaming, moving or refining an existing story.");
    const permanentId = storyId(`${[...known.keys()].sort().join(":")}:${id}`);
    if (known.has(permanentId) || seen.has(permanentId)) throw new Error("The new story identity is already in use.");
    seen.add(permanentId);
    return { ...story, artifactId: permanentId, metadata: story.metadata ?? { states: [], dependsOn: [], openQuestions: [], sliceRationale: rationale } };
  });
};

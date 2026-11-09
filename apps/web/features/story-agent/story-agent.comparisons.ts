import type { StoryAgentRun } from "./story-agent.types";

export const comparisonSelectionLimit = 25;
export const comparisonCandidates = (source: Pick<StoryAgentRun, "runId" | "projectId">, runs: readonly StoryAgentRun[]): readonly StoryAgentRun[] => {
  const seen = new Set<string>();
  return runs.filter((run) => {
    if (!run.runId || run.runId === source.runId || run.status !== "draft" || run.deletingAt !== undefined || run.projectId !== source.projectId || seen.has(run.runId)) return false;
    seen.add(run.runId); return true;
  });
};

export const updateComparisonSelection = (selected: readonly string[], id: string, checked: boolean, candidates: readonly StoryAgentRun[]): readonly string[] => {
  if (!checked) return selected.filter((runId) => runId !== id);
  if (selected.includes(id) || selected.length >= comparisonSelectionLimit || !candidates.some((run) => run.runId === id)) return selected;
  return [...selected, id];
};

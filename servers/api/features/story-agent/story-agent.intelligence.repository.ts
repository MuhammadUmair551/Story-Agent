import type { StoryAgentAnalysis } from "@workspace/types";
import type { MongoPersistence } from "../../integrations/index.js";
import type { StoryAgentRunDocument } from "./story-agent.repository.js";

export const createIntelligenceRepository = (db: MongoPersistence) => {
  const runs = db.getCollection<StoryAgentRunDocument>("story_agent_runs");
  const guard = (run: StoryAgentRunDocument) => ({
    runId: run.runId, status: "draft", deletingAt: { $exists: false },
    ...((run.refinementVersion ?? 0) === 0 ? { $or: [{ refinementVersion: 0 }, { refinementVersion: { $exists: false } }] } : { refinementVersion: run.refinementVersion }),
    intelligenceReviewVersion: run.intelligenceReviewVersion === undefined ? { $exists: false } : run.intelligenceReviewVersion
  });
  return Object.freeze({
    comparisonPage: async (source: StoryAgentRunDocument, limit: number, skip: number) => {
      const page = await runs.find({ runId: { $ne: source.runId }, projectId: source.projectId ?? { $exists: false }, status: "draft", deletingAt: { $exists: false } }, { sort: { createdAt: -1, runId: 1 }, skip, limit: limit + 1 });
      return { runs: page.slice(0, limit).map((run) => structuredClone(run)), hasMore: page.length > limit, nextSkip: skip + Math.min(limit, page.length) };
    },
    projectBacklog: async (projectId: string): Promise<readonly StoryAgentRunDocument[]> => (await runs.find({ projectId, status: "draft", deletingAt: { $exists: false } }, { limit: 27 })).map((run) => structuredClone(run)),
    save: async (run: StoryAgentRunDocument, analysis: StoryAgentAnalysis, now: string): Promise<boolean> => {
      return Boolean(await runs.findOneAndUpdate(guard(run), { $set: { analyses: [...(run.analyses ?? []), analysis], refinementVersion: (run.refinementVersion ?? 0) + 1, intelligenceReviewVersion: (run.intelligenceReviewVersion ?? 0) + 1, updatedAt: now } }));
    },
    saveDecision: async (run: StoryAgentRunDocument, analysis: StoryAgentAnalysis, now: string): Promise<boolean> => Boolean(await runs.findOneAndUpdate(guard(run), { $set: { analyses: (run.analyses ?? []).map((item) => item.id === analysis.id ? analysis : item), intelligenceReviewVersion: (run.intelligenceReviewVersion ?? 0) + 1, updatedAt: now } }))
  });
};
export type StoryAgentIntelligenceRepository = ReturnType<typeof createIntelligenceRepository>;

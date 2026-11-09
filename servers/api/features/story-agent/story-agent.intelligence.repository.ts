import type { StoryAgentAnalysis } from "@workspace/types";
import type { MongoPersistence } from "../../integrations/index.js";
import type { StoryAgentRunDocument } from "./story-agent.repository.js";

export const createIntelligenceRepository = (db: MongoPersistence) => {
  const runs = db.getCollection<StoryAgentRunDocument>("story_agent_runs");
  return Object.freeze({
    projectBacklog: async (projectId: string): Promise<readonly StoryAgentRunDocument[]> => (await runs.find({ projectId, status: "draft", deletingAt: { $exists: false } }, { limit: 27 })).map((run) => structuredClone(run)),
    save: async (run: StoryAgentRunDocument, analysis: StoryAgentAnalysis, now: string): Promise<boolean> => {
      const version = run.refinementVersion ?? 0;
      return Boolean(await runs.findOneAndUpdate({ runId: run.runId, deletingAt: { $exists: false }, ...(version === 0 ? { $or: [{ refinementVersion: 0 }, { refinementVersion: { $exists: false } }] } : { refinementVersion: version }) }, { $set: { analyses: [...(run.analyses ?? []), analysis], refinementVersion: version + 1, updatedAt: now } }));
    }
  });
};
export type StoryAgentIntelligenceRepository = ReturnType<typeof createIntelligenceRepository>;

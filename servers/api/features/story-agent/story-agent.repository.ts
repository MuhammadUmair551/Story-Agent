import type { StoryAgentPlan, StoryAgentRunStatus, StoryAgentStory, StoryAgentUsage } from "@workspace/types";
import type { MongoPersistence } from "../../integrations/index.js";
import type { StoryAgentStageOutcome } from "./story-agent.service.js";

export type StoryAgentRunDocument = Readonly<Record<string, unknown>> & Readonly<{
  runId: string;
  status: StoryAgentRunStatus;
  requirement: string;
  context?: string | undefined;
  questions?: readonly string[] | undefined;
  stories?: readonly StoryAgentStory[] | undefined;
  plan?: StoryAgentPlan | undefined;
  usage: StoryAgentUsage;
  providers: readonly string[];
  attempts: number;
  stages: readonly StoryAgentStageOutcome[];
  validationErrors: readonly string[];
  reason?: string | undefined;
  error?: string | undefined;
  nextAttemptAt?: string | null | undefined;
  expiresAt?: string | undefined;
  lockedUntil?: string | null | undefined;
  queueAttempts?: number | undefined;
  createdAt: string;
  updatedAt: string;
}>;

export type StoryAgentDraftDocument = Readonly<Record<string, unknown>> & Readonly<{
  runId: string;
  stories: readonly StoryAgentStory[];
  plan?: StoryAgentPlan | undefined;
  createdAt: string;
}>;

export type StoryAgentRepository = Readonly<{
  saveRun: (document: StoryAgentRunDocument) => Promise<void>;
  updateRunStatus: (runId: string, status: StoryAgentRunStatus, extra?: Partial<StoryAgentRunDocument>) => Promise<void>;
  getRun: (runId: string) => Promise<StoryAgentRunDocument | null>;
  listRuns: (input: Readonly<{ limit: number; skip: number }>) => Promise<StoryAgentRunDocument[]>;
  saveDraft: (document: StoryAgentDraftDocument) => Promise<void>;
  getDraftByRun: (runId: string) => Promise<StoryAgentDraftDocument | null>;
  countQueuedRuns: () => Promise<number>;
  getQueueStats?: () => Promise<Readonly<{ depth: number; oldestCreatedAt?: string | undefined }>>;
  claimQueuedRun: (now: string, lockedUntil: string) => Promise<StoryAgentRunDocument | null>;
  ensureIndexes: () => Promise<void>;
}>;

export const createStoryAgentRepository = (db: MongoPersistence): StoryAgentRepository => {
  const runs = db.getCollection<StoryAgentRunDocument>("story_agent_runs");
  const drafts = db.getCollection<StoryAgentDraftDocument>("story_agent_drafts");
  return Object.freeze({
    saveRun: async (document): Promise<void> => { await runs.insertOne(document); },
    updateRunStatus: async (runId, status, extra = {}): Promise<void> => {
      await runs.updateOne({ runId }, { $set: { ...extra, status } });
    },
    getRun: async (runId): Promise<StoryAgentRunDocument | null> => await runs.findOne({ runId }),
    listRuns: async ({ limit, skip }): Promise<StoryAgentRunDocument[]> => await runs.find({}, { sort: { createdAt: -1 }, limit, skip }),
    saveDraft: async (document): Promise<void> => { await drafts.insertOne(document); },
    getDraftByRun: async (runId): Promise<StoryAgentDraftDocument | null> => await drafts.findOne({ runId }),
    countQueuedRuns: async (): Promise<number> => await runs.countDocuments({ status: "queued" }),
    getQueueStats: async () => {
      const [depth, oldest] = await Promise.all([
        runs.countDocuments({ status: "queued" }),
        runs.find({ status: "queued" }, { sort: { createdAt: 1 }, limit: 1 })
      ]);
      return Object.freeze({ depth, ...(oldest[0] ? { oldestCreatedAt: oldest[0].createdAt } : {}) });
    },
    claimQueuedRun: async (now, lockedUntil): Promise<StoryAgentRunDocument | null> => await runs.findOneAndUpdate({
      status: "queued",
      nextAttemptAt: { $lte: now },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }]
    }, { $set: { lockedUntil, updatedAt: now }, $inc: { queueAttempts: 1 } }, { sort: { createdAt: 1 } }),
    ensureIndexes: async (): Promise<void> => {
      await runs.createIndex({ runId: 1 }, { unique: true, name: "story_agent_runs_run_id" });
      await runs.createIndex({ createdAt: -1 }, { name: "story_agent_runs_created_at" });
      await runs.createIndex({ status: 1, nextAttemptAt: 1, lockedUntil: 1, createdAt: 1 }, { name: "story_agent_runs_queue_claim" });
      await drafts.createIndex({ runId: 1 }, { unique: true, name: "story_agent_drafts_run_id" });
    }
  });
};

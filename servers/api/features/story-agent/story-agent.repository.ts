import type { StoryAgentPlan, StoryAgentRunStatus, StoryAgentStory, StoryAgentUsage, StoryAgentQualityReport, StoryAgentRefinement } from "@workspace/types";
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
  quality?: StoryAgentQualityReport | undefined;
  refinements?: readonly StoryAgentRefinement[] | undefined;
  refinementVersion?: number | undefined;
  deletingAt?: string | undefined;
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
  deleteRun: (runId: string, now: string) => Promise<"deleted" | "missing" | "busy">;
  saveRefinements: (runId: string, expectedVersion: number, refinements: readonly StoryAgentRefinement[], now: string) => Promise<boolean>;
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
    saveRefinements: async (runId, expectedVersion, refinements, now): Promise<boolean> => Boolean(await runs.findOneAndUpdate({
      runId, deletingAt: { $exists: false },
      ...(expectedVersion === 0 ? { $or: [{ refinementVersion: 0 }, { refinementVersion: { $exists: false } }] } : { refinementVersion: expectedVersion })
    }, { $set: { refinements, refinementVersion: expectedVersion + 1, updatedAt: now } })),
    deleteRun: async (runId, now) => {
      // A deletion marker prevents future queue claims. Active leases finish first.
      const marked = await runs.findOneAndUpdate({ runId, $or: [{ lockedUntil: null }, { lockedUntil: { $exists: false } }, { lockedUntil: { $lte: now } }] }, { $set: { deletingAt: now } });
      if (!marked) return await runs.findOne({ runId }) ? "busy" : "missing";
      // Keep the marked run if cleanup fails so the same deletion can be retried.
      await drafts.deleteOne({ runId });
      await runs.deleteOne({ runId });
      return "deleted";
    },
    countQueuedRuns: async (): Promise<number> => await runs.countDocuments({ status: "queued", deletingAt: { $exists: false } }),
    getQueueStats: async () => {
      const [depth, oldest] = await Promise.all([
        runs.countDocuments({ status: "queued", deletingAt: { $exists: false } }),
        runs.find({ status: "queued", deletingAt: { $exists: false } }, { sort: { createdAt: 1 }, limit: 1 })
      ]);
      return Object.freeze({ depth, ...(oldest[0] ? { oldestCreatedAt: oldest[0].createdAt } : {}) });
    },
    claimQueuedRun: async (now, lockedUntil): Promise<StoryAgentRunDocument | null> => await runs.findOneAndUpdate({
      status: "queued",
      deletingAt: { $exists: false },
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

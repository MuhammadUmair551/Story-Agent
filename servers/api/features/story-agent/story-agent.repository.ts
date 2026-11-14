import type { StoryAgentPlan, StoryAgentRunStatus, StoryAgentStory, StoryAgentUsage, StoryAgentQualityReport, StoryAgentRefinement } from "@workspace/types";
import type { MongoPersistence } from "../../integrations/index.js";
import type { StoryAgentStageOutcome } from "./story-agent.service.js";
import type { StoryAgentProjectRules } from "@workspace/types";
import type { StoryAgentAnalysis } from "@workspace/types";
import type { StoryAgentDiagnostic } from "@workspace/types";
import type { StoryAgentAccounting } from "./story-agent.execution.js";
import { randomUUID } from "node:crypto";

export type StoryAgentRunDocument = Readonly<Record<string, unknown>> & Readonly<{
  runId: string;
  ownerId?: string | undefined;
  status: StoryAgentRunStatus;
  requirement: string;
  projectId?: string | undefined;
  projectRules?: StoryAgentProjectRules | undefined;
  analyses?: readonly StoryAgentAnalysis[] | undefined;
  intelligenceReviewVersion?: number | undefined;
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
  reason?: string | null | undefined;
  error?: string | null | undefined;
  nextAttemptAt?: string | null | undefined;
  expiresAt?: string | undefined;
  lockedUntil?: string | null | undefined;
  queueAttempts?: number | undefined;
  leaseId?: string | null | undefined;
  candidateLeaseId?: string | null | undefined;
  resultLeaseId?: string | null | undefined;
  processing?: boolean | undefined;
  requestId?: string | undefined;
  traceId?: string | undefined;
  requestHash?: string | undefined;
  accounting?: StoryAgentAccounting | undefined;
  diagnostic?: StoryAgentDiagnostic | null | undefined;
  createdAt: string;
  updatedAt: string;
}>;

export type StoryAgentDraftDocument = Readonly<Record<string, unknown>> & Readonly<{
  runId: string;
  ownerId?: string | undefined;
  leaseId?: string | undefined;
  leaseGeneration?: number | undefined;
  stories: readonly StoryAgentStory[];
  plan?: StoryAgentPlan | undefined;
  createdAt: string;
}>;

export type StoryAgentRepository = Readonly<{
  saveRun: (document: StoryAgentRunDocument) => Promise<void>;
  updateRunStatus: (runId: string, status: StoryAgentRunStatus, extra?: Partial<StoryAgentRunDocument>, expectedLeaseId?: string) => Promise<void>;
  getRun: (runId: string) => Promise<StoryAgentRunDocument | null>;
  listRuns: (input: Readonly<{ limit: number; skip: number }>) => Promise<StoryAgentRunDocument[]>;
  saveDraft: (document: StoryAgentDraftDocument) => Promise<void>;
  getDraftByRun: (runId: string) => Promise<StoryAgentDraftDocument | null>;
  countQueuedRuns: () => Promise<number>;
  getQueueStats?: () => Promise<Readonly<{ depth: number; oldestCreatedAt?: string | undefined }>>;
  claimQueuedRun: (now: string, lockedUntil: string, leaseId?: string) => Promise<StoryAgentRunDocument | null>;
  ensureIndexes: () => Promise<void>;
  deleteRun: (runId: string, now: string) => Promise<"deleted" | "missing" | "busy">;
  saveRefinements: (runId: string, expectedVersion: number, refinements: readonly StoryAgentRefinement[], now: string, expectedReviewVersion?: number) => Promise<boolean>;
}>;

export const createStoryAgentRepository = (db: MongoPersistence, ownedQueueOnly = false): StoryAgentRepository => {
  const runs = db.getCollection<StoryAgentRunDocument>("story_agent_runs");
  const drafts = db.getCollection<StoryAgentDraftDocument>("story_agent_drafts");
  const queueOwner = ownedQueueOnly ? { ownerId: { $exists: true } } : {};
  return Object.freeze({
    saveRun: async (document): Promise<void> => { await runs.insertOne(document); },
    updateRunStatus: async (runId, status, extra = {}, expectedLeaseId): Promise<void> => {
      if (expectedLeaseId) {
        const updated = await runs.findOneAndUpdate({ runId, status: "queued", leaseId: expectedLeaseId }, { $set: { ...extra, status } });
        if (!updated) throw Object.assign(new Error("The run lease is no longer current."), { code: "stale_lease" });
      } else await runs.updateOne({ runId }, { $set: { ...extra, status } });
    },
    getRun: async (runId): Promise<StoryAgentRunDocument | null> => await runs.findOne({ runId }),
    listRuns: async ({ limit, skip }): Promise<StoryAgentRunDocument[]> => await runs.find({}, { sort: { createdAt: -1 }, limit, skip }),
    saveDraft: async (document): Promise<void> => {
      if (!document.leaseId) { await drafts.insertOne(document); return; }
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = await runs.findOne({ runId: document.runId, status: "queued", leaseId: document.leaseId, candidateLeaseId: document.leaseId });
        if (!current) throw Object.assign(new Error("The draft lease is no longer current."), { code: "stale_lease" });
        const generation = current.queueAttempts ?? 0;
        const candidate = { ...document, leaseGeneration: generation };
        const previous = await drafts.findOne({ runId: document.runId });
        if (previous) {
          if ((previous.leaseGeneration ?? 0) > generation) throw Object.assign(new Error("A newer draft has already been persisted."), { code: "stale_lease" });
          const saved = await drafts.findOneAndUpdate({ runId: document.runId, leaseId: previous.leaseId ?? null, leaseGeneration: previous.leaseGeneration ?? null }, { $set: candidate });
          if (saved) return;
        } else {
          try { await drafts.insertOne(candidate); return; }
          catch (error: unknown) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === 11000)) throw error; }
        }
      }
      throw Object.assign(new Error("Concurrent draft persistence needs reconciliation."), { code: "stale_lease" });
    },
    getDraftByRun: async (runId): Promise<StoryAgentDraftDocument | null> => {
      const draft = await drafts.findOne({ runId });
      if (!draft?.leaseId) return draft;
      const run = await runs.findOne({ runId });
      return run && draft.leaseId === (run.resultLeaseId ?? run.candidateLeaseId) ? draft : null;
    },
    saveRefinements: async (runId, expectedVersion, refinements, now, expectedReviewVersion): Promise<boolean> => Boolean(await runs.findOneAndUpdate({
      runId, deletingAt: { $exists: false },
      ...(expectedReviewVersion === undefined ? {} : { intelligenceReviewVersion: expectedReviewVersion }),
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
    countQueuedRuns: async (): Promise<number> => await runs.countDocuments({ ...queueOwner, status: "queued", deletingAt: { $exists: false } }),
    getQueueStats: async () => {
      const [depth, oldest] = await Promise.all([
        runs.countDocuments({ ...queueOwner, status: "queued", deletingAt: { $exists: false } }),
        runs.find({ ...queueOwner, status: "queued", deletingAt: { $exists: false } }, { sort: { createdAt: 1 }, limit: 1 })
      ]);
      return Object.freeze({ depth, ...(oldest[0] ? { oldestCreatedAt: oldest[0].createdAt } : {}) });
    },
    claimQueuedRun: async (now, lockedUntil, leaseId = randomUUID()): Promise<StoryAgentRunDocument | null> => await runs.findOneAndUpdate({
      ...queueOwner,
      status: "queued",
      deletingAt: { $exists: false },
      nextAttemptAt: { $lte: now },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }]
    }, { $set: { lockedUntil, leaseId, processing: true, updatedAt: now }, $inc: { queueAttempts: 1 } }, { sort: { createdAt: 1 } }),
    ensureIndexes: async (): Promise<void> => {
      await runs.createIndex({ runId: 1 }, { unique: true, name: "story_agent_runs_run_id" });
      await runs.createIndex({ createdAt: -1 }, { name: "story_agent_runs_created_at" });
      await runs.createIndex({ ownerId: 1, createdAt: -1 }, { name: "story_agent_runs_owner_created" });
      await runs.createIndex({ status: 1, nextAttemptAt: 1, lockedUntil: 1, createdAt: 1 }, { name: "story_agent_runs_queue_claim" });
      await drafts.createIndex({ runId: 1 }, { unique: true, name: "story_agent_drafts_run_id" });
    }
  });
};

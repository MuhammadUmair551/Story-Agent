import type { Logger } from "@workspace/logging";
import type { LlmGateway, MongoPersistence } from "../../integrations/index.js";
import { loadRouterConfig } from "./story-agent.config.js";
import { createStoryAgentProviderRouter } from "./story-agent.router.js";
import { createStoryAgentRepository } from "./story-agent.repository.js";
import { createStoryAgentService } from "./story-agent.service.js";
import { createStoryAgentQueue } from "./story-agent.queue.js";
import { createStoryAgentCapacity } from "./story-agent.capacity.js";
import { withStorySpan, recordGeneration } from "./story-agent.telemetry.js";
import { createProjectRepository } from "./story-agent.projects.repository.js";
import { createIntelligenceRepository } from "./story-agent.intelligence.repository.js";
import { createOwnedStoryPersistence } from "./story-agent.ownership.js";
import type { StoryAgentRouterConfig } from "./story-agent.router.js";
import { createQueueWriteGate } from "./story-agent.controller.js";
import { executionCorrelation } from "./story-agent.execution.js";

type Clock = Readonly<{ now: () => number }>;
type FeatureDependencies = Readonly<{ db: MongoPersistence; llm: LlmGateway; logger: Logger; clock: Clock; queueIntervalMs: number; maxConcurrentRuns: number; maxRequestsPerWindow: number; requestWindowMs: number; maxTrackedClients: number; routerConfig?: StoryAgentRouterConfig }>;

const budget = Object.freeze({ maxCalls: 6, maxTotalTokens: 12_000, timeoutMs: 60_000, contextTokenLimit: 6_000, maxPromptCharacters: 24_000, maxStories: 10 });

export const createStoryAgentFeature = ({ db, llm, logger, clock, queueIntervalMs, maxConcurrentRuns, maxRequestsPerWindow, requestWindowMs, maxTrackedClients, routerConfig }: FeatureDependencies) => {
  const router = createStoryAgentProviderRouter({
    config: routerConfig ?? loadRouterConfig(),
    createClient: llm.createClient,
    logger,
    clock
  });
  const pipeline = createStoryAgentService({ route: router, now: clock.now, budget });
  const service = Object.freeze({ analyze: async (input: Parameters<typeof pipeline.analyze>[0]) => await withStorySpan("story_agent.intelligence", {}, async (span) => {
    const result = await pipeline.analyze(input); span.setAttribute("story_agent.outcome", result.status); return result;
  }, (result) => result.status), run: async (input: Parameters<typeof pipeline.run>[0]) => {
    const startedAt = clock.now();
    return await withStorySpan("story_agent.generation", executionCorrelation(input.execution), async (span) => {
      const result = await pipeline.run(input);
      const durationMs = clock.now() - startedAt;
      span.setAttribute("story_agent.outcome", result.status);
      span.setAttribute("story_agent.attempt_count", result.attempts);
      recordGeneration(result.status, durationMs);
      logger.info("Story Agent pipeline completed.", { ...executionCorrelation(input.execution), stage: result.diagnostic?.stage ?? "complete", category: result.diagnostic?.category, status: result.status, reasonCode: result.reason ?? "none", providers: [...result.providers], attempts: result.attempts });
      return result;
    }, (result) => result.status);
  } });
  const repository = createStoryAgentRepository(db, true);
  const projects = createProjectRepository(db);
  const reviews = createIntelligenceRepository(db);
  const capacity = createStoryAgentCapacity({ maxConcurrentRuns, maxRequestsPerWindow, requestWindowMs, maxTrackedClients, clock });
  const serializeQueueWrite = createQueueWriteGate();
  const foregroundRuns = new Set<string>();
  const queue = createStoryAgentQueue({ repository, service, logger, clock, intervalMs: queueIntervalMs, capacity });
  return Object.freeze({
    routeDependencies: { db, logger, clock, repository, projects, reviews, service, capacity, serializeQueueWrite, foregroundRuns },
    scope: (ownerId: string) => {
      const ownedDb = createOwnedStoryPersistence(db, ownerId);
      const ownedRepository = createStoryAgentRepository(ownedDb);
      const ownedCapacity: typeof capacity = { ...capacity, acquire: () => capacity.acquire(ownerId) };
      return { ownerId, db: ownedDb, logger, clock, repository: { ...ownedRepository, countQueuedRuns: repository.countQueuedRuns }, projects: createProjectRepository(ownedDb), reviews: createIntelligenceRepository(ownedDb), service,
        capacity: ownedCapacity, serializeQueueWrite, foregroundRuns };
    },
    ensureIndexes: async (): Promise<void> => { await repository.ensureIndexes(); await projects.ensureIndexes(); },
    queue
  });
};

export { createStoryAgentRoutes } from "./routes/index.js";
export type { StoryAgentRouteDependencies } from "./routes/index.js";

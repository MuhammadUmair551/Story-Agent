import type { Logger } from "@workspace/logging";
import type { LlmGateway, MongoPersistence } from "../../integrations/index.js";
import { loadRouterConfig } from "./story-agent.config.js";
import { createStoryAgentProviderRouter } from "./story-agent.router.js";
import { createStoryAgentRepository } from "./story-agent.repository.js";
import { createStoryAgentService } from "./story-agent.service.js";
import { createStoryAgentQueue } from "./story-agent.queue.js";
import { createStoryAgentCapacity } from "./story-agent.capacity.js";
import { withStorySpan, recordGeneration } from "./story-agent.telemetry.js";

type Clock = Readonly<{ now: () => number }>;
type FeatureDependencies = Readonly<{ db: MongoPersistence; llm: LlmGateway; logger: Logger; clock: Clock; queueIntervalMs: number; maxConcurrentRuns: number; maxRequestsPerWindow: number; requestWindowMs: number; maxTrackedClients: number }>;

const budget = Object.freeze({ maxCalls: 6, maxTotalTokens: 12_000, timeoutMs: 60_000, contextTokenLimit: 6_000, maxStories: 10 });

export const createStoryAgentFeature = ({ db, llm, logger, clock, queueIntervalMs, maxConcurrentRuns, maxRequestsPerWindow, requestWindowMs, maxTrackedClients }: FeatureDependencies) => {
  const router = createStoryAgentProviderRouter({
    config: loadRouterConfig(),
    createClient: llm.createClient,
    logger,
    clock
  });
  const pipeline = createStoryAgentService({ route: router, now: clock.now, budget });
  const service = Object.freeze({ run: async (input: Parameters<typeof pipeline.run>[0]) => {
    const startedAt = clock.now();
    return await withStorySpan("story_agent.generation", {}, async (span) => {
      const result = await pipeline.run(input);
      const durationMs = clock.now() - startedAt;
      span.setAttribute("story_agent.outcome", result.status);
      span.setAttribute("story_agent.attempt_count", result.attempts);
      recordGeneration(result.status, durationMs);
      return result;
    }, (result) => result.status);
  } });
  const repository = createStoryAgentRepository(db);
  const capacity = createStoryAgentCapacity({ maxConcurrentRuns, maxRequestsPerWindow, requestWindowMs, maxTrackedClients, clock });
  const queue = createStoryAgentQueue({ repository, service, logger, clock, intervalMs: queueIntervalMs, capacity });
  return Object.freeze({
    routeDependencies: { db, logger, clock, repository, service, capacity },
    ensureIndexes: repository.ensureIndexes,
    queue
  });
};

export { createStoryAgentRoutes } from "./routes/index.js";
export type { StoryAgentRouteDependencies } from "./routes/index.js";

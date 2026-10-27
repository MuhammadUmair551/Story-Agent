import type { ApiConfig, ValidatedApiEnvironment } from "../types/index.js";

export const createApiConfig = (environment: ValidatedApiEnvironment): ApiConfig => Object.freeze({
  environment: environment.NODE_ENV,
  host: environment.API_HOST,
  port: environment.API_PORT,
  webOrigin: environment.WEB_ORIGIN,
  logLevel: environment.LOG_LEVEL,
  queueIntervalMs: environment.QUEUE_INTERVAL_MS ?? 120_000,
  storyAgentMaxConcurrentRuns: environment.STORY_AGENT_MAX_CONCURRENT_RUNS ?? 2,
  storyAgentMaxRequestsPerWindow: environment.STORY_AGENT_MAX_REQUESTS_PER_WINDOW ?? 6,
  storyAgentRequestWindowMs: environment.STORY_AGENT_REQUEST_WINDOW_MS ?? 60_000,
  storyAgentMaxTrackedClients: environment.STORY_AGENT_MAX_TRACKED_CLIENTS ?? 1_000,
  ...(environment.MONGODB_URI ? { mongodbUri: environment.MONGODB_URI } : {})
});

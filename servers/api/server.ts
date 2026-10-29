import "dotenv/config";
import "./bootstrap/telemetry.js";
import "./bootstrap/runtime-metrics.js";
import { shutdownTelemetry } from "./bootstrap/telemetry.js";
import { createLogger } from "@workspace/logging";
import { createApp, createServer, createShutdown } from "./bootstrap/index.js";
import { createApiConfig, readApiEnvironment } from "./config/index.js";
import { apiRuntime } from "./constants/index.js";
import { createLlmGateway, createMongoDbIntegration } from "./integrations/index.js";
import { createStoryAgentFeature } from "./features/story-agent/index.js";

const startupLogger = createLogger({ service: apiRuntime.serviceName, level: "info", format: process.env.NODE_ENV === "production" ? "json" : "pretty" });
let config: ReturnType<typeof createApiConfig>;
try {
  config = createApiConfig(readApiEnvironment());
} catch (error: unknown) {
  startupLogger.error("API configuration validation failed.", {
    errorCode: "configuration_invalid",
    errorName: error instanceof Error ? error.name : "UnknownError"
  });
  throw new Error("API configuration validation failed.");
}
const logger = createLogger({
  service: apiRuntime.serviceName,
  level: config.logLevel,
  format: config.environment === "production" ? "json" : "pretty",
  environment: config.environment
});
const database = createMongoDbIntegration({
  logger,
  ...(config.mongodbUri ? { uri: config.mongodbUri } : {})
});
const llm = createLlmGateway({ fetch: globalThis.fetch });
try {
  await database.connect();
} catch (error: unknown) {
  logger.error("API dependency startup failed.", {
    dependency: "mongodb",
    errorName: error instanceof Error ? error.name : "UnknownError"
  });
  throw new Error("API dependency startup failed.");
}
const storyAgent = config.mongodbUri
  ? createStoryAgentFeature({ db: database, llm, logger, clock: { now: Date.now }, queueIntervalMs: config.queueIntervalMs, maxConcurrentRuns: config.storyAgentMaxConcurrentRuns, maxRequestsPerWindow: config.storyAgentMaxRequestsPerWindow, requestWindowMs: config.storyAgentRequestWindowMs, maxTrackedClients: config.storyAgentMaxTrackedClients })
  : undefined;
if (storyAgent) await storyAgent.ensureIndexes();
const app = createApp({ config, logger, persistence: database, ...(storyAgent ? { storyAgentRouteDependencies: storyAgent.routeDependencies } : {}) });
const server = createServer({ app, config, logger });

const shutdown = createShutdown({ database, logger, server });
await server.start();
storyAgent?.queue.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    storyAgent?.queue.stop();
    void shutdown(signal)
      .then(async () => {
        try { await shutdownTelemetry(); }
        catch (error: unknown) {
          logger.warn("Telemetry exporter flush failed during shutdown.", {
            errorName: error instanceof Error ? error.name : "UnknownError"
          });
        }
      })
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error("API shutdown failed.", { errorCode: "shutdown_failed", errorName: error instanceof Error ? error.name : "UnknownError" });
        process.exit(1);
      });
  });
}

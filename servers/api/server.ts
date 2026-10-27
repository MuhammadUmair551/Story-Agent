import { setServers } from "node:dns";
setServers(["8.8.8.8", "8.8.4.4"]);

import "dotenv/config";
import { createLogger } from "@workspace/logging";
import { createApp, createServer, createShutdown } from "./bootstrap/index.js";
import { createApiConfig, readApiEnvironment } from "./config/index.js";
import { apiRuntime } from "./constants/index.js";
import { createLlmGateway, createMongoDbIntegration } from "./integrations/index.js";
import { createStoryAgentFeature } from "./features/story-agent/index.js";

const config = createApiConfig(readApiEnvironment());
const logger = createLogger({
  service: apiRuntime.serviceName,
  level: config.logLevel,
  format: config.environment === "production" ? "json" : "pretty"
});
const database = createMongoDbIntegration({
  logger,
  ...(config.mongodbUri ? { uri: config.mongodbUri } : {})
});
const llm = createLlmGateway({ fetch: globalThis.fetch });
await database.connect();
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
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error("API shutdown failed.", { error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
      });
  });
}

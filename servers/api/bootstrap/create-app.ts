import express, { type Express } from "express";
import { createHttpLogger, type Logger } from "@workspace/logging";
import type { ApiConfig } from "../types/index.js";
import type { MongoPersistence } from "../integrations/index.js";
import { createStoryAgentRoutes, type StoryAgentRouteDependencies } from "../features/story-agent/index.js";
import { apiRuntime } from "../constants/index.js";
import { createHealthRoutes } from "../features/health/index.js";
import { createCorsMiddleware, createErrorHandler, createNotFoundHandler } from "../middleware/index.js";
import { createHttpTelemetry } from "./http-telemetry.js";

type AppDependencies = Readonly<{ config: ApiConfig; logger: Logger; persistence: MongoPersistence; storyAgentRouteDependencies?: StoryAgentRouteDependencies | undefined }>;

export const createApp = ({ config, logger, persistence, storyAgentRouteDependencies }: AppDependencies): Express => {
  const app = express();
  app.disable("x-powered-by");
  app.use(createHttpTelemetry());
  app.use(createHttpLogger({
    logger
  }));
  app.use(createCorsMiddleware({ origin: config.webOrigin }));
  app.use(express.json({ limit: apiRuntime.jsonBodyLimit }));
  const featureRouters = [createHealthRoutes({
    environment: config.environment,
    serviceName: apiRuntime.serviceName,
    persistence
  }), ...(storyAgentRouteDependencies ? [createStoryAgentRoutes(storyAgentRouteDependencies)] : [])];
  for (const featureRouter of featureRouters) app.use(featureRouter);
  app.use(createNotFoundHandler());
  app.use(createErrorHandler({ logger }));
  return app;
};

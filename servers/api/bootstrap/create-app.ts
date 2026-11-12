import express, { type Express } from "express";
import { createHttpLogger, type Logger } from "@workspace/logging";
import type { ApiConfig } from "../types/index.js";
import type { MongoPersistence } from "../integrations/index.js";
import { createStoryAgentRoutes, type StoryAgentRouteDependencies } from "../features/story-agent/index.js";
import { apiRuntime } from "../constants/index.js";
import { createHealthRoutes } from "../features/health/index.js";
import { createCorsMiddleware, createErrorHandler, createNotFoundHandler } from "../middleware/index.js";
import { createHttpTelemetry } from "./http-telemetry.js";
import type { AuthBoundary } from "../features/auth/index.js";

type AppDependencies = Readonly<{ config: ApiConfig; logger: Logger; persistence: MongoPersistence; storyAgentRouteDependencies?: StoryAgentRouteDependencies | undefined; authentication?: AuthBoundary | undefined; storyAgentScope?: ((ownerId: string) => StoryAgentRouteDependencies) | undefined }>;

export const createApp = ({ config, logger, persistence, storyAgentRouteDependencies, authentication, storyAgentScope }: AppDependencies): Express => {
  const app = express();
  app.disable("x-powered-by");
  app.use(createHttpTelemetry());
  app.use(createHttpLogger({
    logger
  }));
  app.use(createCorsMiddleware({ origin: config.webOrigin }));
  app.use(express.json({ limit: apiRuntime.jsonBodyLimit }));
  app.use((request, response, next) => {
    if (request.path.startsWith("/auth") || request.path.startsWith("/story-agent")) {
      response.setHeader("Cache-Control", "no-store"); response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
    }
    next();
  });
  if (authentication) app.use(authentication.router);
  else app.use("/auth", (_request, response) => { response.status(503).json({ error: "Authentication is not configured." }); });
  app.use("/story-agent", authentication?.requireUser ?? ((_request, response) => { response.status(401).json({ error: "Sign in to continue." }); }));
  const featureRouters = [createHealthRoutes({
    environment: config.environment,
    serviceName: apiRuntime.serviceName,
    persistence
  }), ...(storyAgentRouteDependencies && authentication && storyAgentScope ? [createStoryAgentRoutes(storyAgentRouteDependencies, (request) => storyAgentScope(authentication.ownerId(request)))] : [])];
  for (const featureRouter of featureRouters) app.use(featureRouter);
  app.use(createNotFoundHandler());
  app.use(createErrorHandler({ logger }));
  return app;
};

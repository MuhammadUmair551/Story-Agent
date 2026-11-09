import { createServer } from "node:http";
import express from "express";
import type { Logger } from "@workspace/logging";
import { createErrorHandler } from "../../../middleware/index.js";
import { createStoryAgentRoutes, type StoryAgentRouteDependencies } from "../routes/story-agent.route.js";
import { createStoryAgentRepository } from "../story-agent.repository.js";
import { createStoryAgentCapacity } from "../story-agent.capacity.js";
import { createProjectRepository } from "../story-agent.projects.repository.js";
import { createIntelligenceRepository } from "../story-agent.intelligence.repository.js";
import { createMemoryPersistence } from "./story-agent.memory.js";

export const withStoryApi = async (service: StoryAgentRouteDependencies["service"], action: (input: Readonly<{ request: (path: string, method?: string, body?: unknown) => Promise<Response>; repository: ReturnType<typeof createStoryAgentRepository>; memory: ReturnType<typeof createMemoryPersistence> }>) => Promise<void>): Promise<void> => {
  const memory = createMemoryPersistence(); const repository = createStoryAgentRepository(memory.db);
  const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const app = express(); app.use(express.json());
  app.use(createStoryAgentRoutes({ db: memory.db, repository, projects: createProjectRepository(memory.db), reviews: createIntelligenceRepository(memory.db), service, logger, clock: { now: () => 0 }, capacity: createStoryAgentCapacity({ maxConcurrentRuns: 10, maxRequestsPerWindow: 100, requestWindowMs: 60000, maxTrackedClients: 100, clock: { now: () => 0 } }) }));
  app.use(createErrorHandler({ logger }));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test API address");
  try { await action({ repository, memory, request: async (path, method = "GET", body) => await fetch(`http://127.0.0.1:${String(address.port)}/story-agent${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }) }); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); }); }
};

import { Router } from "express";
import type { Logger } from "@workspace/logging";
import type { MongoPersistence } from "../../../integrations/index.js";
import { createStoryAgentController } from "../story-agent.controller.js";
import type { StoryAgentCapacity } from "../story-agent.capacity.js";
import type { StoryAgentRepository } from "../story-agent.repository.js";
import type { StoryAgentPipelineResult } from "../story-agent.service.js";

type Clock = Readonly<{ now: () => number }>;
type Service = Readonly<{ run: (input: Readonly<{ requirement: string; context?: string | undefined }>) => Promise<StoryAgentPipelineResult> }>;
export type StoryAgentRouteDependencies = Readonly<{ db: MongoPersistence; logger: Logger; clock: Clock; repository: StoryAgentRepository; service: Service; capacity: StoryAgentCapacity }>;

export const createStoryAgentRoutes = ({ repository, service, capacity, clock }: StoryAgentRouteDependencies): Router => {
  const router = Router();
  const controller = createStoryAgentController({ repository, service, capacity, clock });
  router.post("/story-agent/runs", controller.createRun);
  router.get("/story-agent/runs", controller.listRuns);
  router.get("/story-agent/runs/:id", controller.getRun);
  return router;
};

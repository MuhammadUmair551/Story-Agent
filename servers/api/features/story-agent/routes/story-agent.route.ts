import { Router } from "express";
import type { Logger } from "@workspace/logging";
import type { MongoPersistence } from "../../../integrations/index.js";
import { createStoryAgentController } from "../story-agent.controller.js";
import type { StoryAgentCapacity } from "../story-agent.capacity.js";
import type { StoryAgentRepository } from "../story-agent.repository.js";
import type { StoryAgentPipelineResult, StoryAgentPipelineInput } from "../story-agent.service.js";
import type { StoryAgentProjectRepository } from "../story-agent.projects.repository.js";
import { createProjectController } from "../story-agent.projects.controller.js";
import { createIntelligenceController } from "../story-agent.intelligence.controller.js";
import type { StoryAgentIntelligenceRepository } from "../story-agent.intelligence.repository.js";
import type { IntelligenceInput } from "../story-agent.intelligence.js";
import type { StoryAgentIntelligenceResult } from "../story-agent.service.js";

type Clock = Readonly<{ now: () => number }>;
type Service = Readonly<{ run: (input: StoryAgentPipelineInput) => Promise<StoryAgentPipelineResult>; analyze?: (input: IntelligenceInput) => Promise<StoryAgentIntelligenceResult> }>;
export type StoryAgentRouteDependencies = Readonly<{ db: MongoPersistence; logger: Logger; clock: Clock; repository: StoryAgentRepository; projects: StoryAgentProjectRepository; reviews: StoryAgentIntelligenceRepository; service: Service; capacity: StoryAgentCapacity }>;

export const createStoryAgentRoutes = ({ repository, projects, reviews, service, capacity, clock }: StoryAgentRouteDependencies): Router => {
  const router = Router();
  const projectController = createProjectController(projects, clock.now);
  const controller = createStoryAgentController({ repository, service, capacity, clock, projects });
  router.get("/story-agent/projects", projectController.list);
  router.post("/story-agent/projects", projectController.create);
  router.put("/story-agent/projects/:projectId", projectController.update);
  router.delete("/story-agent/projects/:projectId", projectController.remove);
  router.post("/story-agent/runs", controller.createRun);
  router.get("/story-agent/runs", controller.listRuns);
  router.get("/story-agent/runs/:id", controller.getRun);
  router.delete("/story-agent/runs/:id", controller.deleteRun);
  router.post("/story-agent/runs/:id/refinements", controller.proposeRefinement);
  router.post("/story-agent/runs/:id/refinements/:proposalId/decision", controller.decideRefinement);
  router.post("/story-agent/runs/:id/analyses", createIntelligenceController({ repository, reviews, capacity, analyze: service.analyze, now: clock.now }));
  return router;
};

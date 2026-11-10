import { Router, type Request, type RequestHandler } from "express";
import type { Logger } from "@workspace/logging";
import type { MongoPersistence } from "../../../integrations/index.js";
import { createStoryAgentController } from "../story-agent.controller.js";
import type { QueueWriteGate } from "../story-agent.controller.js";
import type { StoryAgentCapacity } from "../story-agent.capacity.js";
import type { StoryAgentRepository } from "../story-agent.repository.js";
import type { StoryAgentPipelineResult, StoryAgentPipelineInput } from "../story-agent.service.js";
import type { StoryAgentProjectRepository } from "../story-agent.projects.repository.js";
import { createProjectController } from "../story-agent.projects.controller.js";
import { createIntelligenceController } from "../story-agent.intelligence.controller.js";
import type { StoryAgentIntelligenceRepository } from "../story-agent.intelligence.repository.js";
import type { IntelligenceInput } from "../story-agent.intelligence.js";
import type { StoryAgentIntelligenceResult } from "../story-agent.service.js";
import { createComparisonPageController, createFindingDecisionController } from "../story-agent.findings.controller.js";

type Clock = Readonly<{ now: () => number }>;
type Service = Readonly<{ run: (input: StoryAgentPipelineInput) => Promise<StoryAgentPipelineResult>; analyze?: (input: IntelligenceInput) => Promise<StoryAgentIntelligenceResult> }>;
export type StoryAgentRouteDependencies = Readonly<{ db: MongoPersistence; logger: Logger; clock: Clock; repository: StoryAgentRepository; projects: StoryAgentProjectRepository; reviews: StoryAgentIntelligenceRepository; service: Service; capacity: StoryAgentCapacity; serializeQueueWrite?: QueueWriteGate }>;

const handlers = ({ repository, projects, reviews, service, capacity, clock, serializeQueueWrite }: StoryAgentRouteDependencies) => {
  const projectController = createProjectController(projects, clock.now);
  const controller = createStoryAgentController({ repository, service, capacity, clock, projects, ...(serializeQueueWrite ? { serializeQueueWrite } : {}) });
  return { ...controller, listProjects: projectController.list, createProject: projectController.create, updateProject: projectController.update, deleteProject: projectController.remove,
    comparisons: createComparisonPageController(repository, reviews), analyze: createIntelligenceController({ repository, reviews, capacity, analyze: service.analyze, now: clock.now }), findingDecision: createFindingDecisionController(repository, reviews, clock.now) };
};

export const createStoryAgentRoutes = (dependencies: StoryAgentRouteDependencies, resolve?: (request: Request) => StoryAgentRouteDependencies): Router => {
  const router = Router(); const shared = handlers(dependencies);
  const handle = (key: keyof typeof shared): RequestHandler => (request, response, next) => (resolve ? handlers(resolve(request)) : shared)[key](request, response, next);
  router.get("/story-agent/projects", handle("listProjects"));
  router.post("/story-agent/projects", handle("createProject"));
  router.put("/story-agent/projects/:projectId", handle("updateProject"));
  router.delete("/story-agent/projects/:projectId", handle("deleteProject"));
  router.post("/story-agent/runs", handle("createRun"));
  router.get("/story-agent/runs", handle("listRuns"));
  router.get("/story-agent/runs/:id", handle("getRun"));
  router.get("/story-agent/runs/:id/comparisons", handle("comparisons"));
  router.delete("/story-agent/runs/:id", handle("deleteRun"));
  router.post("/story-agent/runs/:id/refinements", handle("proposeRefinement"));
  router.post("/story-agent/runs/:id/refinements/:proposalId/decision", handle("decideRefinement"));
  router.post("/story-agent/runs/:id/analyses", handle("analyze"));
  router.post("/story-agent/runs/:id/analyses/:analysisId/findings/:findingId/decision", handle("findingDecision"));
  return router;
};

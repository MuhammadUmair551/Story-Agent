import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { HTTP_STATUS } from "../../constants/index.js";
import { projectInputSchema, projectUpdateSchema } from "./story-agent.projects.js";
import type { StoryAgentProjectRepository } from "./story-agent.projects.repository.js";

export const createProjectController = (repository: StoryAgentProjectRepository, now: () => number) => {
  const handler = (operation: (request: Request, response: Response) => Promise<void>) => async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try { await operation(request, response); } catch (error: unknown) { next(error); }
  };
  return {
    list: handler(async (_request, response) => { const projects = await repository.list(); if (projects.length > 100) { response.status(HTTP_STATUS.badRequest).json({ error: "Project list exceeds the 100-project limit." }); return; } response.json({ projects }); }),
    create: handler(async (request, response) => {
      const input = projectInputSchema.parse(request.body);
      if ((await repository.list()).length >= 100) { response.status(HTTP_STATUS.badRequest).json({ error: "At most 100 active projects are supported." }); return; }
      const project = { ...input, projectId: randomUUID(), version: 1, updatedAt: new Date(now()).toISOString() };
      await repository.create(project); response.status(HTTP_STATUS.ok).json({ project });
    }),
    update: handler(async (request, response) => {
      const input = projectUpdateSchema.parse(request.body); const id = z.string().parse(request.params.projectId);
      const project = await repository.get(id);
      if (!project) { response.status(HTTP_STATUS.notFound).json({ error: "Project not found." }); return; }
      if (project.history.length >= 50) { response.status(HTTP_STATUS.conflict).json({ error: "Project revision limit reached. Create a new project to continue." }); return; }
      if (input.version !== project.version || !await repository.update(project, { name: input.name, rules: input.rules }, new Date(now()).toISOString())) { response.status(HTTP_STATUS.conflict).json({ error: "Project changed. Reload before saving." }); return; }
      const saved = await repository.get(id); response.json({ project: saved ? { projectId: saved.projectId, name: saved.name, rules: saved.rules, version: saved.version, updatedAt: saved.updatedAt } : null });
    }),
    remove: handler(async (request, response) => {
      const id = z.string().parse(request.params.projectId); const { version } = z.object({ version: z.number().int().min(1) }).parse(request.body);
      if (!await repository.get(id)) { response.status(HTTP_STATUS.notFound).json({ error: "Project not found." }); return; }
      if (!await repository.remove(id, version, new Date(now()).toISOString())) { response.status(HTTP_STATUS.conflict).json({ error: "Project changed. Reload before deleting." }); return; }
      response.json({ deleted: true });
    })
  };
};

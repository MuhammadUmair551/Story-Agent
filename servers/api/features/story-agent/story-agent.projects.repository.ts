import type { StoryAgentProject, StoryAgentProjectInput } from "@workspace/types";
import type { MongoPersistence } from "../../integrations/index.js";

type ProjectDocument = Readonly<Record<string, unknown>> & StoryAgentProject & Readonly<{ deletedAt?: string; history: readonly StoryAgentProject[] }>;
export const createProjectRepository = (db: MongoPersistence) => {
  const projects = db.getCollection<ProjectDocument>("story_agent_projects");
  return Object.freeze({
    list: async (): Promise<readonly StoryAgentProject[]> => (await projects.find({ deletedAt: { $exists: false } }, { sort: { updatedAt: -1 }, limit: 101 })).map(({ history: _history, ...project }) => project),
    get: async (projectId: string): Promise<ProjectDocument | null> => {
      const project = await projects.findOne({ projectId }); return project?.deletedAt ? null : project ? structuredClone(project) : null;
    },
    create: async (project: StoryAgentProject): Promise<void> => { await projects.insertOne({ ...project, history: [] }); },
    update: async (project: ProjectDocument, input: StoryAgentProjectInput, now: string): Promise<boolean> => {
      const { history, ...snapshot } = project;
      return Boolean(await projects.findOneAndUpdate({ projectId: project.projectId, version: project.version, deletedAt: { $exists: false } }, { $set: { ...input, version: project.version + 1, updatedAt: now, history: [...history, snapshot] } }));
    },
    remove: async (projectId: string, version: number, now: string): Promise<boolean> => Boolean(await projects.findOneAndUpdate({ projectId, version, deletedAt: { $exists: false } }, { $set: { deletedAt: now, updatedAt: now, version: version + 1 } })),
    ensureIndexes: async (): Promise<void> => { await projects.createIndex({ projectId: 1 }, { unique: true, name: "projectId_unique" }); }
  });
};
export type StoryAgentProjectRepository = ReturnType<typeof createProjectRepository>;

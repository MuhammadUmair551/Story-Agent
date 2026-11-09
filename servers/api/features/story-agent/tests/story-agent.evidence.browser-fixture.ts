// Isolated fake-provider/in-memory API for the committed browser journey. No live credentials or database.
import express from "express";
import { z } from "zod";
import { createStoryAgentRoutes } from "../routes/story-agent.route.js";
import { createStoryAgentRepository } from "../story-agent.repository.js";
import { createProjectRepository } from "../story-agent.projects.repository.js";
import { createIntelligenceRepository } from "../story-agent.intelligence.repository.js";
import { createStoryAgentService, flattenPlan } from "../story-agent.service.js";
import { artifactValue } from "../story-agent.refinement.js";
import { createStoryAgentCapacity } from "../story-agent.capacity.js";
import { createErrorHandler } from "../../../middleware/index.js";
import { createMemoryPersistence } from "./story-agent.memory.js";
import { plan } from "./story-agent.fixture.js";
import { planSchema } from "../story-agent.validation.js";

const memory = createMemoryPersistence(); const repository = createStoryAgentRepository(memory.db);
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
let unavailable = false; let partial = false;
const fields = ["outcome", "objective", "outcome", "intent", "description"];
const paths = ["initiative", "initiative.epics.0", "initiative.epics.0.features.0", "initiative.epics.0.features.0.stories.0", "initiative.epics.0.features.0.stories.0.tasks.0"];
const kinds = ["duplicate_behavior", "contradiction", "terminology", "duplicate_behavior", "contradiction"];
const dataSchema = z.object({ runId: z.string(), artifacts: z.array(z.object({ runId: z.string(), artifactPath: z.string(), fields: z.record(z.string(), z.string()) })) });
const service = createStoryAgentService({ now: Date.now, budget: { maxCalls: 6, maxTotalTokens: 12000, timeoutMs: 60000, contextTokenLimit: 6000, maxStories: 10 }, route: { complete: (request) => {
  if (unavailable) return Promise.reject(new Error("Isolated provider unavailable"));
  const prompt = request.messages[0]?.content ?? "";
  const raw = prompt.match(/<intelligence-data>(.*?)<\/intelligence-data>/s)?.[1];
  let value: unknown;
  if (raw) {
    const data = dataSchema.parse(JSON.parse(raw) as unknown);
    const reviewed = partial ? data.artifacts.slice(0, -1) : data.artifacts;
    const findings = paths.flatMap((artifactPath, index) => {
      const source = reviewed.find((item) => item.runId === data.runId && item.artifactPath === artifactPath);
      const counterpart = reviewed.find((item) => item.runId !== data.runId && item.artifactPath === artifactPath);
      return source && counterpart ? [{ kind: kinds[index], artifactPath, reason: "Compare the saved statements and their reader conditions.", suggestedUpdate: "Clarify the selected responsibility while retaining reader progress.", evidence: [source, counterpart].map((item) => ({ runId: item.runId, artifactPath, fieldPath: `${artifactPath}.${fields[index] ?? "title"}`, quote: item.fields[`${artifactPath}.${fields[index] ?? "title"}`] })), dependencies: [] }] : [];
    });
    value = { findings, reviewedArtifacts: reviewed.map(({ runId, artifactPath }) => ({ runId, artifactPath })), truncated: partial };
  } else {
    const refinement = z.object({ original: planSchema, artifactPath: z.string() }).parse(JSON.parse(prompt.match(/<refinement-data>(.*?)<\/refinement-data>/s)?.[1] ?? "null") as unknown);
    const proposed = structuredClone(refinement.original); const target = artifactValue(proposed, refinement.artifactPath);
    if (typeof target !== "object" || target === null || !("title" in target) || typeof target.title !== "string") throw new Error("Invalid fixture artifact.");
    target.title += " clarified";
    value = { plan: proposed, changes: [{ path: `${refinement.artifactPath}.title`, explanation: "Clarifies the selected responsibility.", reason: "Apply the reviewed suggestion." }] };
  }
  return Promise.resolve({ text: JSON.stringify(value), provider: "fake", model: "test", usage });
} } });

const start = async (): Promise<void> => {
  const comparisonPlan = structuredClone(plan);
  for (const [path, field, text] of [[paths[1], "objective", "Discard reading progress when closing the chapter."], [paths[2], "outcome", "Subscribers continue from a saved position."], [paths[4], "description", "Remove the last chapter and offset."]]) {
    const target = typeof path === "string" ? artifactValue(comparisonPlan, path) : undefined;
    if (typeof target === "object" && target !== null && typeof field === "string") Object.assign(target, { [field]: text });
  }
  for (let index = -1; index < 105; index++) {
    const source = index === -1;
    const savedPlan = source ? plan : comparisonPlan;
    await repository.saveRun({ runId: source ? "evidence-source" : `comparison-${String(index).padStart(3, "0")}`, projectId: "reading", requirement: source ? "Phase 4 evidence source" : `Historical reading comparison ${String(index)}`, plan: savedPlan, stories: flattenPlan(savedPlan), status: "draft", usage, attempts: 1, providers: [], stages: [], validationErrors: [], createdAt: new Date(Date.UTC(2026, 0, 1) - index * 1000).toISOString(), updatedAt: "now" });
  }
  const other = await repository.getRun("comparison-000");
  if (other) await repository.saveRun({ ...other, runId: "unrelated-project", projectId: "other", requirement: "Unrelated project entry" });
  const app = express(); app.use(express.json());
  app.use((request, response, next) => {
    response.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:3114"); response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-request-id"); response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (request.method === "OPTIONS") { response.sendStatus(204); return; } next();
  });
  app.get("/test/state", async (_request, response) => { response.json({ source: await repository.getRun("evidence-source") }); });
  app.post("/test/provider", (request, response) => { const input = z.object({ unavailable: z.boolean(), partial: z.boolean() }).parse(request.body); unavailable = input.unavailable; partial = input.partial; response.json({ updated: true }); });
  app.post("/test/change-comparison", async (_request, response) => { await repository.updateRunStatus("comparison-104", "draft", { refinementVersion: 1 }); response.json({ changed: true }); });
  app.use(createStoryAgentRoutes({ db: memory.db, repository, projects: createProjectRepository(memory.db), reviews: createIntelligenceRepository(memory.db), service, logger, clock: { now: Date.now }, capacity: createStoryAgentCapacity({ maxConcurrentRuns: 10, maxRequestsPerWindow: 100, requestWindowMs: 60000, maxTrackedClients: 100, clock: { now: Date.now } }) }));
  app.use(createErrorHandler({ logger }));
  app.listen(4214, "127.0.0.1", () => { console.log("Isolated Phase 4 browser API ready on 4214."); });
};
void start();

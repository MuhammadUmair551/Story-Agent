import { createServer } from "node:http";
import type { MongoPersistence, MongoDocument, MongoCollection } from "../../../integrations/index.js";
import { createApp } from "../../../bootstrap/index.js";
import { createApiConfig, readApiEnvironment } from "../../../config/index.js";
import { createAuthFeature } from "../index.js";
import { createAuthRepository } from "../auth.repository.js";
import { createMemoryPersistence } from "../../../tests/memory-persistence.js";
import { createStoryAgentFeature } from "../../story-agent/public.js";
import type { StoryAgentPlan } from "@workspace/types";
import { z } from "zod";
export const plan: StoryAgentPlan = { initiative: { title: "Reader continuity", outcome: "Readers resume chapters", epics: [{ title: "Reading", objective: "Resume progress", features: [{ title: "Chapter resume", outcome: "Continue reading", stories: [{ title: "A reader resumes a chapter", intent: "Continue reading", acceptanceCriteria: ["Given saved progress, when reading resumes, then the chapter opens at the saved position."], tasks: [{ title: "Restore position", description: "Read the stored offset and restore the chapter.", effort: "S" }] }] }] }] } };

export const authFixture = async (secure = false, origins = ["http://localhost:3000"], port = 0, delayQueueReads = false) => {
  const memory = createMemoryPersistence(); let time = Date.now();
  const now = () => time; const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const config = createApiConfig(readApiEnvironment({ NODE_ENV: "test", API_HOST: "127.0.0.1", API_PORT: "4000", WEB_ORIGIN: origins.join(","), LOG_LEVEL: "silent" }));
  const authConfig = { secure, publicOrigin: origins[0] ?? "http://localhost:3000" };
  const auth = await createAuthFeature({ db: memory.db, config: authConfig, origins, now });
  const storyDb: MongoPersistence = { getCollection: <T extends MongoDocument>(name: string): MongoCollection<T> => {
    const collection = memory.db.getCollection<T>(name);
    const countDocuments: MongoCollection<T>["countDocuments"] = async (filter) => {
      const count = await collection.countDocuments(filter);
      if (delayQueueReads && name === "story_agent_runs") await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
      return count;
    };
    return { ...collection, countDocuments };
  } };
  const feature = createStoryAgentFeature({ db: storyDb, logger, clock: { now }, queueIntervalMs: 60_000, maxConcurrentRuns: 10, maxRequestsPerWindow: 100, requestWindowMs: 60_000, maxTrackedClients: 100,
    routerConfig: { providers: ["fast", "generate"].map((name) => ({ name, model: "fixture", apiKey: "fixture-only", baseUrl: "https://provider.example.test/v1", timeoutMs: 1000 })), routes: { fast: ["fast"], generate: ["generate"], tools: ["generate"] }, cooldownMs: 1000 },
    llm: { createClient: (provider) => ({ complete: (request) => {
      const prompt = request.messages[0]?.content ?? "";
      const raw = prompt.match(/<intelligence-data>(.*?)<\/intelligence-data>/s)?.[1];
      let output: unknown = provider.name === "fast" ? { needsClarification: false, questions: [], assumptions: [] } : { plan };
      if (raw) {
        const data = z.object({ artifacts: z.array(z.object({ runId: z.string(), artifactPath: z.string() })).optional() }).parse(JSON.parse(raw) as unknown);
        output = data.artifacts ? { findings: [], reviewedArtifacts: data.artifacts, truncated: false } : { findings: [] };
      } else if (prompt.includes("<refinement-data>")) {
        const original = z.object({ original: z.object({ initiative: z.object({ title: z.string() }).loose() }).loose() }).parse(JSON.parse(prompt.match(/<refinement-data>(.*?)<\/refinement-data>/s)?.[1] ?? "null") as unknown).original;
        const refined = { ...original, initiative: { ...original.initiative, title: `${original.initiative.title} clarified` } };
        output = { plan: refined, changes: [{ path: "initiative.title", explanation: "Clarify the reader outcome.", reason: "Apply the requested wording." }] };
      }
      return Promise.resolve({ text: JSON.stringify(output), provider: provider.name, model: provider.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    } }) }
  });
  await feature.ensureIndexes(); const scope = feature.scope; const dependencies = feature.routeDependencies; const repository = dependencies.repository;
  const app = createApp({ config, logger, persistence: memory.db, authentication: auth, storyAgentRouteDependencies: dependencies, storyAgentScope: scope });
  const server = createServer(app); await new Promise<void>((resolve) => { server.listen(port, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server address");
  const base = `http://127.0.0.1:${String(address.port)}`;
  return { app, auth, authConfig, feature, memory, scope, repository, authRepository: createAuthRepository(memory.db), base, now,
    advance: (milliseconds: number) => { time += milliseconds; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => { if (error) reject(error); else resolve(); })); }
  };
};
export type AuthFixture = Awaited<ReturnType<typeof authFixture>>;
export const browserClient = (fixture: AuthFixture, origin = "http://localhost:3000") => {
  let cookie = ""; let csrf = "";
  return {
    cookie: () => cookie, csrf: () => csrf,
    request: async (path: string, method = "GET", body?: unknown, override: Record<string, string> = {}) => {
      const response = await fetch(`${fixture.base}${path}`, { method, headers: { Origin: origin, Cookie: cookie, "X-CSRF-Token": csrf, "Content-Type": "application/json", ...override }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = response.headers.get("set-cookie"); if (value) cookie = value.split(";")[0] ?? "";
      const data = await response.clone().json() as { csrfToken?: string }; if (data.csrfToken) csrf = data.csrfToken;
      return response;
    }
  };
};
export const signupAccount = async (fixture: AuthFixture, email: string) => {
  const client = browserClient(fixture); await client.request("/auth/session");
  const password = "A sufficiently long unique password!";
  const signup = await client.request("/auth/signup", "POST", { email, displayName: email.split("@")[0], password });
  if (signup.status !== 202) throw new Error("Test account signup failed");
  const login = await client.request("/auth/login", "POST", { email, password }); if (login.status !== 200) throw new Error("Test account login failed");
  return { client, password };
};

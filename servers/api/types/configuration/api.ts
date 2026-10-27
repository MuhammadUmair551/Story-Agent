import type { LogLevel } from "@workspace/logging";
import type { ApiEnvironment } from "@workspace/types";

export type ApiConfig = Readonly<{
  environment: ApiEnvironment;
  host: string;
  port: number;
  webOrigin: string;
  mongodbUri?: string;
  logLevel: LogLevel;
  queueIntervalMs: number;
  storyAgentMaxConcurrentRuns: number;
  storyAgentMaxRequestsPerWindow: number;
  storyAgentRequestWindowMs: number;
  storyAgentMaxTrackedClients: number;
}>;

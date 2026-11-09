import type { StoryAgentArtifactLevel } from "./story-agent.js";

export type StoryAgentProjectRules = Readonly<{
  glossary: readonly Readonly<{ term: string; definition: string; aliases: readonly string[] }>[];
  roles: readonly Readonly<{ name: string; description: string }>[];
  naming: readonly Readonly<{ level: StoryAgentArtifactLevel; prefix: string; instructions: string }>[];
  acceptanceCriteria: Readonly<{ format: "given_when_then" | "checklist" | "custom"; instructions: string; examples: readonly string[] }>;
  rules: readonly Readonly<{ id: string; group: string; level: StoryAgentArtifactLevel | "all"; instruction: string; enabled: boolean }>[];
}>;
export type StoryAgentProjectInput = Readonly<{ name: string; rules: StoryAgentProjectRules }>;
export type StoryAgentProject = StoryAgentProjectInput & Readonly<{
  projectId: string;
  version: number;
  updatedAt: string;
}>;

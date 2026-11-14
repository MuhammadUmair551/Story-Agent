import type { ProviderConfig } from "../../types/index.js";

// Deliberately narrow: OpenAI-compatible transport does not imply schema support.
// Expand only for documented and regression-tested model/endpoint combinations.
export const providerCapabilities = (config: Pick<ProviderConfig, "baseUrl" | "model">): Readonly<{ strictJsonSchema: boolean }> => {
  const url = new URL(config.baseUrl);
  return Object.freeze({ strictJsonSchema: url.origin === "https://api.groq.com" && !url.username && !url.password && !url.search && !url.hash
    && url.pathname.replace(/\/$/, "") === "/openai/v1"
    && ["openai/gpt-oss-20b", "openai/gpt-oss-120b"].includes(config.model) });
};

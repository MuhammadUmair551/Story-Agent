import type { ReactElement } from "react";
import { createApiConfiguration, readWebEnvironment } from "@/config";
import { StoryForge } from "@/features/story-agent";

const HomePage = (): ReactElement => {
  const api = createApiConfiguration(readWebEnvironment());
  return <StoryForge apiBaseUrl={api.baseUrl} />;
};

export default HomePage;

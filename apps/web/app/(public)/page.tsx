import type { ReactElement } from "react";
import { StoryForge } from "@/features/story-agent";
import { AccountSession } from "@/features/auth";
import { requireAccount } from "@/features/auth/auth.server";

const HomePage = async (): Promise<ReactElement> => {
  const user = await requireAccount();
  return <AccountSession user={user}><StoryForge apiBaseUrl="/api" /></AccountSession>;
};

export default HomePage;

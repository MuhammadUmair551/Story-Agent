import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createApiConfiguration, readWebEnvironment } from "@/config";
import type { AccountUser } from "@workspace/types";
const userSchema = z.object({ userId: z.string(), email: z.string(), displayName: z.string(), role: z.enum(["user", "admin"]), verified: z.boolean() });
export const requireAccount = async (): Promise<AccountUser> => {
  const jar = await cookies(); const session = jar.get("__Host-story_session") ?? jar.get("story_session");
  if (!session) redirect("/login");
  const base = createApiConfiguration(readWebEnvironment()).baseUrl.replace(/\/$/, "");
  const response = await fetch(`${base}/auth/session`, { headers: { Cookie: `${session.name}=${session.value}` }, cache: "no-store" });
  if (!response.ok) throw new Error("Account service is unavailable.");
  const parsed = z.object({ user: userSchema.nullable() }).parse(await response.json());
  if (!parsed.user?.verified) redirect("/login");
  return parsed.user;
};

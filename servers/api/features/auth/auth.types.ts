export type AuthUser = Readonly<Record<string, unknown>> & Readonly<{
  userId: string; email: string; displayName: string; passwordHash: string;
  role: "user" | "admin"; version: number; createdAt: string;
}>;
export type AuthSession = Readonly<Record<string, unknown>> & Readonly<{
  hash: string; csrf: string; userId: string | null; version: number;
  expiresAt: string; lastSeenAt: string; expiresOn: Date;
}>;
export type AuthConfig = Readonly<{
  publicOrigin: string; secure: boolean;
}>;
export const publicUser = (user: AuthUser) => ({ userId: user.userId, email: user.email, displayName: user.displayName, role: user.role });

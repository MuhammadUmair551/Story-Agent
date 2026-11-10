export type AuthUser = Readonly<Record<string, unknown>> & Readonly<{
  userId: string; email: string; displayName: string; passwordHash: string;
  role: "user" | "admin"; verified: boolean; version: number; createdAt: string;
}>;
export type AuthSession = Readonly<Record<string, unknown>> & Readonly<{
  hash: string; csrf: string; userId: string | null; version: number;
  expiresAt: string; lastSeenAt: string; expiresOn: Date;
}>;
export type AuthToken = Readonly<Record<string, unknown>> & Readonly<{
  hash: string; userId: string; version: number; purpose: "verify" | "reset";
  expiresAt: string; expiresOn: Date; usedAt: string | null;
}>;
export type AuthMail = Readonly<Record<string, unknown>> & Readonly<{
  id: string; encrypted: string; availableAt: string; lockedUntil: string | null;
  attempts: number; expiresAt: string; expiresOn: Date;
  status: "pending" | "failed";
}>;
export type AuthConfig = Readonly<{
  publicOrigin: string; secure: boolean; mailKey: string; from: string; apiKey: string;
}>;
export const publicUser = (user: AuthUser) => ({ userId: user.userId, email: user.email, displayName: user.displayName, role: user.role, verified: user.verified });

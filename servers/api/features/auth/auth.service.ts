import { randomUUID } from "node:crypto";
import type { AuthRepository } from "./auth.repository.js";
import type { AuthSession, AuthUser } from "./auth.types.js";
import { randomToken, tokenHash, hashPassword, verifyPassword } from "./auth.crypto.js";
import { publicUser } from "./auth.types.js";

export const authError = (status: number, message = "Authentication could not be completed.") => Object.assign(new Error(message), { status });
const iso = (time: number) => new Date(time).toISOString();
const signupResult = Object.freeze({ message: "Signup processed. Sign in with your email and password. If you already have an account, its existing password is unchanged." });

export const createAuthService = async ({ repository, now = Date.now }: Readonly<{ repository: AuthRepository; now?: () => number }>) => {
  const dummyHash = await hashPassword(randomToken());
  let hashes = 0;
  const hashWork = async <T>(work: () => Promise<T>): Promise<T> => {
    if (hashes >= 2) throw authError(429, "Please wait before trying again.");
    hashes++; try { return await work(); } finally { hashes--; }
  };
  const rate = async (kind: string, ip: string, email?: string): Promise<void> => {
    const windowMs = 15 * 60_000; const bucket = Math.floor(now() / windowMs);
    const expiresOn = new Date((bucket + 2) * windowMs);
    const ipLimit = kind === "session" ? 300 : kind === "login" ? 60 : 20;
    const allowed = await repository.allow(`${kind}:ip:${tokenHash(ip)}:${String(bucket)}`, ipLimit, expiresOn);
    const accountAllowed = email === undefined || await repository.allow(`${kind}:account:${tokenHash(email)}:${String(bucket)}`, kind === "login" ? 10 : 5, expiresOn);
    if (!allowed || !accountAllowed) throw authError(429, "Please wait before trying again.");
  };
  const newSession = async (user: AuthUser | null) => {
    const token = randomToken(); const expiresAt = iso(now() + (user ? 8 * 60 * 60_000 : 30 * 60_000));
    const session: AuthSession = { hash: tokenHash(token), csrf: randomToken(), userId: user?.userId ?? null, version: user?.version ?? 0, expiresAt, lastSeenAt: iso(now()), expiresOn: new Date(expiresAt) };
    await repository.saveSession(session);
    return { token, session, user: user ? publicUser(user) : null, csrfToken: session.csrf };
  };
  const resolve = async (token: string | undefined) => {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = await repository.session(tokenHash(token));
    if (!session) return null;
    if (session.expiresAt <= iso(now()) || now() - Date.parse(session.lastSeenAt) >= 30 * 60_000) { await repository.removeSession(session.hash); return null; }
    const user = session.userId ? await repository.user(session.userId) : null;
    if (session.userId && (!user || user.version !== session.version)) { await repository.removeSession(session.hash); return null; }
    await repository.touch(session.hash, iso(now()));
    return { session, user };
  };
  return Object.freeze({
    rate, resolve, newSession,
    signup: async (input: Readonly<{ email: string; password: string; displayName: string }>) => {
      const passwordHash = await hashWork(async () => await hashPassword(input.password));
      const user: AuthUser = { userId: randomUUID(), email: input.email, displayName: input.displayName, passwordHash, role: "user", version: 0, createdAt: iso(now()) };
      await repository.addUser(user);
      return signupResult;
    },
    login: async (email: string, password: string) => {
      const user = await repository.byEmail(email);
      const valid = await hashWork(async () => await verifyPassword(password, user?.passwordHash ?? dummyHash));
      if (!user || !valid) throw authError(401, "Email or password is invalid.");
      return user;
    },
    changePassword: async (user: AuthUser, currentPassword: string, newPassword: string): Promise<void> => {
      await hashWork(async () => {
        const current = await repository.user(user.userId);
        if (!current || current.version !== user.version || !await verifyPassword(currentPassword, current.passwordHash)) throw authError(401, "Current password is invalid or the session has changed.");
        if (currentPassword.normalize("NFC") === newPassword.normalize("NFC")) throw authError(400, "Choose a different password.");
        const passwordHash = await hashPassword(newPassword);
        if (!await repository.updateUser(current, { passwordHash })) throw authError(409, "Account changed. Sign in again.");
      });
    },
    logout: async (session: AuthSession) => { await repository.removeSession(session.hash); },
    profile: async (user: AuthUser, displayName: string) => {
      if (!await repository.profile(user, displayName)) throw authError(409, "Account changed. Sign in again.");
      return publicUser({ ...user, displayName });
    },
    logoutAll: async (user: AuthUser) => { if (!await repository.updateUser(user, {})) throw authError(409); },
    users: async (skip: number) => (await repository.listUsers(skip)).map(publicUser)
  });
};
export type AuthService = Awaited<ReturnType<typeof createAuthService>>;

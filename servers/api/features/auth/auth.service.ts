import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EmailSender } from "../../integrations/index.js";
import type { AuthRepository } from "./auth.repository.js";
import type { AuthConfig, AuthSession, AuthUser, AuthToken } from "./auth.types.js";
import { randomToken, tokenHash, hashPassword, verifyPassword, encryptMail, decryptMail } from "./auth.crypto.js";
import { publicUser } from "./auth.types.js";

export const authError = (status: number, message = "Authentication could not be completed.") => Object.assign(new Error(message), { status });
const iso = (time: number) => new Date(time).toISOString();
const generic = Object.freeze({ message: "If this address is eligible, an email with the next steps will arrive shortly." });
const mailSchema = z.object({ to: z.email(), subject: z.string(), text: z.string(), id: z.string() });
export const createAuthService = async ({ repository, config, sendEmail, now = Date.now, mailFailure = () => undefined }: Readonly<{ repository: AuthRepository; config: AuthConfig; sendEmail: EmailSender; now?: () => number; mailFailure?: () => void }>) => {
  const dummyHash = await hashPassword(randomToken());
  let hashes = 0; let delivering = false;
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
  const issue = async (user: AuthUser, purpose: AuthToken["purpose"]) => {
    const token = randomToken(); const expiresAt = iso(now() + (purpose === "verify" ? 24 * 60 * 60_000 : 30 * 60_000));
    await repository.addToken({ hash: tokenHash(token), userId: user.userId, version: user.version, purpose, expiresAt, expiresOn: new Date(expiresAt), usedAt: null });
    const id = randomUUID(); const link = `${config.publicOrigin}/${purpose === "verify" ? "verify-email" : "reset-password"}#token=${token}`;
    const message = { id, to: user.email, subject: purpose === "verify" ? "Verify your Story Agent email" : "Reset your Story Agent password", text: `Open this single-use link to ${purpose === "verify" ? "verify your email" : "reset your password"}:\n${link}\n\nIf you did not request this, ignore this message.` };
    await repository.enqueue({ id, status: "pending", encrypted: encryptMail(JSON.stringify(message), config.mailKey), availableAt: iso(now()), lockedUntil: null, attempts: 0, expiresAt, expiresOn: new Date(expiresAt) });
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
    if (session.userId && (!user || !user.verified || user.version !== session.version)) { await repository.removeSession(session.hash); return null; }
    await repository.touch(session.hash, iso(now()));
    return { session, user };
  };
  return Object.freeze({
    rate, resolve, newSession,
    signup: async (input: Readonly<{ email: string; password: string; displayName: string }>) => {
      const passwordHash = await hashWork(async () => await hashPassword(input.password));
      const user: AuthUser = { userId: randomUUID(), email: input.email, displayName: input.displayName, passwordHash, role: "user", verified: false, version: 0, createdAt: iso(now()) };
      if (await repository.addUser(user)) await issue(user, "verify");
      return generic;
    },
    login: async (email: string, password: string) => {
      const user = await repository.byEmail(email);
      const valid = await hashWork(async () => await verifyPassword(password, user?.passwordHash ?? dummyHash));
      if (!user || !valid || !user.verified) throw authError(401, "Email or password is invalid, or verification is incomplete.");
      return user;
    },
    email: async (email: string, purpose: AuthToken["purpose"]) => {
      const user = await repository.byEmail(email);
      if (user && (purpose === "verify" ? !user.verified : user.verified)) await issue(user, purpose);
      return generic;
    },
    verify: async (token: string) => {
      const item = await repository.consumeToken(tokenHash(token), "verify", iso(now()));
      const user = item ? await repository.user(item.userId) : null;
      if (!item || !user || user.verified || user.version !== item.version || !await repository.updateUser(user, { verified: true })) throw authError(400, "This link is invalid or expired.");
      return { message: "Email verified. You can now sign in." };
    },
    reset: async (token: string, password: string) => {
      const passwordHash = await hashWork(async () => await hashPassword(password));
      const item = await repository.consumeToken(tokenHash(token), "reset", iso(now()));
      const user = item ? await repository.user(item.userId) : null;
      if (!item || !user || !user.verified || user.version !== item.version || !await repository.updateUser(user, { passwordHash })) throw authError(400, "This link is invalid or expired.");
      return { message: "Password reset. Sign in with your new password." };
    },
    logout: async (session: AuthSession) => { await repository.removeSession(session.hash); },
    profile: async (user: AuthUser, displayName: string) => {
      if (!await repository.profile(user, displayName)) throw authError(409, "Account changed. Sign in again.");
      return publicUser({ ...user, displayName });
    },
    logoutAll: async (user: AuthUser) => { if (!await repository.updateUser(user, {})) throw authError(409); },
    users: async (skip: number) => (await repository.listUsers(skip)).map(publicUser),
    deliver: async (): Promise<void> => {
      if (delivering) return; delivering = true;
      try {
        for (let index = 0; index < 10; index++) {
          const job = await repository.claimMail(iso(now()), iso(now() + 60_000)); if (!job) break;
          if (job.expiresAt <= iso(now())) { await repository.removeMail(job.id); continue; }
          try { await sendEmail(mailSchema.parse(JSON.parse(decryptMail(job.encrypted, config.mailKey)))); await repository.removeMail(job.id); }
          catch { if (job.attempts >= 5) { await repository.failMail(job.id); mailFailure(); } else await repository.retryMail(job.id, iso(now() + Math.min(30 * 60_000, 30_000 * 2 ** job.attempts))); }
        }
      } finally { delivering = false; }
    }
  });
};
export type AuthService = Awaited<ReturnType<typeof createAuthService>>;

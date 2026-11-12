import type { MongoPersistence } from "../../integrations/index.js";
import type { AuthUser, AuthSession } from "./auth.types.js";

type Rate = Readonly<Record<string, unknown>> & Readonly<{ key: string; count: number; expiresOn: Date }>;
export const createAuthRepository = (db: MongoPersistence) => {
  const users = db.getCollection<AuthUser>("auth_users"); const sessions = db.getCollection<AuthSession>("auth_sessions");
  const rates = db.getCollection<Rate>("auth_rates");
  return Object.freeze({
    user: async (userId: string) => await users.findOne({ userId }),
    byEmail: async (email: string) => await users.findOne({ email }),
    addUser: async (user: AuthUser) => { try { await users.insertOne(user); return true; } catch (error: unknown) { if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) return false; throw error; } },
    updateUser: async (user: AuthUser, changes: Partial<AuthUser>) => Boolean((await users.updateOne({ userId: user.userId, version: user.version }, { $set: { ...changes, version: user.version + 1 } })).matchedCount),
    profile: async (user: AuthUser, displayName: string) => Boolean((await users.updateOne({ userId: user.userId, version: user.version }, { $set: { displayName } })).matchedCount),
    session: async (hash: string) => await sessions.findOne({ hash }),
    saveSession: async (session: AuthSession) => { await sessions.insertOne(session); },
    touch: async (hash: string, lastSeenAt: string) => { await sessions.updateOne({ hash }, { $set: { lastSeenAt } }); },
    removeSession: async (hash: string) => { await sessions.deleteOne({ hash }); },
    listUsers: async (skip: number) => await users.find({}, { sort: { createdAt: -1 }, skip, limit: 21 }),
    provisionRole: async (userId: string, role: "user" | "admin") => {
      const user = await users.findOne({ userId });
      return Boolean(user && (await users.updateOne({ userId, version: user.version }, { $set: { role, version: user.version + 1 } })).matchedCount);
    },
    allow: async (key: string, limit: number, expiresOn: Date): Promise<boolean> => {
      try { await rates.insertOne({ key, count: 0, expiresOn }); } catch (error: unknown) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === 11000)) throw error; }
      return Boolean(await rates.findOneAndUpdate({ key, count: { $lt: limit } }, { $inc: { count: 1 } }));
    },
    ensureIndexes: async () => {
      await users.createIndex({ userId: 1 }, { unique: true }); await users.createIndex({ email: 1 }, { unique: true });
      await sessions.createIndex({ hash: 1 }, { unique: true }); await rates.createIndex({ key: 1 }, { unique: true });
      for (const collection of [sessions, rates]) await collection.createIndex({ expiresOn: 1 }, { expireAfterSeconds: 0 });
    }
  });
};
export type AuthRepository = ReturnType<typeof createAuthRepository>;

import "dotenv/config";
import { z } from "zod";
import { createLogger } from "@workspace/logging";
import { createMongoDbIntegration } from "../../integrations/index.js";
import { readApiEnvironment } from "../../config/index.js";
import { createAuthRepository } from "./auth.repository.js";

const [userId, role, confirmation] = process.argv.slice(2);
const input = z.object({ userId: z.uuid(), role: z.enum(["user", "admin"]), confirmation: z.literal("--confirm") }).parse({ userId, role, confirmation });
const environment = readApiEnvironment();
if (!environment.MONGODB_URI) throw new Error("MongoDB is required for role provisioning.");
const db = createMongoDbIntegration({ uri: environment.MONGODB_URI, logger: createLogger({ service: "auth-administration", level: "error" }) });
await db.connect();
try {
  if (!await createAuthRepository(db).provisionRole(input.userId, input.role)) throw new Error("An existing account ID is required; no role was changed.");
  process.stdout.write("Role updated. Existing sessions have been invalidated.\n");
} finally { await db.disconnect(); }

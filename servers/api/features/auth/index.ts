import type { MongoPersistence } from "../../integrations/index.js";
import type { AuthConfig } from "./auth.types.js";
import { createAuthRepository } from "./auth.repository.js";
import { createAuthService } from "./auth.service.js";
import type { AuthService } from "./auth.service.js";
import { createAuthController } from "./auth.controller.js";
import type { AuthBoundary } from "./auth.controller.js";
export type { AuthConfig } from "./auth.types.js";
export { readAuthConfiguration } from "./auth.validation.js";

export type AuthFeature = AuthBoundary & Readonly<{ service: AuthService }>;
export const createAuthFeature = async ({ db, config, origins, now }: Readonly<{ db: MongoPersistence; config: AuthConfig; origins: readonly string[]; now?: () => number }>): Promise<AuthFeature> => {
  if (!origins.includes(config.publicOrigin)) throw new Error("Authentication public origin must be trusted.");
  const repository = createAuthRepository(db); await repository.ensureIndexes();
  const service = await createAuthService({ repository, ...(now ? { now } : {}) });
  const boundary = createAuthController(service, config, origins);
  return Object.freeze({ ...boundary, service });
};
export type { AuthBoundary } from "./auth.controller.js";

import type { MongoPersistence, EmailSender } from "../../integrations/index.js";
import type { Logger } from "@workspace/logging";
import type { AuthConfig } from "./auth.types.js";
import { createAuthRepository } from "./auth.repository.js";
import { createAuthService } from "./auth.service.js";
import type { AuthService } from "./auth.service.js";
import { createAuthController } from "./auth.controller.js";
import type { AuthBoundary } from "./auth.controller.js";
export type { AuthConfig } from "./auth.types.js";
export { readAuthConfiguration } from "./auth.validation.js";

export type AuthFeature = AuthBoundary & Readonly<{ service: AuthService; start: () => void; stop: () => void }>;
export const createAuthFeature = async ({ db, config, origins, sendEmail, logger, now }: Readonly<{ db: MongoPersistence; config: AuthConfig; origins: readonly string[]; sendEmail: EmailSender; logger: Pick<Logger, "error">; now?: () => number }>): Promise<AuthFeature> => {
  const repository = createAuthRepository(db); await repository.ensureIndexes();
  const service = await createAuthService({ repository, config, sendEmail, ...(now ? { now } : {}), mailFailure: () => { logger.error("Authentication email delivery exhausted retries.", { errorCode: "auth_mail_failed" }); } });
  const boundary = createAuthController(service, config, origins);
  let timer: ReturnType<typeof setInterval> | undefined;
  return Object.freeze({ ...boundary, service,
    start: () => { if (!timer) timer = setInterval(() => { void service.deliver().catch(() => { logger.error("Authentication email worker failed.", { errorCode: "auth_mail_unavailable" }); }); }, 5000); },
    stop: () => { if (timer) clearInterval(timer); timer = undefined; }
  });
};
export type { AuthBoundary } from "./auth.controller.js";

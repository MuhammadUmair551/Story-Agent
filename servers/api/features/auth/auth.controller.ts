import { Router, type Request, type RequestHandler } from "express";
import { ZodError } from "zod";
import type { AuthConfig } from "./auth.types.js";
import type { AuthService } from "./auth.service.js";
import { authError } from "./auth.service.js";
import { equalSecret } from "./auth.crypto.js";
import { publicUser } from "./auth.types.js";
import { signupSchema, loginSchema, changePasswordSchema, profileInputSchema } from "./auth.validation.js";

type Identity = NonNullable<Awaited<ReturnType<AuthService["resolve"]>>>;
export type AuthBoundary = Readonly<{ router: Router; requireUser: RequestHandler; ownerId: (request: Request) => string }>;
export const createAuthController = (service: AuthService, config: AuthConfig, origins: readonly string[]): AuthBoundary => {
  const cookieName = config.secure ? "__Host-story_session" : "story_session";
  const principals = new WeakMap<Request, Identity>(); const allowed = new Set(origins);
  const cookieToken = (request: Request): string | undefined => {
    const matches = (request.get("Cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`));
    return matches.length === 1 ? matches[0]?.slice(cookieName.length + 1) : undefined;
  };
  const cookieOptions = { httpOnly: true, secure: config.secure, sameSite: "lax" as const, path: "/" };
  const handle = (action: RequestHandler): RequestHandler => async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store"); response.setHeader("Referrer-Policy", "no-referrer");
    try { await action(request, response, next); } catch (error: unknown) {
      if (error instanceof ZodError) { response.status(400).json({ error: "Check the submitted fields. Passwords must contain 15–128 characters and cannot be common passwords." }); return; }
      const status = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 503;
      response.status(status).json({ error: status === 503 ? "Authentication is temporarily unavailable. Please try again." : error instanceof Error ? error.message : "Authentication failed." });
    }
  };
  const csrf = async (request: Request) => {
    const identity = await service.resolve(cookieToken(request));
    if (!identity || !allowed.has(request.get("Origin") ?? "") || !equalSecret(request.get("X-CSRF-Token") ?? "", identity.session.csrf)) throw authError(403, "Request verification failed. Refresh and try again.");
    return identity;
  };
  const requireUser: RequestHandler = handle(async (request, response, next) => {
    const identity = await service.resolve(cookieToken(request));
    if (!identity?.user) throw authError(401, "Sign in to continue.");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) await csrf(request);
    principals.set(request, identity); response.setHeader("Cache-Control", "no-store"); next();
  });
  const ownerId = (request: Request): string => {
    const id = principals.get(request)?.user?.userId; if (!id) throw authError(401); return id;
  };
  const router = Router();
  router.get("/auth/session", handle(async (request, response) => {
    await service.rate("session", request.socket.remoteAddress ?? "unknown");
    const current = await service.resolve(cookieToken(request));
    if (current) { response.json({ user: current.user ? publicUser(current.user) : null, csrfToken: current.session.csrf }); return; }
    const created = await service.newSession(null);
    response.cookie(cookieName, created.token, { ...cookieOptions, maxAge: 30 * 60_000 }).json({ user: null, csrfToken: created.csrfToken });
  }));
  router.post("/auth/signup", handle(async (request, response) => {
    await csrf(request); const input = signupSchema.parse(request.body); await service.rate("signup", request.socket.remoteAddress ?? "unknown", input.email);
    response.status(202).json(await service.signup(input));
  }));
  router.post("/auth/login", handle(async (request, response) => {
    const previous = await csrf(request); const input = loginSchema.parse(request.body); await service.rate("login", request.socket.remoteAddress ?? "unknown", input.email);
    const user = await service.login(input.email, input.password); const created = await service.newSession(user); await service.logout(previous.session);
    response.cookie(cookieName, created.token, { ...cookieOptions, maxAge: 8 * 60 * 60_000 }).json({ user: created.user, csrfToken: created.csrfToken });
  }));
  router.post("/auth/change-password", requireUser, handle(async (request, response) => {
    const user = principals.get(request)?.user; if (!user) throw authError(401);
    await service.rate("change-password", request.socket.remoteAddress ?? "unknown", user.email);
    const input = changePasswordSchema.parse(request.body);
    await service.changePassword(user, input.currentPassword, input.newPassword);
    response.clearCookie(cookieName, cookieOptions).json({ message: "Password changed. All sessions signed out. Sign in with your new password." });
  }));
  router.post("/auth/logout", requireUser, handle(async (request, response) => {
    const identity = principals.get(request); if (!identity) throw authError(401); await service.logout(identity.session);
    response.clearCookie(cookieName, cookieOptions).json({ message: "Signed out." });
  }));
  router.post("/auth/logout-all", requireUser, handle(async (request, response) => {
    const user = principals.get(request)?.user; if (!user) throw authError(401); await service.logoutAll(user);
    response.clearCookie(cookieName, cookieOptions).json({ message: "All sessions invalidated." });
  }));
  router.patch("/auth/profile", requireUser, handle(async (request, response) => {
    const user = principals.get(request)?.user; if (!user) throw authError(401);
    response.json({ user: await service.profile(user, profileInputSchema.parse(request.body).displayName) });
  }));
  router.get("/auth/admin/users", requireUser, handle(async (request, response) => {
    if (principals.get(request)?.user?.role !== "admin") throw authError(403, "Access denied.");
    const skip = Number(request.query.skip ?? 0); if (!Number.isInteger(skip) || skip < 0 || skip > 100_000) throw authError(400);
    const users = await service.users(skip); response.json({ users: users.slice(0, 20), hasMore: users.length > 20 });
  }));
  return { router, requireUser, ownerId };
};

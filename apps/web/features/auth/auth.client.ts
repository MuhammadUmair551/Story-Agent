"use client";
import { z } from "zod";
import type { AccountSession } from "@workspace/types";
export const accountSchema = z.object({ userId: z.string(), email: z.email(), displayName: z.string(), role: z.enum(["user", "admin"]), verified: z.boolean() });
const sessionSchema = z.object({ user: accountSchema.nullable(), csrfToken: z.string().min(32) });
let cached: Promise<AccountSession> | undefined;
// A full navigation drops the previous account's client and server-component caches.
export const navigateAccount = (path: "/" | "/login"): void => { window.location.replace(new URL(path, window.location.origin).href); };
export const readAccountSession = (refresh = false): Promise<AccountSession> => {
  if (!cached || refresh) cached = fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" }).then(async (response) => {
    if (!response.ok) throw new Error("Account service is unavailable. Please try again.");
    return sessionSchema.parse(await response.json());
  }).catch((error: unknown) => { cached = undefined; throw error; });
  return cached;
};
export const authenticatedFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) throw new Error("Use the same-origin application API.");
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("X-CSRF-Token", (await readAccountSession()).csrfToken);
  const response = await fetch(input, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  if (response.status === 401 && url.pathname.startsWith("/api/story-agent")) { cached = undefined; navigateAccount("/login"); }
  return response;
};
export const accountRequest = async (path: string, body?: unknown, method = "POST"): Promise<Record<string, unknown>> => {
  const response = await authenticatedFetch(`/api/auth${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const payload: unknown = await response.json(); const record = z.record(z.string(), z.unknown()).parse(payload);
  if (!response.ok) throw new Error(typeof record.error === "string" ? record.error : "Account request failed.");
  if (path === "/login") cached = Promise.resolve(sessionSchema.parse(payload));
  if (["/logout", "/logout-all", "/reset-password"].includes(path)) cached = undefined;
  if (["/login", "/logout", "/logout-all", "/reset-password"].includes(path) && typeof BroadcastChannel !== "undefined") { const channel = new BroadcastChannel("story-account"); channel.postMessage("session-changed"); channel.close(); }
  return record;
};

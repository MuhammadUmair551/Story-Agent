import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthScreen, AccountProfile } from "../features/auth";
import { proxyAccountApi } from "../features/auth/auth.proxy";
import { accountRequest, readAccountSession } from "../features/auth/auth.client";

test("all authentication screens compose accessible real forms and account actions", () => {
  for (const mode of ["login", "signup", "verify-email", "forgot-password", "reset-password"] as const) {
    const markup = renderToStaticMarkup(<AuthScreen mode={mode} />);
    assert.match(markup, /<form/); assert.match(markup, /Account navigation/); assert.match(markup, /Connecting securely/);
    if (["login", "signup", "reset-password"].includes(mode)) assert.match(markup, /type="password"/);
    assert.doesNotMatch(markup, /localStorage|sessionStorage/);
  }
  const profile = renderToStaticMarkup(<AccountProfile user={{ userId: "a", email: "reader@example.test", displayName: "Reader", verified: true, role: "user" }} />);
  assert.match(profile, /Sign out all sessions/); assert.doesNotMatch(profile, /Admin account directory/);
});

test("same-origin proxy forwards only session cookies and preserves private responses and upstream errors", async (context) => {
  const previous = process.env.NEXT_PUBLIC_API_BASE_URL; context.after(() => { if (previous === undefined) Reflect.deleteProperty(process.env, "NEXT_PUBLIC_API_BASE_URL"); else process.env.NEXT_PUBLIC_API_BASE_URL = previous; });
  process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.example.test";
  let observed: RequestInit | undefined;
  context.mock.method(globalThis, "fetch", (_input: unknown, init?: RequestInit) => { observed = init; return Promise.resolve(Response.json({ error: "provider_failed" }, { status: 500, headers: { "Set-Cookie": "__Host-story_session=opaque; Secure; HttpOnly; SameSite=Lax; Path=/", "X-Request-Id": "correlation" } })); });
  const response = await proxyAccountApi(new Request("https://web.example.test/api/story-agent/runs", { method: "POST", headers: { Origin: "https://web.example.test", Cookie: "__Host-story_session=opaque; unrelated=value", "X-CSRF-Token": "csrf", "X-User-Id": "forged" }, body: JSON.stringify({ requirement: "Private work" }) }), ["story-agent", "runs"]);
  assert.equal(response.status, 500); assert.equal(response.headers.get("cache-control"), "no-store"); assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/);
  const headers = new Headers(observed?.headers); assert.equal(headers.get("Cookie"), "__Host-story_session=opaque"); assert.equal(headers.get("X-User-Id"), null); assert.equal(headers.get("Origin"), "https://web.example.test"); assert.equal(headers.get("X-CSRF-Token"), "csrf");
  assert.deepEqual(await response.json(), { error: "provider_failed" });
});

test("proxy rejects CSRF, traversal and large bodies before contacting the API and fails closed on transport errors", async (context) => {
  let calls = 0; context.mock.method(globalThis, "fetch", () => { calls++; return Promise.reject(new Error("Offline")); });
  const previous = process.env.NEXT_PUBLIC_API_BASE_URL; process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.example.test";
  context.after(() => { if (previous === undefined) Reflect.deleteProperty(process.env, "NEXT_PUBLIC_API_BASE_URL"); else process.env.NEXT_PUBLIC_API_BASE_URL = previous; });
  assert.equal((await proxyAccountApi(new Request("https://web.example.test/api/auth/login", { method: "POST", headers: { Origin: "https://evil.test" } }), ["auth", "login"])).status, 403);
  assert.equal((await proxyAccountApi(new Request("https://web.example.test/api/auth/login"), ["auth", "..", "health"])).status, 404);
  assert.equal((await proxyAccountApi(new Request("https://web.example.test/api/auth/login", { method: "POST", headers: { Origin: "https://web.example.test" }, body: "x".repeat(256 * 1024 + 1) }), ["auth", "login"])).status, 413);
  assert.equal(calls, 0);
  const unavailable = await proxyAccountApi(new Request("https://web.example.test/api/auth/session"), ["auth", "session"]);
  assert.equal(unavailable.status, 502); assert.deepEqual(await unavailable.json(), { error: "The API is unavailable. Please try again." });
});

test("proxy checks browser Host when Next constructs an internal URL and never trusts forwarded host", async (context) => {
  const previous = process.env.NEXT_PUBLIC_API_BASE_URL; process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.example.test";
  context.after(() => { if (previous === undefined) Reflect.deleteProperty(process.env, "NEXT_PUBLIC_API_BASE_URL"); else process.env.NEXT_PUBLIC_API_BASE_URL = previous; });
  let calls = 0; context.mock.method(globalThis, "fetch", () => { calls++; return Promise.resolve(Response.json({ message: "accepted" }, { status: 202 })); });
  const make = (origin: string, host: string, forwarded = "") => new Request("http://localhost:3000/api/auth/signup", { method: "POST", headers: { Host: host, Origin: origin, "X-Forwarded-Host": forwarded }, body: "{}" });
  assert.equal((await proxyAccountApi(make("https://web.example.test", "web.example.test"), ["auth", "signup"])).status, 202);
  assert.equal((await proxyAccountApi(make("http://127.0.0.1:3105", "127.0.0.1:3105"), ["auth", "signup"])).status, 202);
  for (const request of [make("https://attacker.test", "web.example.test", "attacker.test"), make("http://web.example.test", "web.example.test"), make("null", "web.example.test"), make("https://web.example.test:444", "web.example.test")]) assert.equal((await proxyAccountApi(request, ["auth", "signup"])).status, 403);
  assert.equal(calls, 2);
});

test("password reset invalidates cached client identity and refreshes CSRF before a subsequent login", async (context) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://web.example.test" } } });
  context.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
  let lookups = 0; const observed: string[] = [];
  context.mock.method(globalThis, "fetch", (input: unknown, init?: RequestInit) => {
    if (input === "/api/auth/session") { lookups++; return Promise.resolve(Response.json({ user: lookups === 1 ? { userId: "reader", email: "reader@example.test", displayName: "Reader", role: "user", verified: true } : null, csrfToken: String(lookups).repeat(43) })); }
    observed.push(new Headers(init?.headers).get("X-CSRF-Token") ?? "");
    return Promise.resolve(Response.json({ message: "Password reset." }));
  });
  assert.equal((await readAccountSession(true)).user?.userId, "reader"); await accountRequest("/reset-password", { token: "fixture-token", password: "A new long fixture password!" });
  await accountRequest("/resend-verification", { email: "reader@example.test" });
  assert.equal((await readAccountSession()).user, null); assert.equal(lookups, 2); assert.deepEqual(observed, ["1".repeat(43), "2".repeat(43)]);
});

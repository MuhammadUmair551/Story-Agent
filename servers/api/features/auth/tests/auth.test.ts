import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { authFixture, browserClient, signupVerified, tokenFrom, plan } from "./auth.fixture.js";
import { hashPassword, verifyPassword, tokenHash, encryptMail, decryptMail } from "../auth.crypto.js";
import type { StoryAgentProjectRules } from "@workspace/types";
const rules: StoryAgentProjectRules = { glossary: [], roles: [], naming: [], rules: [], acceptanceCriteria: { format: "checklist", instructions: "", examples: [] } };

void test("password hashing uses independent salts, verifies exact values and authenticates encrypted email", async () => {
  const password = "A long independent password!"; const first = await hashPassword(password); const second = await hashPassword(password);
  assert.notEqual(first, second); assert.ok(await verifyPassword(password, first)); assert.equal(await verifyPassword("wrong", first), false);
  const key = randomBytes(32).toString("base64"); const encrypted = encryptMail("private-token", key);
  assert.equal(decryptMail(encrypted, key), "private-token"); assert.throws(() => decryptMail(encrypted, randomBytes(32).toString("base64")));
});

void test("signup normalizes email, generic duplicate response, verification and rotating login/logout sessions", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close); const client = browserClient(fixture);
  const initial = await client.request("/auth/session"); assert.equal(initial.status, 200); assert.match(initial.headers.get("set-cookie") ?? "", /HttpOnly/);
  const anonymousCookie = client.cookie(); const input = { email: "  Reader@Example.test ", password: "A sufficiently long unique password!", displayName: "Reader" };
  const signup = await client.request("/auth/signup", "POST", input); assert.equal(signup.status, 202);
  const duplicate = await client.request("/auth/signup", "POST", { ...input, email: "reader@example.test" }); assert.deepEqual(await signup.json(), await duplicate.json());
  assert.equal((await fixture.memory.db.getCollection("auth_users").find({})).length, 1);
  assert.equal((await client.request("/auth/login", "POST", input)).status, 400);
  const credentials = { email: "reader@example.test", password: input.password };
  const unverified = await client.request("/auth/login", "POST", credentials); assert.equal(unverified.status, 401);
  const unknown = await client.request("/auth/login", "POST", { ...credentials, email: "missing@example.test" }); assert.deepEqual(await unverified.json(), await unknown.json());
  await fixture.auth.service.deliver(); const token = tokenFrom(fixture.messages.at(-1));
  const storedTokens = await fixture.memory.db.getCollection("auth_tokens").find({}); assert.equal(storedTokens[0]?.hash, tokenHash(token)); assert.ok(!JSON.stringify(storedTokens).includes(token));
  assert.equal((await client.request("/auth/verify-email", "POST", { token })).status, 200);
  assert.equal((await client.request("/auth/verify-email", "POST", { token })).status, 400);
  const login = await client.request("/auth/login", "POST", credentials); assert.equal(login.status, 200); assert.notEqual(client.cookie(), anonymousCookie);
  const oldCookie = client.cookie(); assert.equal((await client.request("/story-agent/runs")).status, 200);
  assert.equal((await client.request("/auth/logout", "POST")).status, 200);
  assert.equal((await client.request("/story-agent/runs", "GET", undefined, { Cookie: oldCookie })).status, 401);
});

void test("production cookies, CSRF checks, strict role inputs, and missing authentication fail closed", async (context) => {
  const fixture = await authFixture(true, ["https://web.example.test"]); context.after(fixture.close); const client = browserClient(fixture, "https://web.example.test");
  const session = await client.request("/auth/session"); const cookie = session.headers.get("set-cookie") ?? "";
  assert.match(cookie, /__Host-story_session=/); assert.match(cookie, /; Secure/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.doesNotMatch(cookie, /Domain=/);
  assert.equal((await fetch(`${fixture.base}/story-agent/runs`)).status, 401);
  const input = { email: "member@example.test", password: "A sufficiently long unique password!", displayName: "Member" };
  assert.equal((await client.request("/auth/signup", "POST", input, { "X-CSRF-Token": "wrong" })).status, 403);
  assert.equal((await client.request("/auth/signup", "POST", input, { Origin: "https://attacker.test" })).status, 403);
  assert.equal((await client.request("/auth/signup", "POST", { ...input, role: "admin" })).status, 400);
  assert.equal((await client.request("/auth/signup", "POST", { ...input, password: "weak" })).status, 400);
});

void test("password reset is expiring, single-use, invalidates every session and never reveals account existence", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close); const { client, password } = await signupVerified(fixture, "reset@example.test");
  const second = browserClient(fixture); await second.request("/auth/session"); await second.request("/auth/login", "POST", { email: "reset@example.test", password });
  const known = await client.request("/auth/forgot-password", "POST", { email: "reset@example.test" }); const unknown = await client.request("/auth/forgot-password", "POST", { email: "absent@example.test" });
  assert.deepEqual(await known.json(), await unknown.json()); await fixture.auth.service.deliver(); const expired = tokenFrom(fixture.messages.at(-1));
  fixture.advance(31 * 60_000); const fresh = browserClient(fixture); await fresh.request("/auth/session");
  assert.equal((await fresh.request("/auth/reset-password", "POST", { token: expired, password: "Another sufficiently long password!" })).status, 400);
  await fresh.request("/auth/forgot-password", "POST", { email: "reset@example.test" }); await fixture.auth.service.deliver(); const token = tokenFrom(fixture.messages.at(-1));
  const responses = await Promise.all([fresh.request("/auth/reset-password", "POST", { token, password: "Another sufficiently long password!" }), fresh.request("/auth/reset-password", "POST", { token, password: "Another sufficiently long password!" })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
  assert.equal((await second.request("/story-agent/runs")).status, 401);
  assert.equal((await fresh.request("/auth/login", "POST", { email: "reset@example.test", password })).status, 401);
  assert.equal((await fresh.request("/auth/login", "POST", { email: "reset@example.test", password: "Another sufficiently long password!" })).status, 200);
});

void test("session idle/absolute expiry, persistent sessions and explicit admin privilege boundaries", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close); const { client } = await signupVerified(fixture, "admin@example.test");
  assert.equal((await client.request("/auth/admin/users")).status, 403);
  const user = await fixture.authRepository.byEmail("admin@example.test"); assert.ok(user);
  assert.equal(await fixture.authRepository.provisionRole(user.userId, "admin"), true);
  assert.equal((await client.request("/auth/admin/users")).status, 401);
  await client.request("/auth/session"); await client.request("/auth/login", "POST", { email: user.email, password: "A sufficiently long unique password!" });
  const users = await client.request("/auth/admin/users"); assert.equal(users.status, 200); assert.doesNotMatch(JSON.stringify(await users.json()), /passwordHash/);
  fixture.advance(30 * 60_000 + 1); assert.equal((await client.request("/story-agent/runs")).status, 401);
  await client.request("/auth/session"); await client.request("/auth/login", "POST", { email: user.email, password: "A sufficiently long unique password!" });
  fixture.advance(8 * 60 * 60_000 + 1); assert.equal((await client.request("/story-agent/runs")).status, 401);
});

void test("durable mail retries without plaintext token storage and request throttles persist", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close); const client = browserClient(fixture); await client.request("/auth/session");
  fixture.mailFailure(true); await client.request("/auth/signup", "POST", { email: "queued@example.test", displayName: "Queued", password: "A sufficiently long unique password!" });
  const jobs = await fixture.memory.db.getCollection("auth_mail").find({}); assert.equal(jobs.length, 1); assert.doesNotMatch(JSON.stringify(jobs), /#token=|queued@example/);
  await fixture.auth.service.deliver(); assert.equal(fixture.messages.length, 0); fixture.mailFailure(false); fixture.advance(61_000); await fixture.auth.service.deliver(); assert.equal(fixture.messages.length, 1);
  for (let index = 0; index < 5; index++) assert.equal((await client.request("/auth/forgot-password", "POST", { email: "unknown@example.test" })).status, 202);
  assert.equal((await client.request("/auth/forgot-password", "POST", { email: "unknown@example.test" })).status, 429);
});

void test("all Story Agent data remains owner-scoped and anonymous legacy data is quarantined", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close);
  const alice = await signupVerified(fixture, "alice@example.test"); const bob = await signupVerified(fixture, "bob@example.test");
  await fixture.repository.saveRun({ runId: "legacy", requirement: "Anonymous", status: "draft", plan, attempts: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, providers: [], stages: [], validationErrors: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const created = await alice.client.request("/story-agent/runs", "POST", { requirement: "Readers resume chapters", ownerId: "forged" }); assert.equal(created.status, 200);
  const run = await created.json() as { runId: string; plan: unknown }; assert.ok(run.plan);
  assert.equal((await bob.client.request(`/story-agent/runs/${run.runId}`)).status, 404);
  assert.equal((await bob.client.request(`/story-agent/runs/${run.runId}`, "DELETE")).status, 404);
  for (const path of ["refinements", "analyses", "analyses/missing/findings/missing/decision"]) assert.ok([400, 404].includes((await bob.client.request(`/story-agent/runs/${run.runId}/${path}`, "POST", { artifactPath: "initiative", instructions: "Clarify", version: 0, kind: "backlog", decision: "confirm", reason: "", reviewVersion: 0 })).status));
  assert.deepEqual((await (await bob.client.request("/story-agent/runs")).json() as { runs: unknown[] }).runs, []);
  assert.equal((await alice.client.request("/story-agent/runs/legacy")).status, 404);
  const project = await (await alice.client.request("/story-agent/projects", "POST", { name: "Private", rules })).json() as { project: { projectId: string } };
  assert.deepEqual((await (await bob.client.request("/story-agent/projects")).json() as { projects: unknown[] }).projects, []);
  assert.equal((await bob.client.request(`/story-agent/projects/${project.project.projectId}`, "PUT", { name: "Stolen", rules, version: 1 })).status, 404);
  assert.equal((await bob.client.request("/story-agent/runs", "POST", { requirement: "Use another project", projectId: project.project.projectId })).status, 404);
  assert.equal((await alice.client.request(`/story-agent/runs/${run.runId}`, "DELETE")).status, 200);
});

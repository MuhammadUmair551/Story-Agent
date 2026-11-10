import test from "node:test";
import assert from "node:assert/strict";
import { authFixture, browserClient, signupAccount, plan } from "./auth.fixture.js";
import { hashPassword, verifyPassword } from "../auth.crypto.js";
import type { StoryAgentProjectRules } from "@workspace/types";
const rules: StoryAgentProjectRules = { glossary: [], roles: [], naming: [], rules: [], acceptanceCriteria: { format: "checklist", instructions: "", examples: [] } };

void test("password hashing uses independent salts and rejects incorrect values", async () => {
  const password = "A long independent password!"; const first = await hashPassword(password); const second = await hashPassword(password);
  assert.notEqual(first, second); assert.ok(await verifyPassword(password, first)); assert.equal(await verifyPassword("wrong", first), false);
});

void test("signup normalizes email, conceals duplicate accounts and supports immediate login with rotating sessions", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close); const client = browserClient(fixture);
  const initial = await client.request("/auth/session"); assert.equal(initial.status, 200); assert.match(initial.headers.get("set-cookie") ?? "", /HttpOnly/);
  const anonymousCookie = client.cookie(); const input = { email: "  Reader@Example.test ", password: "A sufficiently long unique password!", displayName: "Reader" };
  const signup = await client.request("/auth/signup", "POST", input); assert.equal(signup.status, 202);
  const duplicate = await client.request("/auth/signup", "POST", { ...input, email: "reader@example.test", displayName: "Impostor", password: "A different duplicate signup password!" }); assert.deepEqual(await signup.json(), await duplicate.json());
  assert.equal((await fixture.memory.db.getCollection("auth_users").find({})).length, 1);
  assert.equal((await client.request("/auth/login", "POST", input)).status, 400);
  const credentials = { email: "reader@example.test", password: input.password };
  const wrong = await client.request("/auth/login", "POST", { ...credentials, password: "An incorrect sufficiently long password!" }); assert.equal(wrong.status, 401);
  const unknown = await client.request("/auth/login", "POST", { ...credentials, email: "missing@example.test" }); assert.deepEqual(await wrong.json(), await unknown.json());
  const stored = await fixture.authRepository.byEmail(credentials.email); assert.ok(stored); assert.equal(stored.displayName, "Reader"); assert.equal(Object.hasOwn(stored, "verified"), false);
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

void test("password change requires current credentials, CSRF and strict input, then revokes every session", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close); const { client, password } = await signupAccount(fixture, "change@example.test");
  const second = browserClient(fixture); await second.request("/auth/session"); await second.request("/auth/login", "POST", { email: "change@example.test", password });
  const body = { currentPassword: password, newPassword: "Another sufficiently long password!" };
  assert.equal((await browserClient(fixture).request("/auth/change-password", "POST", body)).status, 401);
  assert.equal((await client.request("/auth/change-password", "POST", body, { "X-CSRF-Token": "wrong" })).status, 403);
  assert.equal((await client.request("/auth/change-password", "POST", body, { Origin: "https://attacker.test" })).status, 403);
  assert.equal((await client.request("/auth/change-password", "POST", { ...body, currentPassword: "Wrong sufficiently long password!" })).status, 401);
  assert.equal((await client.request("/story-agent/runs")).status, 200);
  assert.equal((await client.request("/auth/change-password", "POST", { ...body, newPassword: "weak" })).status, 400);
  assert.equal((await client.request("/auth/change-password", "POST", { ...body, userId: "someone-else" })).status, 400);
  assert.equal((await client.request("/auth/change-password", "POST", { ...body, newPassword: password })).status, 400);
  const changed = await client.request("/auth/change-password", "POST", body); assert.equal(changed.status, 200); assert.match(changed.headers.get("set-cookie") ?? "", /Expires=Thu, 01 Jan 1970/);
  assert.equal((await second.request("/story-agent/runs")).status, 401);
  assert.equal((await client.request("/story-agent/runs")).status, 401);
  await client.request("/auth/session");
  assert.equal((await client.request("/auth/login", "POST", { email: "change@example.test", password })).status, 401);
  assert.equal((await client.request("/auth/login", "POST", { email: "change@example.test", password: body.newPassword })).status, 200);
});

void test("removed email APIs return honest not-found responses without creating tokens or delivery jobs", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close); const { client } = await signupAccount(fixture, "noemail@example.test");
  for (const path of ["verify-email", "resend-verification", "forgot-password", "reset-password"]) {
    const response = await client.request(`/auth/${path}`, "POST", { email: "noemail@example.test", token: "obsolete" });
    assert.equal(response.status, 404); assert.doesNotMatch(JSON.stringify(await response.json()), /sent|delivered|eligible/i);
  }
  for (const name of ["auth_tokens", "auth_mail"]) assert.deepEqual(await fixture.memory.db.getCollection(name).find({}), []);
  assert.equal(fixture.memory.indexes.filter(name => name.startsWith("auth_")).length, 6);
  assert.ok(fixture.memory.indexes.every(name => !name.startsWith("auth_tokens:") && !name.startsWith("auth_mail:")));
});

void test("session idle/absolute expiry, persistent sessions and explicit admin privilege boundaries", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close); const { client } = await signupAccount(fixture, "admin@example.test");
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

void test("signup, login and password-change throttles persist without mail infrastructure", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close); const { client, password } = await signupAccount(fixture, "limited@example.test");
  for (let index = 0; index < 4; index++) assert.equal((await client.request("/auth/signup", "POST", { email: "limited@example.test", displayName: "Changed", password })).status, 202);
  assert.equal((await client.request("/auth/signup", "POST", { email: "limited@example.test", displayName: "Changed", password })).status, 429);
  for (let index = 0; index < 9; index++) assert.equal((await client.request("/auth/login", "POST", { email: "limited@example.test", password: "An incorrect sufficiently long password!" })).status, 401);
  assert.equal((await client.request("/auth/login", "POST", { email: "limited@example.test", password })).status, 429);
  for (let index = 0; index < 5; index++) assert.equal((await client.request("/auth/change-password", "POST", { currentPassword: "An incorrect sufficiently long password!", newPassword: "Another sufficiently long password!" })).status, 401);
  assert.equal((await client.request("/auth/change-password", "POST", { currentPassword: password, newPassword: "Another sufficiently long password!" })).status, 429);
  fixture.advance(15 * 60_000);
  assert.equal((await client.request("/auth/change-password", "POST", { currentPassword: password, newPassword: "Another sufficiently long password!" })).status, 200);
});

void test("all Story Agent data remains owner-scoped and anonymous legacy data is quarantined", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close);
  const alice = await signupAccount(fixture, "alice@example.test"); const bob = await signupAccount(fixture, "bob@example.test");
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

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createAuthService } from "../auth.service.js";
import { readAuthConfiguration } from "../auth.validation.js";
import { readApiEnvironment } from "../../../config/index.js";
import { tokenHash } from "../auth.crypto.js";
import { authFixture, browserClient, signupVerified, tokenFrom, plan } from "./auth.fixture.js";
import type { StoryAgentAnalysis, StoryAgentRefinement, StoryAgentRunResponse } from "@workspace/types";

void test("authentication config rejects missing secrets, insecure public origins and untrusted email links", () => {
  const environment = { NODE_ENV: "production", API_HOST: "127.0.0.1", API_PORT: "4000", WEB_ORIGIN: "https://web.example.test", LOG_LEVEL: "silent", AUTH_PUBLIC_ORIGIN: "https://web.example.test", AUTH_EMAIL_FROM: "sender@example.test", AUTH_EMAIL_API_KEY: "fixture-only-api-key", AUTH_MAIL_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
  assert.equal(readAuthConfiguration(readApiEnvironment(environment)).secure, true);
  for (const change of [{ AUTH_MAIL_ENCRYPTION_KEY: "" }, { AUTH_EMAIL_API_KEY: "" }, { AUTH_PUBLIC_ORIGIN: "http://web.example.test" }, { AUTH_PUBLIC_ORIGIN: "https://attacker.test" }, { AUTH_PUBLIC_ORIGIN: "https://web.example.test/path" }]) assert.throws(() => readAuthConfiguration(readApiEnvironment({ ...environment, ...change })));
});

void test("sessions and rate limits survive a service restart; logout-all revokes concurrent sessions", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close);
  const { client } = await signupVerified(fixture, "persist@example.test");
  const token = client.cookie().split("=")[1]; assert.ok(token);
  const restarted = await createAuthService({ repository: fixture.authRepository, config: fixture.authConfig, now: fixture.now, sendEmail: () => Promise.resolve() });
  const resolved = await restarted.resolve(token); assert.equal(resolved?.user?.email, "persist@example.test"); assert.ok(resolved);
  for (let index = 0; index < 5; index++) await restarted.rate("forgot-password", "test-ip", "rate@example.test");
  await assert.rejects(fixture.auth.service.rate("forgot-password", "test-ip", "rate@example.test"), { status: 429 });
  assert.doesNotMatch(JSON.stringify(await fixture.memory.db.getCollection("auth_sessions").find({})), new RegExp(token));
  const second = await restarted.newSession(resolved.user);
  await client.request("/auth/logout-all", "POST");
  assert.equal(await restarted.resolve(token), null); assert.equal(await restarted.resolve(second.token), null);
});

void test("absolute session expiry applies even to a recently active session; duplicate cookies are rejected", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close); const { client } = await signupVerified(fixture, "expiry@example.test");
  assert.equal((await client.request("/story-agent/runs", "GET", undefined, { Cookie: `${client.cookie()}; ${client.cookie()}` })).status, 401);
  const token = client.cookie().split("=")[1]; assert.ok(token);
  fixture.advance(8 * 60 * 60_000 + 1);
  await fixture.authRepository.touch(tokenHash(token), new Date(fixture.now()).toISOString());
  assert.equal(await fixture.auth.service.resolve(token), null);
});

void test("verification expires and cannot be replayed or used as a password reset", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close); const client = browserClient(fixture); await client.request("/auth/session");
  const input = { email: "verify@example.test", displayName: "Verify", password: "A sufficiently long unique password!" };
  await client.request("/auth/signup", "POST", input); await fixture.auth.service.deliver(); const token = tokenFrom(fixture.messages.at(-1));
  assert.equal((await client.request("/auth/reset-password", "POST", { token, password: "A replacement long unique password!" })).status, 400);
  fixture.advance(24 * 60 * 60_000 + 1); await client.request("/auth/session");
  assert.equal((await client.request("/auth/verify-email", "POST", { token })).status, 400);
  await client.request("/auth/resend-verification", "POST", { email: input.email }); await fixture.auth.service.deliver();
  const fresh = tokenFrom(fixture.messages.at(-1));
  const responses = await Promise.all([client.request("/auth/verify-email", "POST", { token: fresh }), client.request("/auth/verify-email", "POST", { token: fresh })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
});

void test("owned queue processing retains ownership while legacy queued records stay quarantined", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close); await signupVerified(fixture, "worker@example.test");
  const user = await fixture.authRepository.byEmail("worker@example.test"); assert.ok(user);
  const now = new Date(fixture.now()).toISOString();
  const run = { requirement: "Resume a chapter", status: "queued" as const, nextAttemptAt: now, lockedUntil: null, attempts: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, providers: [], stages: [], validationErrors: [], createdAt: now, updatedAt: now };
  await fixture.repository.saveRun({ ...run, runId: "legacy-queued" });
  await fixture.scope(user.userId).repository.saveRun({ ...run, runId: "owned-queued", ownerId: "forged" });
  assert.equal(await fixture.scope(user.userId).repository.countQueuedRuns(), 1);
  await fixture.feature.queue.processNext();
  assert.equal((await fixture.repository.getRun("owned-queued"))?.status, "draft");
  assert.equal((await fixture.repository.getDraftByRun("owned-queued"))?.ownerId, user.userId);
  assert.equal((await fixture.repository.getRun("legacy-queued"))?.status, "queued");
  assert.equal(await fixture.repository.claimQueuedRun(now, now), null);
  await fixture.scope("another-owner").repository.saveRun({ ...run, runId: "another-queued" });
  assert.equal(await fixture.scope(user.userId).repository.countQueuedRuns(), 1);
});

void test("per-account admission ignores spoofed client keys and retains shared provider concurrency", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close);
  const first = fixture.scope("first").capacity; const second = fixture.scope("second").capacity;
  const leases = Array.from({ length: 10 }, () => first.acquire("forged"));
  assert.ok(leases.every(lease => lease.kind === "accepted")); assert.equal(second.acquire("another-forged").kind, "queued");
  for (const lease of leases) lease.release();
  for (let index = 10; index < 100; index++) { const lease = first.acquire(String(index)); assert.equal(lease.kind, "accepted"); lease.release(); }
  assert.equal(first.acquire("new-address").kind, "rate_limited");
  const other = second.acquire("new-address"); assert.equal(other.kind, "accepted"); other.release();
});

void test("every project and history operation denies cross-user access, including admin access", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close);
  const alice = await signupVerified(fixture, "alice@example.test"); const bob = await signupVerified(fixture, "bob@example.test");
  const owner = await fixture.authRepository.byEmail("alice@example.test"); const admin = await fixture.authRepository.byEmail("bob@example.test"); assert.ok(owner); assert.ok(admin);
  await fixture.authRepository.provisionRole(admin.userId, "admin"); await bob.client.request("/auth/session"); await bob.client.request("/auth/login", "POST", { email: admin.email, password: bob.password });
  const source = await (await alice.client.request("/story-agent/runs", "POST", { requirement: "Private reader work", ownerId: admin.userId })).json() as { runId: string };
  assert.equal((await fixture.repository.getRun(source.runId))?.ownerId, owner.userId);
  const prefix = `/story-agent/runs/${source.runId}`;
  for (const [path, method, body] of [
    [prefix, "GET", undefined], [prefix, "DELETE", undefined], [`${prefix}/comparisons`, "GET", undefined],
    [`${prefix}/analyses`, "POST", { kind: "backlog", version: 0 }],
    [`${prefix}/analyses/missing/findings/missing/decision`, "POST", { decision: "confirm", reason: "", reviewVersion: 0 }],
    [`${prefix}/refinements`, "POST", { artifactPath: "initiative", instructions: "Clarify the outcome", version: 0 }],
    [`${prefix}/refinements/missing/decision`, "POST", { decision: "accept", version: 0 }]
  ] as const) assert.equal((await bob.client.request(path, method, body)).status, 404, path);
  assert.deepEqual((await (await bob.client.request("/story-agent/runs")).json() as { runs: unknown[] }).runs, []);
  const rules = { glossary: [], roles: [], naming: [], rules: [], acceptanceCriteria: { format: "checklist", instructions: "", examples: [] } };
  const { project } = await (await alice.client.request("/story-agent/projects", "POST", { name: "Private", rules })).json() as { project: { projectId: string } };
  assert.equal((await bob.client.request(`/story-agent/projects/${project.projectId}`, "DELETE", { version: 1 })).status, 404);
  assert.equal((await bob.client.request("/auth/profile", "PATCH", { displayName: "Forged", role: "admin", userId: owner.userId })).status, 400);
  assert.deepEqual((await fixture.scope(admin.userId).repository.listRuns({ limit: 100, skip: 0 })), []);
  assert.ok(plan.initiative.epics[0]?.features[0]?.stories[0]?.tasks.length);
});

void test("concurrent authenticated requests across owner scopes preserve the global 20-run queue limit", async (context) => {
  const fixture = await authFixture(false, ["http://localhost:3000"], 0, true); context.after(fixture.close);
  const alice = await signupVerified(fixture, "alice@example.test"); const bob = await signupVerified(fixture, "bob@example.test");
  const owner = await fixture.authRepository.byEmail("alice@example.test"); assert.ok(owner);
  const now = new Date(fixture.now()).toISOString();
  for (let index = 0; index < 18; index++) await fixture.scope(owner.userId).repository.saveRun({ runId: `queued-${String(index)}`, status: "queued", requirement: "Existing work", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, attempts: 0, stages: [], providers: [], validationErrors: [], createdAt: now, updatedAt: now });
  const leases = Array.from({ length: 10 }, () => fixture.feature.routeDependencies.capacity.acquireBackground());
  try {
    const replies = await Promise.all(Array.from({ length: 6 }, (_, index) => (index % 2 ? alice : bob).client.request("/story-agent/runs", "POST", { requirement: "A queued private requirement" })));
    assert.equal(replies.filter(reply => reply.status === 202).length, 2);
    assert.equal(replies.filter(reply => reply.status === 503).length, 4);
    assert.equal(await fixture.repository.countQueuedRuns(), 20);
  } finally { for (const lease of leases) if (lease.kind === "accepted") lease.release(); }
});

void test("authenticated generation, quality, backlog coverage, impact, refinement and deletion preserve existing contracts", async (context) => {
  const fixture = await authFixture(); context.after(fixture.close); const { client } = await signupVerified(fixture, "regression@example.test");
  const created = await client.request("/story-agent/runs", "POST", { requirement: "Readers resume saved chapters" }); assert.equal(created.status, 200);
  const run = await created.json() as StoryAgentRunResponse; assert.equal(run.quality?.status, "passed"); assert.ok(run.plan?.initiative.epics[0]?.features[0]?.stories[0]?.tasks.length);
  const prefix = `/story-agent/runs/${run.runId}`;
  const backlog = await client.request(`${prefix}/analyses`, "POST", { kind: "backlog", evidenceVersion: 2, version: 0 }); assert.equal(backlog.status, 200);
  assert.ok((await backlog.json() as { analysis: StoryAgentAnalysis }).analysis.coverage);
  const impact = await client.request(`${prefix}/analyses`, "POST", { kind: "impact", updatedRequirement: "Readers resume saved chapters offline", version: 1 }); assert.equal(impact.status, 200);
  assert.equal((await impact.json() as { analysis: StoryAgentAnalysis }).analysis.kind, "impact");
  const proposal = await client.request(`${prefix}/refinements`, "POST", { artifactPath: "initiative", instructions: "Clarify the outcome", version: 2 }); assert.equal(proposal.status, 200);
  const revision = (await proposal.json() as { proposal: StoryAgentRefinement }).proposal;
  assert.equal(revision.original.initiative.epics[0]?.features[0]?.stories[0]?.artifactId, revision.proposed.initiative.epics[0]?.features[0]?.stories[0]?.artifactId);
  assert.equal((await client.request(`${prefix}/refinements/${revision.id}/decision`, "POST", { decision: "accept", version: 3 })).status, 200);
  const detail = (await (await client.request(prefix)).json() as { run: StoryAgentRunResponse }).run;
  assert.match(detail.plan?.initiative.title ?? "", /clarified/); assert.equal((await fixture.repository.getRun(run.runId))?.plan?.initiative.title, "Reader continuity");
  assert.equal((await client.request(prefix, "DELETE")).status, 200); assert.equal((await client.request(prefix)).status, 404);
});

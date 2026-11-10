# Phase 5: authentication and account isolation

## Audit and ownership

Before this phase there were no users, roles, sessions or ownership fields. MongoDB,
the provider gateway, Story Agent repositories, middleware, project rules, quality,
refinement, impact analysis and evidence review already existed and remain in use.
The browser previously called the API host directly. Cross-site Vercel/Render cookies
would depend on third-party cookie support, so Next now provides a bounded same-origin
proxy; Express remains the authentication and authorization authority.

The feature is under `servers/api/features/auth` and `apps/web/features/auth`.
Bootstrap injects existing Mongo persistence and a small Resend HTTP adapter. Native
Node crypto supplies password hashing, opaque tokens and outbox encryption. No new
package dependencies, alternative database clients or authentication frameworks were added.
Shared account response contracts live in `packages/types`; feature internals remain local.

Every Story Agent operation uses persistence scoped by the session's server-resolved
user ID. Request JSON, headers and query parameters cannot choose a different owner or
role. The existing three Story collections hold projects/rule history, runs/requirements,
quality reports, refinements, evidence reports/decisions and drafts. All are scoped.
Queue/provider concurrency remains shared; queue counting remains global across owners,
and the queue copies ownership to generated drafts. Account submission windows use the
authenticated owner, so the web proxy cannot collapse different users into one window.

### Anonymous history migration

Unowned historical records are retained and quarantined: no new account, including an
admin, can list, read, compare, edit, delete or claim them. Unowned queued jobs are excluded
from processing and new queue counts. Signup never auto-claims by email, timestamps or
guessed identifiers. There is no public claim endpoint. A later migration requires a
separately reviewed operator procedure with independently verified ownership, a backup,
and consistent owner IDs on related runs/drafts/projects. This phase performs no backfill
and deletes no historical user data.

## Authentication model

- Emails are trimmed, NFKC-normalized, lowercased and uniquely indexed. Passwords are
  NFC-normalized, 15–128 characters and reject a small known-common-password denylist.
  Native scrypt uses N=131072, r=8, p=1, a random 16-byte salt and a 64-byte derived key.
  Two password computations may run concurrently per instance to bound memory pressure.
  There is no external breached-password lookup or MFA in this phase.
- Signup always performs password hashing and returns the same accepted message for
  existing/new eligible addresses. Login gives the same error for absent, incorrect or
  unverified accounts and performs dummy hashing for absent users. Password recovery and
  verification resend use generic accepted responses. Database failures remain failures.
- Random 256-bit session tokens are stored only as SHA-256 hashes in MongoDB. Authenticated
  sessions have an eight-hour absolute lifetime and a thirty-minute idle lifetime;
  anonymous CSRF sessions last thirty minutes. Login rotates the session. Logout removes
  it. Logout-all, reset and role changes increment an account security version, invalidating
  every prior session and outstanding action token. Expiry is checked on every request,
  independently of Mongo TTL cleanup. Sessions survive an API service restart.
- Production cookies use `__Host-story_session`, HttpOnly, Secure, SameSite=Lax, Path=/,
  and no Domain. Non-production loopback uses `story_session` without Secure. No token is
  stored in localStorage or sessionStorage. Next forwards only the session cookie, never
  unrelated platform cookies. Authentication transitions perform a full navigation to
  drop the previous account's cached client/server-component state; focus, page restore
  and cross-tab session notifications recheck the current account.
- Every unsafe authentication and Story request requires the exact allowed Origin and
  a constant-time checked session CSRF header. This includes signup, login and reset.
  The proxy rejects cross-site fetches and mismatched/missing unsafe-request origins.
  Private responses are no-store; referrers are disabled, framing is denied and object
  embedding is disabled. Errors do not return raw provider/database diagnostics.
- Verification tokens expire after 24 hours; reset tokens after 30 minutes. Hash storage,
  atomic one-time consumption, purpose binding and account-version comparison prevent
  replay and races. Email links carry the token in a fragment, not a query, and the UI
  removes the fragment after capturing it. A user must submit verification deliberately.
- A durable AES-256-GCM encrypted Mongo outbox keeps pending email tokens out of plaintext
  storage. The worker uses leases, a fixed Resend HTTPS endpoint, idempotency keys, a
  ten-second delivery timeout and bounded exponential retries. Five failed attempts mark
  the job failed and log a sanitized failure. Expired jobs are discarded and TTL-cleaned.

## API and privileges

| Method | Path | Behavior |
|---|---|---|
| GET | `/auth/session` | Resolve session or issue anonymous CSRF session; public user + CSRF only. |
| POST | `/auth/signup` | Normalized unique user, verification email, generic 202. |
| POST | `/auth/login` | Verified credentials, rotated cookie + public account. |
| POST | `/auth/resend-verification` | Generic 202 with eligible verification delivery. |
| POST | `/auth/verify-email` | Consume purpose-bound token and verify account. |
| POST | `/auth/forgot-password` | Generic 202 with eligible reset delivery. |
| POST | `/auth/reset-password` | Consume token, replace password, revoke all sessions. |
| POST | `/auth/logout` | Revoke current session and clear cookie. |
| POST | `/auth/logout-all` | Revoke all sessions and clear cookie. |
| PATCH | `/auth/profile` | Update only the current account's display name. |
| GET | `/auth/admin/users?skip=0` | Explicit admin-only public account directory, 20 per page. |

The browser accesses these through `/api/auth/...`; Story Agent uses `/api/story-agent/...`.
All existing Story endpoints require a verified user, and unsafe methods also require
CSRF. Foreign/missing resource IDs have the same not-found response. Admins have no
cross-account Story Agent access. Strict signup/profile schemas reject role/user ID fields.

Admin provisioning is an explicit operator command, never a signup option:

```text
pnpm --dir servers/api auth:role VERIFIED_ACCOUNT_UUID admin --confirm
pnpm --dir servers/api auth:role VERIFIED_ACCOUNT_UUID user --confirm
```

It uses the configured Mongo integration, requires an already verified account and
invalidates its sessions. Run only with authorized database access; sign in again afterward.

Mongo-backed 15-minute counters survive restarts and replicas: login 60/IP + 10/address;
signup, forgot and resend 20/IP + 5/address; verify/reset 20/IP; session lookup 300/IP.
Counters store hashed IP/email keys. Scrypt capacity pressure also returns 429.
Only the direct socket address is trusted. At a shared reverse proxy these IP limits
aggregate traffic conservatively; arbitrary forwarded IP headers are deliberately ignored.
Any later trusted-ingress policy needs verified platform proxy boundaries. Provider admission
retains its separate existing account window and global concurrency/model budgets.

## Environment and rollout requirements

Keep secrets in the API host or ignored `servers/api/.env`. Required with MongoDB:

| Variable | Requirement |
|---|---|
| `MONGODB_URI` | Existing database, permission to create unique and TTL indexes. |
| `WEB_ORIGIN` | Exact comma-separated approved web origins, no wildcard. |
| `AUTH_PUBLIC_ORIGIN` | Canonical web origin in WEB_ORIGIN; HTTPS in production. |
| `AUTH_MAIL_ENCRYPTION_KEY` | Private random 32-byte key encoded as base64. |
| `AUTH_EMAIL_FROM` | Email address on a verified Resend domain. |
| `AUTH_EMAIL_API_KEY` | Private Resend sending API key. |
| `NODE_ENV` | `production` on the API host for Secure cookies. |

Generate the key locally with Node crypto and save it directly in the secret store:
`node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"`.
Keep it stable while outbox jobs remain; changing it prevents their decryption. Do not
commit its output. No secret environment value is exposed through the browser configuration.
The web host keeps the existing `NEXT_PUBLIC_API_BASE_URL` pointing to the API. The API
validates auth configuration before database connection, fails closed when invalid, and
starts the mail worker with its existing persistent queue process. Keep this host awake.

No live deployment or host configuration changes are performed by this phase. Before an approved
rollout, provision the real sending domain/key, encryption key, canonical origin and
Mongo permissions, then coordinate API and web releases. Existing anonymous history will
be quarantined. The hosting platform must allow the existing model request duration;
Next's proxy timeout of 110 seconds cannot override a shorter platform function limit.

## Verification

Automated API tests exercise real crypto, HTTP middleware, CSRF, cookies, durable repository
contracts, role boundaries, token expiry/replay, account-version races, persistence across
service reconstruction, email retry, queue ownership and cross-user operations. Existing
Story Agent quality/refinement/impact/evidence regressions remain in the normal test suite.
The reusable memory adapter models the persistence contract, not Mongo's server behavior.

The committed loopback browser fixture uses actual authentication and the production
Next build, with fake providers and isolated in-memory data. No live credentials/database
are read. Start it with NODE_ENV=test using
`pnpm --dir servers/api exec tsx features/auth/tests/auth.browser-fixture.ts` (4305/4306),
build/start web with `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4305` on port 3105, then
run a dedicated headless Edge/Chromium profile with loopback debugging port 9337 and:

```text
node apps/web/tests/browser/story-agent-authentication.mjs http://127.0.0.1:3105 http://127.0.0.1:9337
```

The journey covers signup, verification, invalid/valid login, browser cookie attributes,
private projects/glossary, five-level generation, quality/refinement, backlog coverage,
impact analysis, profile edits, logout, two-account isolation, IDOR, role escalation,
forgot/reset/replay, individual history deletion, logout-all and desktop/mobile layout.
It is separate from unit validation because it requires a browser and isolated servers.

The control-plane test glob is quoted so Node, rather than the invoking shell, discovers
all nested test files. This includes the seven scanner regressions that an unquoted
POSIX shell glob previously omitted in CI; no test or security policy is disabled.

Real Resend delivery, Mongo server TTL/index/concurrency behavior and production cookie/
platform deployment remain external integration checks until configured and exercised.
Offline/fake-provider tests do not establish live provider quality or availability.

The isolated production-build browser journey passed 36 assertions, with no JavaScript
exceptions or horizontal overflow at 1440px and 390px. Screenshots were inspected locally.
`pnpm run validate` passed: 298 tests (86 control-plane, 174 API, 32 web, 3 logging,
3 UI), zero failures or skipped tests, plus syntax, architecture, lint, type checking
and production API/web builds. The API total includes 17 new authentication/email
regressions; the web total includes five new authentication/proxy regressions.
A fresh repository-wide TruffleHog 3.97.5 scan and pnpm dependency audit both passed with
zero findings. Real email delivery, live Mongo behavior and production rollout are not
claimed as verified by these checks.

Security reference: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html),
[session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html),
[password recovery](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html),
[CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html),
[Node crypto](https://nodejs.org/api/crypto.html),
[Resend API](https://resend.com/docs/api-reference/emails/send-email).

## Exact changed-file manifest

- `.project/story-agent/02-agentic-ai-architecture.md`
- `.project/story-agent/05-usage-guide.md`
- `.project/story-agent/11-authentication.md`
- `apps/web/app/(public)/page.tsx`
- `apps/web/app/account/page.tsx`
- `apps/web/app/api/[...path]/route.ts`
- `apps/web/app/forgot-password/page.tsx`
- `apps/web/app/globals.css`
- `apps/web/app/login/page.tsx`
- `apps/web/app/reset-password/page.tsx`
- `apps/web/app/signup/page.tsx`
- `apps/web/app/verify-email/page.tsx`
- `apps/web/features/auth/auth.client.ts`
- `apps/web/features/auth/auth.proxy.ts`
- `apps/web/features/auth/auth.server.ts`
- `apps/web/features/auth/components/account-profile.tsx`
- `apps/web/features/auth/components/account-session.tsx`
- `apps/web/features/auth/components/auth-screen.tsx`
- `apps/web/features/auth/components/index.ts`
- `apps/web/features/auth/index.ts`
- `apps/web/features/auth/public.ts`
- `apps/web/features/story-agent/components/story-forge.tsx`
- `apps/web/features/story-agent/story-agent.client.ts`
- `apps/web/next.config.ts`
- `apps/web/package.json`
- `apps/web/tests/auth.test.tsx`
- `apps/web/tests/browser/story-agent-authentication.mjs`
- `apps/web/tests/integration/home-page.test.tsx`
- `package.json`
- `packages/types/src/api/auth/index.ts`
- `packages/types/src/api/index.ts`
- `packages/types/src/index.ts`
- `servers/api/.env.example`
- `servers/api/bootstrap/create-app.ts`
- `servers/api/config/env.ts`
- `servers/api/features/auth/auth.admin.ts`
- `servers/api/features/auth/auth.controller.ts`
- `servers/api/features/auth/auth.crypto.ts`
- `servers/api/features/auth/auth.repository.ts`
- `servers/api/features/auth/auth.service.ts`
- `servers/api/features/auth/auth.types.ts`
- `servers/api/features/auth/auth.validation.ts`
- `servers/api/features/auth/index.ts`
- `servers/api/features/auth/public.ts`
- `servers/api/features/auth/tests/auth.boundaries.test.ts`
- `servers/api/features/auth/tests/auth.browser-fixture.ts`
- `servers/api/features/auth/tests/auth.fixture.ts`
- `servers/api/features/auth/tests/auth.test.ts`
- `servers/api/features/story-agent/index.ts`
- `servers/api/features/story-agent/public.ts`
- `servers/api/features/story-agent/routes/story-agent.route.ts`
- `servers/api/features/story-agent/story-agent.controller.ts`
- `servers/api/features/story-agent/story-agent.ownership.ts`
- `servers/api/features/story-agent/story-agent.queue.ts`
- `servers/api/features/story-agent/story-agent.repository.ts`
- `servers/api/features/story-agent/tests/story-agent.memory.ts`
- `servers/api/features/story-agent/tests/story-agent.repository.test.ts`
- `servers/api/features/story-agent/tests/story-agent.route.test.ts`
- `servers/api/integrations/email/index.ts`
- `servers/api/integrations/email/tests/email.test.ts`
- `servers/api/integrations/index.ts`
- `servers/api/integrations/mongodb/index.ts`
- `servers/api/integrations/mongodb/types.ts`
- `servers/api/middleware/cors.ts`
- `servers/api/package.json`
- `servers/api/server.ts`
- `servers/api/tests/memory-persistence.ts`
- `servers/api/types/configuration/environment.ts`
- `servers/api/validation/env.validation.ts`

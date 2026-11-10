# Phase 5: authentication and account isolation

## Product and architecture

Accounts use a name, email identifier and password. Signup creates an immediately usable
account; sign in after submitting the signup form. Email addresses are **unverified login
identifiers**, never proof of identity, ownership or eligibility for recovery. No email is
sent. A custom domain, sending-domain verification and an email provider are unnecessary.
Save the password in a password manager. There is no forgotten-password recovery shortcut.

The feature lives in `servers/api/features/auth` and `apps/web/features/auth`. Bootstrap
injects existing Mongo persistence. Native Node crypto supplies password hashing and
opaque sessions. There are no additional package dependencies, database clients or auth
frameworks. Shared public account contracts live in `packages/types`.

Browser requests use Next's bounded same-origin `/api` proxy, avoiding third-party cookies
between Vercel and Render. Express remains the authentication and authorization authority.
Only session cookies, CSRF, content type, origin and request correlation are forwarded.
The proxy limits bodies to 256 KiB and upstream duration to 110 seconds; it does not extend
the hosting platform's function limit. Browser tokens are never stored in localStorage.

Every Story Agent operation uses persistence scoped by the session's server-resolved
user UUID. JSON, headers and query parameters cannot select an owner or role. Projects,
rules/glossary, requirements, runs, drafts, history, quality, refinements and backlog/impact
analyses remain owner-scoped. Admins have no cross-account Story Agent access. Provider
budgets, global concurrency, the 20-run queue bound and account submission windows remain.

### Anonymous history

Unowned records remain stored and quarantined, including unowned queued jobs. No account,
including an admin, can list, read, compare, edit, delete or claim them. Signup never claims
history by email or timestamp. A future migration needs a separately reviewed procedure,
independent ownership evidence, backup and consistent owner UUIDs on related records.
This phase performs no ownership backfill or historical data deletion.

## Security model

- Emails are trimmed, NFKC-normalized, lowercased and uniquely indexed. Passwords use NFC,
  15–128 characters and a small common-password denylist. Native scrypt uses N=131072,
  r=8, p=1, random 16-byte salts and 64-byte keys. At most two password computations run
  concurrently per API instance. No external breached-password service or MFA is included.
- Signup always hashes the password and returns the same generic accepted response for
  new and existing addresses. Duplicate signup cannot replace credentials or display name.
  Login gives the same error for absent users and wrong passwords, with dummy verification
  for absent users. Database and hashing failures remain real failures.
- Random 256-bit session tokens are stored only as SHA-256 hashes in MongoDB. Sessions
  expire after eight hours absolute or thirty minutes idle; anonymous CSRF sessions last
  thirty minutes. Expiry is checked on requests independently of TTL cleanup. Login rotates
  the session; logout removes it. Logout-all, password change and role changes increment
  the account security version, revoking every existing authenticated session.
- Password change requires an active session, matching trusted Origin/CSRF, current
  password and a valid different new password. An atomic version check prevents competing
  changes from overwriting each other. Success clears the cookie and requires a fresh
  login on every device. Wrong current passwords do not change credentials or revoke sessions.
- Production cookies use `__Host-story_session; Secure; HttpOnly; SameSite=Lax; Path=/`
  with no Domain. Loopback development uses `story_session` without Secure. Authentication
  transitions fully navigate to clear previous account caches. Focus/page restore and
  cross-tab notifications recheck account identity.
- Every unsafe auth/Story request, including signup and login, requires an exact allowed
  Origin and a constant-time checked session CSRF header. The proxy checks the actual Host
  and never trusts forwarded host headers. Private responses are no-store. Referrers,
  framing and object embedding are restricted; raw storage/provider diagnostics stay private.
- Mongo-backed 15-minute counters survive restarts/replicas: login 60/IP + 10/address;
  signup and password change 20/IP + 5/address; session lookup 300/IP. Keys hash IP/email.
  Scrypt saturation also returns 429. Only direct socket addresses are trusted, so IP
  limits aggregate conservatively behind a shared proxy; spoofable forwarded IPs are ignored.

## API and screens

| Method | Path | Behavior |
|---|---|---|
| GET | `/auth/session` | Resolve account or create anonymous CSRF session. |
| POST | `/auth/signup` | Create unique account; same generic 202 for duplicates. |
| POST | `/auth/login` | Check password and rotate cookie/session. |
| POST | `/auth/change-password` | Require current password; revoke all sessions. |
| POST | `/auth/logout` | Remove current session and clear cookie. |
| POST | `/auth/logout-all` | Revoke all account sessions and clear cookie. |
| PATCH | `/auth/profile` | Change only the current account's display name. |
| GET | `/auth/admin/users?skip=0` | Explicit admin directory, 20 accounts per page. |

The browser uses `/api/auth/...` and `/api/story-agent/...`. `/signup` and `/login` are
public forms; `/` and `/account` require an authenticated session. Account settings expose
profile, password change and logout actions. Login/signup copy explains the lack of email
recovery. No verification or reset links remain. The former verification, resend, forgot
and reset API routes and their pages return 404; no response suggests that email was sent.
Emails cannot be changed through profile, used to grant roles or used to claim old history.

Foreign/missing Story resources return the same 404. Unauthenticated requests receive 401;
CSRF/origin failures receive 403. Strict auth schemas reject client-supplied roles/user IDs;
Story Agent always derives ownership from the server-resolved session.
Admin provisioning is an explicit authorized operator command using an existing UUID:

```text
pnpm --dir servers/api auth:role ACCOUNT_UUID admin --confirm
pnpm --dir servers/api auth:role ACCOUNT_UUID user --confirm
```

It revokes sessions; sign in again afterward. This is role administration, not password
recovery. An email address alone never authorizes the operator to change an account.

## Environment and deployment

Keep secret values in Render or ignored `servers/api/.env`, never in public frontend vars.
No mail-specific secrets are required. The email adapter, outbox encryption, action-token
handling and delivery/retry worker have been removed. No Resend SDK was installed, so no
package or lockfile changes are necessary.

| Setting | Host and requirement |
|---|---|
| `NODE_ENV=production` | Render; enforces secure cookies and HTTPS canonical origin. |
| `API_HOST`, `API_PORT`, `LOG_LEVEL` | Existing API runtime configuration. |
| `MONGODB_URI` | Render; existing database with collection/index privileges. |
| `WEB_ORIGIN` | Render; exact approved origins, comma-separated, no wildcard. |
| `AUTH_PUBLIC_ORIGIN` | Render; canonical origin included in WEB_ORIGIN; HTTPS in production. |
| `NEXT_PUBLIC_API_BASE_URL` | Vercel; HTTPS Render API origin, no secret. |
| `LLM_PROVIDERS`, provider URL/key/model, profile routes | Existing provider configuration on Render. |

`AUTH_PUBLIC_ORIGIN` remains a security configuration check. The existing free
`https://story-agent.vercel.app` hostname is sufficient. Approved previews need exact
allowlist entries; no custom domain or mail-provider setup is needed. Never use wildcards
to accept all Vercel projects. Keep existing optional capacity/observability settings.

Mongo startup ensures these **six auth indexes**, in addition to existing Story indexes:

| Collection | Keys | Policy |
|---|---|---|
| `auth_users` | `userId:1` | unique |
| `auth_users` | `email:1` | unique normalized email |
| `auth_sessions` | `hash:1` | unique |
| `auth_sessions` | `expiresOn:1` | TTL, expireAfterSeconds=0 |
| `auth_rates` | `key:1` | unique |
| `auth_rates` | `expiresOn:1` | TTL, expireAfterSeconds=0 |

Story indexes retain unique runId on runs/drafts, unique projectId on projects,
createdAt history ordering, the status/nextAttemptAt/lockedUntil/createdAt queue index
and `ownerId:1,createdAt:-1` run-history ordering.
Index failure prevents startup. Confirm the actual production database has all required
indexes; an unrelated local database audit is not production evidence.

### Safe transition from the email-enabled branch

1. Back up the database. Coordinate rollout so no old mail-enabled API replicas/workers
   remain running; the new code has no delivery worker. Remove obsolete mail settings on
   Render after replacing old replicas. Do not change the retained origin/session settings.
2. Existing users, salted password hashes, UUIDs, ownership fields and session/security
   versions retain their format. Old `verified` fields are ignored and left untouched;
   no address is marked verified. Existing password-proven sessions remain valid until
   normal expiration/revocation. Previously unverified accounts can now sign in by password.
3. Old `auth_tokens` and `auth_mail` collections/indexes are no longer accessed, created
   or processed. Former links cannot authorize anything. Leave them inert; existing TTL
   cleanup may expire their records. No production data/indexes are dropped by this change.
   Archive/drop them only in a separately approved maintenance operation after backup and
   confirming all old workers are stopped. Do not remove active users/sessions/rates indexes.
4. Confirm unique and TTL indexes on the intended database. In staging, test two-account
   signup/login, current-password change/relogin, logout/revocation, CSRF and ownership.
   Verify Vercel-to-Render cookie forwarding over HTTPS and the complete Story generation
   journey before approving production rollout. This task does not merge or deploy.

## Verification and limitations

Repository validation discovers control-plane tests with the quoted recursive Node glob
`node --test "codebase/**/*.test.mjs"`, including all seven nested scanner tests. API/web
tests cover immediate signup, generic duplicate errors, login/logout, cookie security,
CSRF/origin checks, password changes/races, restart/expiry/revocation, rates, roles,
two-account ownership, legacy quarantine and existing generation/review/history behavior.
Removed routes, absent delivery dependencies and inert legacy structures have regressions.
The dedicated loopback browser journey uses real auth and same-origin proxy with isolated
memory persistence and fake model providers; it never sends mail or uses production data.

Fresh local verification on 2026-11-10:

- `pnpm run validate`: exit 0; architecture, lint, type checks, security and builds passed.
- 300 tests passed, zero failed/skipped: 86 control-plane (including all seven nested
  scanner tests), 176 API, 32 web, 3 logging and 3 UI. The API total includes 19 auth
  regressions; the web total includes five auth/proxy regressions. This replaces obsolete
  email-delivery coverage rather than retaining the earlier 298-test count artificially.
- Production API, shared-types and web builds ran successfully; unchanged logging/UI
  builds reused repository task-cache results.
- Real Edge journey: 43 assertions passed against the isolated production web build,
  with no JavaScript exceptions. Account screenshots at 1440px and 390px were inspected.
- Fresh TruffleHog 3.97.5 and pnpm dependency audit: passed, zero reported findings under
  the existing security policy. Security exceptions and dependencies were not changed.
- `git diff --check`: passed; no generated files or private environment files included.

Live Render environment, production Mongo indexes and HTTPS authentication smoke tests
require deployment access; offline tests cannot establish them. No merge or production
deployment is performed by this revision.
Lost passwords cannot be recovered through email. No MFA, external password breach lookup,
email ownership assertion or anonymous-history claim flow is provided.

Security references: [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
and [session management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## Email-free revision file manifest

Changes from authentication branch head `1167e3b` (36 tracked files).
`M` means modified; `D` means removed source. Ignored build/test artifacts are excluded.

```text
M	.project/story-agent/02-agentic-ai-architecture.md
M	.project/story-agent/05-usage-guide.md
M	.project/story-agent/11-authentication.md
M	README.md
D	apps/web/app/forgot-password/page.tsx
D	apps/web/app/reset-password/page.tsx
D	apps/web/app/verify-email/page.tsx
M	apps/web/features/auth/auth.client.ts
M	apps/web/features/auth/auth.server.ts
M	apps/web/features/auth/components/account-profile.tsx
M	apps/web/features/auth/components/auth-screen.tsx
M	apps/web/tests/auth.test.tsx
M	apps/web/tests/browser/story-agent-authentication.mjs
M	apps/web/tests/integration/home-page.test.tsx
M	packages/types/src/api/auth/index.ts
M	servers/api/.env.example
M	servers/api/config/env.ts
M	servers/api/features/auth/auth.admin.ts
M	servers/api/features/auth/auth.controller.ts
M	servers/api/features/auth/auth.crypto.ts
M	servers/api/features/auth/auth.repository.ts
M	servers/api/features/auth/auth.service.ts
M	servers/api/features/auth/auth.types.ts
M	servers/api/features/auth/auth.validation.ts
M	servers/api/features/auth/index.ts
M	servers/api/features/auth/tests/auth.boundaries.test.ts
M	servers/api/features/auth/tests/auth.browser-fixture.ts
M	servers/api/features/auth/tests/auth.fixture.ts
M	servers/api/features/auth/tests/auth.test.ts
M	servers/api/features/story-agent/tests/story-agent.route.test.ts
D	servers/api/integrations/email/index.ts
D	servers/api/integrations/email/tests/email.test.ts
M	servers/api/integrations/index.ts
M	servers/api/server.ts
M	servers/api/types/configuration/environment.ts
M	servers/api/validation/env.validation.ts
```

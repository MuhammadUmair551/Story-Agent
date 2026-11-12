# Story Agent usage guide

## Setup

Use a local ignored `.env`; never commit keys. Configure API baseline values (`NODE_ENV`, `API_HOST`, `API_PORT`, `WEB_ORIGIN`, `LOG_LEVEL`), `MONGODB_URI`, and one complete provider.

Phase 5 requires `AUTH_PUBLIC_ORIGIN` on the API host, included in the exact `WEB_ORIGIN`
allowlist. No outbound email service or custom domain is required. See
[authentication setup and rollout](11-authentication.md) before starting the API.
The web app keeps `NEXT_PUBLIC_API_BASE_URL` as its upstream API address; browser
requests now use the same-origin `/api` proxy. No secrets belong in `NEXT_PUBLIC_*`.

```dotenv
LLM_PROVIDERS=groq
LLM_GROQ_BASE_URL=https://provider.example.com/v1
LLM_GROQ_API_KEY=your-key-here
LLM_GROQ_MODEL=your-model-here
LLM_PROFILE_FAST=groq
LLM_PROFILE_GENERATE=groq
STORY_AGENT_MAX_CONCURRENT_RUNS=2
STORY_AGENT_MAX_REQUESTS_PER_WINDOW=6
STORY_AGENT_REQUEST_WINDOW_MS=60000
STORY_AGENT_MAX_TRACKED_CLIENTS=1000
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4000

# Optional OTLP/HTTP export; local logs remain available without these values.
OTEL_EXPORTER_OTLP_ENDPOINT=
OTEL_EXPORTER_OTLP_HEADERS=
OTEL_SERVICE_NAME=story-agent-api
```

MongoDB must permit creation of `story_agent_runs` and `story_agent_drafts` collections/indexes.
It must also permit project and authentication collections, unique indexes and TTL indexes.
Open `/signup`, then sign in immediately at `/login`. The workspace and `/account` require
an authenticated session. Account settings support display name changes, password changes
requiring the current password, sign out and sign out from all sessions. Password changes
revoke every session. Email is an unverified login identifier; no email recovery is available.
Store your password securely. Existing anonymous history stays quarantined.

## Commands

```bash
pnpm run dev
pnpm run check
pnpm run lint
pnpm test
pnpm run scan
pnpm --dir servers/api exec tsx --test features/story-agent/tests/*.test.ts
pnpm --dir servers/api exec tsx features/story-agent/story-agent.eval.ts
```

The focused `tsx --test` command is the offline, repeatable Story Agent quality gate. It uses fake provider responses and no MongoDB, credentials, or network access. It proves pipeline contracts such as validation, bounded repair/no-partial output, budgets, failover, circuit cooldown, duplicate-title handling, prompt-data delimiters, queue recovery, and deterministic concurrent-burst admission. It does not measure a provider's current quality or availability.

The evaluator is a separate live-provider command. Generation and repair require the complete Story object (including empty arrays). A structured `{"refusal":{"reason":"..."}}` becomes `failed` with `reason: "model_refusal"` and never returns a partial draft. It is a pass only for a fixture that explicitly expects that refusal. The current injection fixture includes a safe planning-story request after hostile text, so it still requires a valid draft; plain-text refusals and malformed JSON are quality failures. Each fixture is classified as:

- `passed`: expected status and output contract were met.
- `quality_failed`: a provider responded but the expected behavior or output contract was not met.
- `inconclusive`: provider capacity/configuration prevented a meaningful judgment, including `providers_unavailable`/queued runs.

The evaluator exits `0` only when every fixture passes, `1` when one or more quality failures occur, and `2` when there are inconclusive fixtures but no quality failures. Inconclusive fixtures are never counted as passes. Its diagnostics are sanitized and omit raw model output, credentials, and prompt data. Token metrics are `reported` only when the provider supplied usage; otherwise they are `unavailable`. Run it only with configured provider access; it is not part of `pnpm test`.

Repair remains bounded: at most two repairs, the prior output is limited to 12,000 characters, and at most ten validation errors of 500 characters each are supplied. The pipeline enforces six model calls, 12,000 reported total tokens, and 60 seconds; providers that omit usage cannot support exact token enforcement.

The widget is the bottom-right Gecko launcher; Ctrl+J opens and focuses it. Enter sends, Shift+Enter adds a newline, and Escape closes the panel. History lists saved runs; queued runs poll every 10 seconds. The forest-dark interface uses reusable `@workspace/ui` primitives and the `GeckoMascot` export. Nonessential mascot and interface motion is reduced for users who request reduced motion.

## API

```bash
# Use a cookie jar from a completed authenticated API login. For each unsafe request,
# use the matching csrfToken from GET /auth/session and the exact allowed web Origin.
curl -X POST http://127.0.0.1:4000/story-agent/runs -b cookies.txt \
  -H "content-type: application/json" -H "Origin: http://localhost:3000" \
  -H "X-CSRF-Token: REPLACE_WITH_SESSION_CSRF" \
  -d '{"requirement":"As a content manager, I want a post editor with title, body, and publish action so that I can publish articles."}'
curl -b cookies.txt http://127.0.0.1:4000/story-agent/runs/REPLACE_WITH_RUN_ID
```

Unauthenticated requests receive `401`; missing/mismatched CSRF or disallowed origins
receive `403`. Other accounts' resource IDs return `404`. Keep cookie jars private and
ignored. The browser handles cookies and CSRF automatically; never use localStorage tokens.

Draft/questions return `200`; queued returns `202`; failed returns `500`; validation errors return `400`; a full queue returns `503`; and a per-instance request limit returns `429` with `retryAfterMs`. `queued` is not a draft—wait for worker retry and query the run again.

## Capacity and production deployment

The API applies lightweight process-local backpressure: only `STORY_AGENT_MAX_CONCURRENT_RUNS` model runs proceed at once (including queue retries), while additional accepted requests become durable queued runs. One direct client address gets at most `STORY_AGENT_MAX_REQUESTS_PER_WINDOW` submissions in `STORY_AGENT_REQUEST_WINDOW_MS`; tracked addresses are bounded by `STORY_AGENT_MAX_TRACKED_CLIENTS`. Defaults are `2`, `6`, `60000`, and `1000` respectively. Queue admission keeps the existing durable queue maximum of 20 even when many requests arrive together. Tune these values against provider quotas and the API instance's memory/CPU; higher is not automatically better.

This is intentionally process-local protection. It caps expensive work and lets the existing queue recover safely; it does not route traffic or coordinate separate API processes. Do not cache generated stories across users: requirements and their persisted histories are user-specific. The run-history and queue-claim MongoDB indexes, plus a direct MongoDB queue count rather than loading every queued run, are the relevant server-side read optimizations.

The MongoDB queue is durable, but its polling worker runs inside this long-lived API
process. Do not deploy this API as serverless functions or on a host that sleeps while
queued processing must continue. See `enablers/observability/README.md` for the current
Vercel frontend + persistent API host recommendation and telemetry setup.

## Troubleshooting

The browser page's origin must be explicitly allowed by the API's `WEB_ORIGIN` setting.
Use `https://story-agent.vercel.app` for the current production app. A deployment-specific
Vercel URL has a different origin, even when it serves the same build. To enable an approved
deployment URL, keep the production origin and add that exact origin, separated by a comma:

```text
WEB_ORIGIN=https://story-agent.vercel.app,https://story-agent-q73gz3x33-umair-5b36.vercel.app
```

Deploy the allowlist-capable API code before applying a comma-separated value; older API
versions accept only one origin. Set this on the API host (currently Render), after approval,
and restart the API to apply it.
Do not change the frontend API URL or allow all `*.vercel.app` sites. Unlisted origins remain
blocked by browser CORS checks. Verify the `OPTIONS /story-agent/runs` response echoes the
request's trusted origin and allows `Content-Type` and `X-Request-Id` before testing generation.
Phase 5 browser requests go through Next's same-origin `/api` route, which forwards the
trusted web Origin to Render. Keep the existing exact API allowlist. The canonical
`AUTH_PUBLIC_ORIGIN` must be an allowed HTTPS origin in production; a free Vercel hostname
is sufficient. The Next host must support
the existing generation duration; its proxy bounds upstream requests at 110 seconds and
does not extend a hosting platform's function limit.

| Symptom | Action |
|---|---|
| API routes unavailable | Configure MongoDB and all authentication environment values; startup fails closed on invalid auth configuration. |
| Forgotten password | Email recovery is unavailable. Change the password from an active session only with the current password; no identity shortcut is supported. |
| `401` / `403` | Sign in again, refresh the CSRF session and verify the exact web Origin. |
| Immediate `Failed to fetch` on a deployment URL | Check its exact browser origin against the API's `WEB_ORIGIN`; a 204 preflight with a different `Access-Control-Allow-Origin` is rejected before generation. |
| Provider unavailable/queued | Check complete provider vars, profile names, quota, and cooldown. |
| Empty history | Check Mongo reachability and `NEXT_PUBLIC_API_BASE_URL`. |
| Input rejected | Requirement is 1–4000 chars; API context max is 8000. |
| Eval queues later fixtures | Provider quota/circuit cooldown; wait or configure independent capacity. |
| `429` Story Agent response | Wait for `retryAfterMs`, then retry; tune capacity only after confirming provider quotas. |
| Many queued requests | Keep the configured queue bounded and lower the live concurrency limit if provider quotas are being hit. |

# Story Agent usage guide

## Setup

Use a local ignored `.env`; never commit keys. Configure API baseline values (`NODE_ENV`, `API_HOST`, `API_PORT`, `WEB_ORIGIN`, `LOG_LEVEL`), `MONGODB_URI`, and one complete provider.

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
curl -X POST http://127.0.0.1:4000/story-agent/runs \
  -H "content-type: application/json" \
  -d '{"requirement":"As a content manager, I want a post editor with title, body, and publish action so that I can publish articles."}'
curl http://127.0.0.1:4000/story-agent/runs/REPLACE_WITH_RUN_ID
```

Draft/questions return `200`; queued returns `202`; failed returns `500`; validation errors return `400`; a full queue returns `503`; and a per-instance request limit returns `429` with `retryAfterMs`. `queued` is not a draft—wait for worker retry and query the run again.

## Capacity and production deployment

The API applies lightweight process-local backpressure: only `STORY_AGENT_MAX_CONCURRENT_RUNS` model runs proceed at once (including queue retries), while additional accepted requests become durable queued runs. One direct client address gets at most `STORY_AGENT_MAX_REQUESTS_PER_WINDOW` submissions in `STORY_AGENT_REQUEST_WINDOW_MS`; tracked addresses are bounded by `STORY_AGENT_MAX_TRACKED_CLIENTS`. Defaults are `2`, `6`, `60000`, and `1000` respectively. Queue admission keeps the existing durable queue maximum of 20 even when many requests arrive together. Tune these values against provider quotas and the API instance's memory/CPU; higher is not automatically better.

This is intentionally process-local protection. It caps expensive work and lets the existing queue recover safely; it does not route traffic or coordinate separate API processes. Do not cache generated stories across users: requirements and their persisted histories are user-specific. The run-history and queue-claim MongoDB indexes, plus a direct MongoDB queue count rather than loading every queued run, are the relevant server-side read optimizations.

The MongoDB queue is durable, but its polling worker runs inside this long-lived API
process. Do not deploy this API as serverless functions or on a host that sleeps while
queued processing must continue. See `enablers/observability/README.md` for the current
Vercel frontend + persistent API host recommendation and telemetry setup.

## Troubleshooting

| Symptom | Action |
|---|---|
| API routes 404 | Configure `MONGODB_URI` and restart; routes compose only with persistence. |
| Provider unavailable/queued | Check complete provider vars, profile names, quota, and cooldown. |
| Empty history | Check Mongo reachability and `NEXT_PUBLIC_API_BASE_URL`. |
| Input rejected | Requirement is 1–4000 chars; API context max is 8000. |
| Eval queues later fixtures | Provider quota/circuit cooldown; wait or configure independent capacity. |
| `429` Story Agent response | Wait for `retryAfterMs`, then retry; tune capacity only after confirming provider quotas. |
| Many queued requests | Keep the configured queue bounded and lower the live concurrency limit if provider quotas are being hit. |

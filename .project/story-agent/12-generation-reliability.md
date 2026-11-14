# Generation reliability

This application change follows the production audit of merged commit `6b73aaf`.
Authentication, ownership, CSRF, admission limits, Quality Gate, refinement, impact
analysis and backlog intelligence remain in place. No external dependency is added.

## Output and recovery

The gateway sends strict `response_format.json_schema` only for documented combinations:
HTTPS `api.groq.com/openai/v1` with `openai/gpt-oss-20b` or `openai/gpt-oss-120b`.
Other combinations remain compatible through prompts and mandatory local validation;
they never receive unsupported schema parameters. Required strict recovery skips
incompatible providers before a physical attempt is charged.

Wire schemas derive required hierarchy fields from the existing Zod contracts, using
the portable strict subset: object/array types, required properties, enums and closed
objects. Full local validation still enforces lengths, nonempty arrays, story limits,
acceptance criteria, identities, duplicates and project rules. Optional historical
metadata is outside new-plan generation's wire schema. Refinement uses its own strict
identity/context/change-explanation schema, with stable artifact IDs and metadata
required in the wire response. Existing local identity and projection checks remain.

Finish reasons survive transport. Completion-limit termination, truncated JSON, invalid
JSON, unsupported wrappers, missing fields, wrong types and invalid story structure
have distinct diagnostics. Only an explicit legacy `stories` object enters legacy
validation. Required outcomes, stories and acceptance criteria are never fabricated.

At most two repairs are allowed. One repair may reuse the original provider with
precise errors, bounded original output, requirement, context and existing titles.
After two content failures that provider is excluded for the execution and its queued
continuations. An independent compatible provider may perform the remaining repair;
otherwise failure explains the unavailable recovery capability. Last safe field errors
survive recovery failures. Invalid content cannot be persisted as a usable draft.

## Budgets, persistence and compatibility

Policy remains six physical provider attempts, 12,000 reported tokens, sixty seconds
of cumulative active processing, five queue attempts and thirty-minute queue expiry.
Waiting does not consume processing time; expiry bounds it separately. Every failed
attempt, fallback and repair consumes the same request allowance. Accounting and the
lease are persisted before transport. A provider timeout is reserved first and refunded
after settlement; a crash conservatively consumes its unobserved reservation. Per-call
timeouts cannot exceed the remaining deadline. Missing provider usage still prevents
proof of exact token consumption; physical calls and deadlines remain bounded.

Temporary failures use queued exponential backoff with bounded jitter and a safe
Retry-After lower bound. Permanent access, account, model and capability errors never
enter blind retry loops. Known 401/403/402/404 rejections are retained across stages
and queue continuation for that run; those providers are not tried again for it.
Provider calls remain sequential.

Run IDs exist before provider work. Repeating a request ID for one authenticated owner
reuses the saved run without bypassing admission rate limits. Reusing it for another
input returns 409. Another owner cannot reuse that result. Distinct user submissions
remain distinct runs.

Foreground reservations have five-minute leases and explicit per-process admission
tracking that preserves twenty waiting runs plus foreground concurrency. Interrupted
reservations immediately count as waiting work; a restart cannot hide their queue depth.
Background processing still
occupies queue depth. Atomic claims assign lease tokens; checkpoints and terminal
updates compare them. Candidate/result tags and monotonic draft generations fence
draft visibility and replacement, including a lease change between collection reads.
Only validated owner-matching durable output is reconciled without regeneration.

New optional fields hold accounting, diagnostics, correlation, request fingerprints,
leases and candidate/result tags. No collection, index or destructive
migration is required. Completed histories and legacy flat stories remain readable.
Older queued model work cannot provide trustworthy physical-attempt history: it becomes
terminal `budget_history_unavailable` rather than silently acquiring a new budget.
A user can explicitly submit a new run. Zero-work capacity queues initialize empty
accounting. Valid durable output is reconciled first. Do not rewrite counters or delete
history to hide this state.

After separate deployment approval, ensure older workers have drained before relying
on cross-instance fencing: old binaries do not understand the new lease checks.
External API consumers must accept the additive quality state `not_evaluated`.
This task does not merge, deploy, migrate or change production settings.

## API, UI and observability

Failures retain run ID, stable category/reason, HTTP status, stage, retryability and
safe provider/model identity through the client exception and UI. Saved failed attempts
can be reopened from the owner-scoped vault. Queued/failed generations without valid
plans show generation diagnostics, never passed quality or refinement controls. New
runs/selections clear old plan/quality state; obsolete responses cannot restore it.
Actionable validation feedback remains available without pretending a missing plan
passed review. Quality evaluation applies only to validated plans.

Logs correlate request, run, lease, physical attempt, stage and persistence. Passwords,
cookies, session tokens, keys, URIs, prompts, generated output and raw upstream bodies
are excluded. IDs remain trace/log fields, never high-cardinality metric labels.

## Provider operator checklist

Evidence is the 2026-11-14 audit, not a new live test. Actual Render base URLs,
credential scopes, quotas and entitlements remain unverified. No production setting
or credential was changed.

| Provider | Evidence / capability | Private dashboard checks | Exact variables / conditional action |
| --- | --- | --- | --- |
| Groq | Successful `openai/gpt-oss-20b` completions and two 429s. Strict schema supported. | Groq Console: project model permissions, usage and rate limits; distinguish request/token limits from account quota. | Expected `LLM_GROQ_BASE_URL=https://api.groq.com/openai/v1`, `LLM_GROQ_MODEL=openai/gpt-oss-20b`; keep `LLM_GROQ_API_KEY` private. This code needs no new key/model. |
| Gemini | `gemini-2.5-flash` returned 404; model access versus endpoint cause unknown. No strict combination is claimed by this implementation. | Google AI Studio: existing key's project and available model list. | Verify `LLM_GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai` and `LLM_GEMINI_MODEL`. A replacement ID must come from that project's actual list; none is invented. Change `LLM_GEMINI_API_KEY` only if credential/project ownership is proven wrong. |
| Ollama Cloud | `gemma4:31b:cloud` returned 402; exact account restriction unknown. Cloud structured output is unsupported. | Ollama account usage/balance, API entitlement and cloud model library. | Verify `LLM_OLLAMA_BASE_URL=https://ollama.com/v1`, `LLM_OLLAMA_MODEL` and private `LLM_OLLAMA_API_KEY`. Use a direct-API ID verified in the account/catalog; the CLI suffix is not proof of validity. No billing upgrade is requested. |

1. Inspect dashboards privately. Never share keys, cookies or complete environment dumps.
2. Check named provider triples and routing precedence: `LLM_PROVIDERS`,
   `LLM_PROFILE_FAST`, `LLM_PROFILE_GENERATE`, `LLM_PROFILE_TOOLS`,
   `LLM_COOLDOWN_MS`, and `LLM_<NAME>_TIMEOUT_MS`. Existing legacy `LLM_*`,
   `FALLBACK_LLM_*` and `OLLAMA_*` aliases retain their precedence.
3. Verify non-secret URL/model identifiers against the exact selected variables.
   Do not rotate credentials solely because a 404 or 402 occurred.
4. Unavailable access is an operator limitation. Changing a production route/model
   requires separate approval; do not purchase plans or assume another provider works.
5. On a separately approved Preview/staging environment, perform one synthetic
   authenticated generation; verify the hierarchy, saved failure metadata, physical
   attempts and final state. Inspect safe logs privately without sharing raw output.
6. Production smoke tests remain NOT RUN until approved. Offline tests and Preview
   builds do not prove provider entitlement or production generation success.

References: [Groq structured output](https://console.groq.com/docs/structured-outputs),
[Gemini compatibility](https://ai.google.dev/gemini-api/docs/openai),
[Ollama Cloud limitations](https://docs.ollama.com/cloud).

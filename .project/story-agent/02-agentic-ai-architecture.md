# Story Agent architecture — v0.5 final

Status: implemented, reliability-fixed, and verified against repository files on 2026-10-21.

Repository rules in `AGENTS.md`, `CLAUDE.md`, `architecture.yaml`, and `.agent/` remain authoritative. Two referenced source documents (`01-*` and `03-*`) were not present in `.project/story-agent/` during this review; this document does not infer their contents.

## Scope and composition

Story Agent is a feature-owned Express API plus an app-wide floating Next.js chat widget. It produces `questions`, `draft`, `failed`, or `queued`.

```text
Web widget -> POST /story-agent/runs -> service pipeline -> provider router -> LLM gateway -> provider
                         |                    |                    |                  |
                         v                    v                    -> failover/circuit state  -> HTTP/auth/timeout
                    MongoDB runs/drafts <- queue worker retries queued work
```

`servers/api/server.ts` is the only runtime composition point for external clients: it creates the MongoDB integration and the OpenAI-compatible LLM gateway, then injects their contracts into `servers/api/features/story-agent/index.ts`. The feature creates its repository/router/service/queue from those contracts, ensures indexes, registers route dependencies through `createApp`, and starts/stops the queue worker.

## Actual files

| Area | Files | Responsibility |
|---|---|---|
| Server integrations | `servers/api/integrations/mongodb/**`, `servers/api/integrations/llm/**` | Mongo driver lifecycle/persistence contract and OpenAI-compatible HTTP transport/gateway contract. |
| Composition | `index.ts` | Wires repository, provider router, pipeline, queue, and route dependencies from injected Mongo/LLM contracts. |
| HTTP | `routes/index.ts`, `routes/story-agent.route.ts`, `story-agent.controller.ts` | Express endpoints, request validation, response mapping. |
| Pipeline | `story-agent.service.ts` | Intake, context selection, clarify, generate, validate, repair, usage/provider/stage ledger. |
| Provider policy | `story-agent.router.ts`, `story-agent.config.ts` | Profiles, provider selection, failover, typed transport-error handling, circuit breaker. |
| Validation/prompts | `story-agent.validation.ts`, `story-agent.json.ts`, `story-agent.{clarify,generate,repair}.prompt.ts` | Zod, fenced JSON extraction, prompts; clarify prompt is version 2. |
| Persistence/queue | `story-agent.repository.ts`, `story-agent.queue.ts` | Mongo collection/index access, atomic queue claim, retry worker. |
| Evaluation/tests | `story-agent.eval.ts`, `tests/story-agent.*.test.ts` | Five live fixtures and fake-boundary tests. |
| Web | `apps/web/features/story-agent/**`, `apps/web/app/layout.tsx` | Floating FAB, panel, chat, history, client, polling. |

## Web experience and reusable UI boundary

The web client uses a forest-dark, Gecko-led visual identity. `packages/ui` remains the generic presentation boundary: its controlled public exports provide shadcn primitives plus one canonical `GeckoMascot` SVG. It supports CSS-only idle, thinking, speaking, and happy states (with compatible success/error variants), glossy eye motion, and reduced-motion behavior without a JavaScript animation loop.

Story Agent compositions stay feature-owned in `apps/web/features/story-agent/components/`: `story-agent-widget.tsx` owns the accessible floating launcher and feature state; `story-agent-panel.tsx` owns the dialog/tabs; `story-agent-chat.tsx` composes workshop states; `story-agent-composer.tsx` owns the sticky brief input; `story-agent-empty-state.tsx` owns guided starter briefs; `story-agent-run-state.tsx` selects loading/questions/queued/failed/draft states; `story-agent-draft-collection.tsx` and `story-agent-criteria.tsx` render the story dossiers and structured criteria; `story-agent-history.tsx` owns archive search and saved-run selection. They consume package exports rather than package internals. API calls, polling, state, and domain formatting are deliberately not moved into `packages/ui`.

## Capacity and deployment boundary

`story-agent.capacity.ts` provides bounded, process-local admission for expensive live model runs: it caps concurrent runs, limits a client window, bounds tracked-client memory, and sends accepted overflow into the existing durable MongoDB queue. The queue worker shares that same concurrency cap, so retry traffic cannot add another unbounded provider call. Defaults are two live runs, six requests per minute per direct client address, and at most 1,000 tracked clients; deployments can override them with `STORY_AGENT_MAX_CONCURRENT_RUNS`, `STORY_AGENT_MAX_REQUESTS_PER_WINDOW`, `STORY_AGENT_REQUEST_WINDOW_MS`, and `STORY_AGENT_MAX_TRACKED_CLIENTS`. A rate-limited request receives `429` before model work starts; capacity overflow persists as the normal `queued` state and is recovered by the existing atomic queue claim. Queued-run count and persistence are serialized in the controller, so a burst cannot exceed the existing 20-run durable queue limit.

This is intentional local backpressure, not a load-balancing feature. It bounds concurrency and request rate within one API process; the feature does not start workers, route traffic, or coordinate separate API processes. Story Agent does not cache generated output because runs contain user requirements and require an individually persisted history record; MongoDB indexes instead serve run-history ordering and queue claims. Queue capacity uses `countDocuments`, so admission does not materialize every queued run in application memory.

The panel is responsive (full width on small screens, bounded at 470px otherwise), supports Ctrl+J, Enter/Shift+Enter, Escape, labelled controls, visible focus states, semantic alert/error output, and status text that never relies on color alone. Browser-level visual and assistive-technology testing remains a manual verification step.

### Experience design system

The design uses a forest-dark surface ladder: near-black canvas (`#0b1510`), panel canvas (`#0c180f`), raised surfaces (`#132116`/`#172a1a`), and sage structural borders. Leaf green is reserved for primary actions, progress, and positive outcome signals; amber, teal, and coral communicate queued, clarification, and error states with matching text—not color alone. The typography system pairs a serif editorial display face for story titles and section headings with a neutral sans-serif interface face and monospace indices/metadata.

The assistant is a bounded workshop rather than a chat transcript: mobile uses a single-column, full-width panel; larger screens use a 470px panel with a 2xl content measure. Spacing follows a compact 4/8/12/16/24px rhythm. Drafts are rendered as a numbered collection of dossier sections with a narrow navigation strip, a title/outcome hierarchy, scannable epic/scope/state metadata, and criteria rows. The shared Gecko is an original long-tailed SVG with feet, facial marks, a distinct tail, and CSS-only body/tail/eye movement; reduced-motion disables it.

## API

Routes are registered only when Mongo persistence is configured.

| Method/path | Request | Responses |
|---|---|---|
| `POST /story-agent/runs` | `{ "requirement": string, "context"?: string }` | `200` draft `{runId,status:"draft",stories,usage}`; `200` questions `{runId,status:"questions",questions,usage}`; `202` queued `{runId,status:"queued",message}`; `500` failed `{runId,status:"failed",error,usage}`; validation errors flow through API middleware (`400`); queue capacity >=20 returns `503`. |
| `GET /story-agent/runs?limit=20&skip=0` | query optional; limit capped at 100 | `200 { runs }`, newest first. |
| `GET /story-agent/runs/:id` | run ID | `200 { run, draft }`; `404` when absent. |

Shared contracts: `packages/types/src/api/story-agent/story-agent.ts`. A story has title, intent, epic, `S|M|L` size, acceptance criteria, states, dependencies, open questions, and slice rationale.

## MongoDB

- `story_agent_runs`: runId, status, requirement, optional context, usage, providers, attempts, stages, validation errors, optional reason/error, queue schedule/lock fields, timestamps.
- `story_agent_drafts`: runId, stories, createdAt.
- Indexes: unique runId on both collections; descending run createdAt; run `{status,nextAttemptAt}`.

`QUEUE_INTERVAL_MS` defaults to 120000 ms. The worker atomically claims one eligible run, locks it five minutes, increments `queueAttempts`, and processes one at a time. Draft/questions persist final results; provider unavailability reschedules; other failures fail; five queue attempts or expiry fail with `expired`.

## Integration boundaries, providers, budgets, and failure behavior

The LLM boundary is server-owned: `servers/api/integrations/llm/openai-compatible.ts` owns OpenAI-compatible URL construction, HTTP request/authorization, timeout/abort, response parsing/usage normalization, and typed transport errors. Its public `LlmGateway` contract is exported only through `servers/api/integrations/llm/index.ts` and `servers/api/integrations/index.ts`.

Story Agent code may depend on `LlmGateway`, `LlmClient`, completion values, and typed transport errors. It must not import provider SDKs, call provider URLs, construct authorization headers, or invoke `fetch` for provider communication. The feature router owns application policy: configured profiles, provider ordering, failover, cooldown state, and circuit-breaker decisions. The service owns prompts, bounded generation/repair, and output validation. This keeps transport failures explicit without moving product policy into infrastructure.

MongoDB follows the same direction: `servers/api/integrations/mongodb/**` alone imports Mongoose and exposes `MongoPersistence`; `story-agent.repository.ts` receives that contract and owns only Story Agent collections and query intent. No Story Agent service/controller/router imports the driver or a raw database client.

The architecture validator enforces these rules. Server code outside `integrations/**` cannot import configured vendor transport packages (`mongoose`, `redis`, `stripe`, `openai`, `groq-sdk`, `@google/generative-ai`, `ollama`). `features/story-agent/**` additionally cannot invoke configured external transport calls (`fetch`); this narrow scope avoids treating legitimate internal HTTP in unrelated runtime code as a provider integration. Tests are exempt for local HTTP boundary verification; approved implementations live under `servers/api/integrations/**`. New external systems must add a server integration, public index, explicit contract, deterministic fake-boundary tests, and the corresponding machine-readable policy entry before feature use.

The LLM gateway posts to `${baseUrl}/chat/completions`. 429/5xx/transport/timeout are retryable; 401/403 are auth; remaining HTTP failures are bad request. Named providers are `gemini`, `groq`, `ollama`; legacy, fallback, and Ollama aliases are also recognized when complete.

Profiles are `fast`, `generate`, `tools`, defaulting to configured providers unless profile variables override them. The router fails over in profile order and opens a circuit after two failures for `LLM_COOLDOWN_MS` (default 60000 ms), then allows one trial. Provider exhaustion becomes `providers_unavailable`, which the pipeline returns as `queued`.

Feature limits: max 6 model calls, 12000 reported total tokens, 60000 ms elapsed, 6000 context tokens, 10 stories. Provider timeout defaults to 30000 ms. Flow: clarify (`fast`), generate (`generate`), then at most two repairs. Repair input is bounded to 12,000 prior-output characters plus ten validation errors of 500 characters each. Permanent invalid output is `failed`/`validation_failed`; no partial stories are returned. A structured `{"refusal":{"reason":"..."}}` becomes `failed`/`model_refusal`; plain-text refusals and malformed JSON are controlled failed outputs, not drafts. Providers without usage values produce unavailable token metrics, so exact token enforcement is limited to reported usage.

## Validation and safety

- Requirement: 1–4000 trimmed chars; context: optional, <=8000 chars.
- Supplied existing context uses titles only, keyword-overlap ranking, and context budget.
- Stories require 1–20 AC; duplicates in output or supplied titles fail validation.
- Requirement/context are delimited prompt data; prompts say not to execute embedded instructions. Markdown-fenced JSON is extracted then Zod-validated.
- Keys are environment values only; documentation uses placeholders.

## Environment

API baseline: `NODE_ENV`, `API_HOST`, `API_PORT`, `WEB_ORIGIN`, `LOG_LEVEL`. Story Agent API/worker additionally require `MONGODB_URI`.

| Configuration | Variables |
|---|---|
| Named list | `LLM_PROVIDERS=gemini,groq,ollama`; matching `LLM_<NAME>_BASE_URL`, `_API_KEY`, `_MODEL`, optional `_TIMEOUT_MS` |
| Legacy | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, optional `LLM_TIMEOUT_MS` |
| Fallback | `FALLBACK_LLM_BASE_URL`, `_API_KEY`, `_MODEL` |
| Ollama aliases | `OLLAMA_BASE_FREE_URL`, `OLLAMA_API_KEY`, `OLLAMA_FREE_MODEL` |
| Routing | `LLM_PROFILE_FAST`, `LLM_PROFILE_GENERATE`, `LLM_PROFILE_TOOLS`, `LLM_COOLDOWN_MS` |
| Queue | `QUEUE_INTERVAL_MS` (default 120000) |

Web requires `NEXT_PUBLIC_API_BASE_URL`.

## Reliability fixes applied in this revision

The current implementation preserves durable state for queued and historical runs by storing the actual `questions` and `stories` payloads alongside the run status. This keeps draft restoration, history selection, and queued retry recovery accurate after server restarts and avoids silently dropping the last valid conversation state.

The web client also now prevents stale async responses from overwriting a newly selected conversation, clears the active conversation only on the explicit New Chat action, supports search across requirement text and story titles, and exposes copy actions for the full response or an individual story.

Known documentation limits remain honest: the project uses deterministic offline tests and a live-provider evaluation script, but live provider quality remains externally dependent and is not treated as a repository pass criterion.

## Evidence, gaps, and V2

Offline tests cover the LLM gateway request/auth/timeout/parsing/error contract, provider router failover/cooldown, service draft/questions/concise meaningful intake/repair/permanent validation failure/duplicate-title rejection/token and elapsed-time budgets/provider-unavailable/context/injection/oversized input, repository, queue, validation, and HTTP mapping. Architecture-boundary fixtures also reject direct provider SDK imports and raw transport calls outside server integrations. They use fakes and are the required repeatable quality gate; they do not measure live-provider quality.

Live eval has five fixtures (clear, ambiguous, existing-title, long, injection), is sequential, and pauses eight seconds between fixtures. It reports `passed` when expected behavior and output validation succeed, `quality_failed` when a usable provider response cannot meet the expected contract, and `inconclusive` when provider capacity/configuration prevents a meaningful result (including queued `providers_unavailable` or `no_provider_configured`). It exits 0 for all-pass, 1 for one or more quality failures, and 2 for inconclusive-only runs. A structured refusal passes only when the fixture explicitly expects `failed`/`model_refusal`; the existing injection fixture expects a valid safe planning draft. On 2026-10-17, three Groq evaluations consistently returned a clear requirement as `draft` and ambiguous as `questions`; later fixtures could be `queued` after quota/circuit cooldown. No quota-free live-eval claim is made.

Known gaps: provider quota can queue eval work; UI submits requirement only although API supports context; no accept/reject draft workflow; live Mongo + real-provider E2E remains manual.

V2 candidates (not implemented): live context tool calling, critic/reviewer pass, accept/reject workflow, task/test-case generation.

Top risks: provider quota/outage (add paced eval/provider capacity); weak model JSON (add critic/eval scoring); incomplete context (bounded, auditable retrieval/tool calling).

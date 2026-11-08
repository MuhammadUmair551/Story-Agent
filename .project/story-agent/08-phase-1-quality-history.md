# Phase 1: quality, refinement, and history

## Audit (2026-11-08, before implementation)

Scope: application behavior in web/API, genuinely shared API contracts, and the
existing MongoDB adapter's deletion operation. No foundation/control-plane work.

Already complete: nested initiative/epic/feature/story/task schemas and generation;
legacy story normalization; schema, story-count, and normalized story-title duplicate
validation; bounded repair (two attempts), budgets, provider routing, queue, telemetry;
run/draft persistence keyed by unique runId; history list/detail and restoration.
There is no numeric quality score to preserve. The existing quality gate is
validateStories/validatePlan in story-agent.service.ts, not the live-provider evaluator.

Partial: quality errors exist but lack actionable structured explanations; nested
contracts validate structure without level-specific advisory feedback. Vault opens
entries but has no deletion. Documentation describes some quality behavior more
broadly than the actual deterministic checks.

Missing: explainable proposals with explicit accept/reject and retained originals;
individual history deletion, confirmation, isolation, and failure feedback.

Reuse: existing service run/generate/repair pipeline, provider admission and telemetry,
schemas, run/draft repository, HTTP error handler, client and StoryForge, shared
Button/AlertDialog/Select/Textarea primitives, Node test runner and dependency fakes.

## Implementation scope

Keep blocking validation behavior unchanged; expose those checks and add advisory,
hierarchy-aware findings with issue/reason/impact/fix/status. Semantic coverage and
independence must honestly request review when deterministic evidence is insufficient.
Refine a selected artifact/subtree through the same bounded generation pipeline,
retain immutable original/proposed snapshots and field explanations inside its run,
and resolve accepted revisions on reads. Use optimistic version checks for decisions.
No migration or identity fields are needed.

Delete the exact runId's draft and run. Mark deletion before cleanup, exclude marked
runs from queue claims, refuse deletion while a worker holds an active lease, and
leave failed cleanup retryable. No unrelated run or associated revision is removed.

Validation results and remaining limits are recorded below after implementation.

## Implemented behavior

- The existing schema/count/normalized-story-title gate still determines blocking
  success. It now returns structured issue/reason/impact/suggestedFix/status feedback.
  Advisory scope, wording, testability, independence, coverage, and overlap reviews
  respect hierarchy levels. Initiative/epic/feature reviews do not impose story syntax.
  Semantic coverage and independence are explicitly marked for human review.
- Refinement selects an initiative, epic, feature, story, or task subtree. It calls
  the same provider router, generation prompt, bounded repair loop, budgets, validation,
  and telemetry infrastructure. It skips asking the already-saved brief to clarify
  itself again. Applicable quality findings are supplied to the refinement prompt.
- The server projects only the selected candidate subtree onto the original plan
  before running the existing gate. Every changed leaf (or added/removed object) needs
  exactly one nonempty provider explanation and reason. Unexplained/no-change output
  cannot become a proposal. All other artifact content is preserved by construction.
- Proposals retain complete original/proposed plan snapshots, explanations, proposed
  quality, status, and timestamps inside their owning run. Optimistic versions prevent
  concurrent proposals or stale/double decisions from overwriting history. Accept and
  reject are explicit API/UI operations. Accepted revisions are resolved on reads;
  initial run/draft content remains stored. Unchanged legacy story titles retain their
  states, dependencies, open questions, and applicable slice rationale in the active view.
- The UI uses existing shared Select, Textarea, Button, and AlertDialog primitives.
  It shows readable original/proposed artifact fields, reasons, proposed quality,
  accept/reject controls, saved revisions, and a reload action for recovery.
- Vault entries have separate open/delete actions. The confirmation names the entry.
  Successful deletion removes that runId's draft and run (including embedded revisions),
  clears a selected entry, refreshes history, and reports success. Missing/busy/storage
  failures retain safe UI state and show feedback. A deletion marker blocks queue claims;
  active queue leases return 409. Partial cleanup keeps the marked run for retry.

## API and storage changes

- Generation responses can include additive `quality` feedback.
- `POST /story-agent/runs/:id/refinements` takes artifactPath, instructions, and version.
- `POST /story-agent/runs/:id/refinements/:proposalId/decision` takes accept/reject and version.
- `DELETE /story-agent/runs/:id` removes only the owned history entry and artifacts.
- Run detail returns effective accepted plan/stories, quality, revisions, and version.
  History lists resolve the accepted plan while omitting full revision snapshots.
- Optional run fields: quality, refinements, refinementVersion, deletingAt. The existing
  two collections and unique runId indexes remain. No migration, new collection, user
  identity, ownership backfill, authentication, or authorization was introduced.
- The MongoDB adapter gains an instrumented deleteOne operation. Web explicitly links
  the existing shared-types workspace package; no external dependency/version is added.

## Deliberate limits

- Advisory checks and provider explanations support review; they do not prove semantic
  correctness, complete requirement coverage, or absence of behavior overlap.
- One pending proposal per run, at most 20 proposals per entry, original plan JSON up to
  24,000 characters, request instructions up to 2,000 characters, and at most 300
  explained changes. Existing generation/repair/provider budgets remain in force.
- Deletion is retryable across the existing two collections, not a multi-document
  transaction. A failed cleanup remains marked and requires the user to retry deletion.
- Live-provider and live-MongoDB/Atlas smoke tests were not run. Deterministic service,
  HTTP, repository-fake, client, and real-browser checks exercise the application paths.
- No deployment, commit, push, merge, backlog integration, impact analysis, or project
  rules engine was performed.

## Validation results (2026-11-08)

- PASS: corepack pnpm run validate (exit 0). This runs node:check (54 module files),
  repository architecture validation, all five workspace lint/typecheck tasks, the full
  test suite, and production builds. The final run passed all 86 control-plane tests
  and 118 workspace tests (API 100, web 12, UI 3, logging 3): **204 total**.
- Production builds: types/API/web passed; unchanged logging/UI builds reused valid
  control-plane cache entries. Next.js compiled, type-checked, and prerendered the app.
- PASS: node codebase/cli/repo.mjs scan --json. pnpm dependency audit: 0 findings;
  pinned TruffleHog 3.97.5: clean, 0 findings.
- PASS: latest focused tsx --test run of story-agent.phase1.test.ts and
  story-agent.phase1.route.test.ts: 11/11, followed by API ESLint and tsc --noEmit.
  These final checks cover retained legacy metadata and quality findings supplied to
  the existing refinement pipeline in addition to the aggregate regression suite.
- PASS: initial focused service/repository/HTTP suite: 13/13. Additional provider
  failure and concurrent-proposal cases subsequently passed in the final suites.
- PASS: real headless Edge interaction smoke against the Next.js UI and local fake
  provider/persistence API: original/proposed review, reject/accept, task selection,
  accepted revision restoration after reload, delete confirmation/cancel, failed
  deletion/retry, isolation, successful refresh, no JavaScript exceptions, and a
  390px viewport horizontal-overflow check. Desktop comparison visually inspected.
- PASS: git diff --check. Initial checkout had no pending changes.

An initial full-test attempt timed out in the existing TruffleHog fixture under cold
concurrent load. Its isolated rerun passed, and the final full validation passed all
86 control-plane tests. Early sandbox-only HTTP attempts were blocked by loopback
restrictions; the successful HTTP/browser runs used permitted local execution.
The cached repository-pinned pnpm 11.19.0 was used; no global pnpm 12 fallback was used
for validation. The lockfile changes only by the new internal shared-types link.

Evidence (ignored local outputs):

- .repo-cache/phase1-validate.txt
- .repo-cache/phase1-unit-tests.json
- .repo-cache/phase1-final-api-tests.txt
- .repo-cache/phase1-api-lint.txt
- .repo-cache/phase1-scan.json
- .repo-cache/phase1-browser.txt
- .repo-cache/phase1-review-desktop.png

## Final changed files

- .project/story-agent/08-phase-1-quality-history.md
- apps/web/app/globals.css
- apps/web/features/story-agent/components/quality-review.tsx
- apps/web/features/story-agent/components/story-forge.tsx
- apps/web/features/story-agent/story-agent.client.ts
- apps/web/features/story-agent/story-agent.history.ts
- apps/web/features/story-agent/story-agent.types.ts
- apps/web/package.json
- apps/web/project.json
- apps/web/tests/story-agent-ui.test.ts
- packages/types/src/api/index.ts
- packages/types/src/api/story-agent/index.ts
- packages/types/src/api/story-agent/story-agent.ts
- packages/types/src/index.ts
- pnpm-lock.yaml
- servers/api/constants/http/status.ts
- servers/api/features/story-agent/routes/story-agent.route.ts
- servers/api/features/story-agent/story-agent.controller.ts
- servers/api/features/story-agent/story-agent.quality.ts
- servers/api/features/story-agent/story-agent.queue.ts
- servers/api/features/story-agent/story-agent.refinement.ts
- servers/api/features/story-agent/story-agent.repository.ts
- servers/api/features/story-agent/story-agent.service.ts
- servers/api/features/story-agent/story-agent.validation.ts
- servers/api/features/story-agent/tests/story-agent.controller.test.ts
- servers/api/features/story-agent/tests/story-agent.fixture.ts
- servers/api/features/story-agent/tests/story-agent.memory.ts
- servers/api/features/story-agent/tests/story-agent.phase1.route.test.ts
- servers/api/features/story-agent/tests/story-agent.phase1.test.ts
- servers/api/features/story-agent/tests/story-agent.queue.test.ts
- servers/api/features/story-agent/tests/story-agent.repository.test.ts
- servers/api/features/story-agent/tests/story-agent.route.test.ts
- servers/api/integrations/mongodb/connection.ts
- servers/api/integrations/mongodb/types.ts
- servers/api/tests/mongodb.test.ts

## Git and completion

Branch: feat/story-agent-quality-refinement (preserved). 35 changed files:
26 modified tracked files and 9 new files. Nothing staged, committed, pushed, merged,
or deployed. Temporary test servers and the isolated browser were stopped. No
foundation/control-plane, unrelated UI, environment, or generated Next.js source file
change remains. No remaining implementation blocker; the live-provider/Atlas and
semantic-review limits above remain deliberate.

## Post-review fixes (2026-11-08)

This section supersedes the initial completion assessment above. Work began with the
35 existing, unstaged Phase 1 files intact. Only the three reviewed findings are in scope;
Phase 2, staging, commits, pushing, merging, and deployment remain excluded.

### 1. Stable story context through refinement

The old active-view projection joined legacy context using the current story title.
A title edit therefore lost states, dependencies, questions, and slice rationale.
Optional `artifactId` and `metadata` fields now travel with planned stories inside
the existing original/proposed revision snapshots. Ordinary generation does not
require these fields, and the original stored run/draft is not rewritten.

Before the first proposal, the server verifies the existing generation-owned flat/nested
link using its saved common fields and assigns deterministic, run-scoped story IDs.
After that bootstrap, context follows the ID across renames, content edits, reorders,
and subtree changes. Omitted context is retained; explicit context edits participate
in the existing change-explanation gate and appear in the original/proposed comparison.
Added stories require an explicit new-story marker, which the server converts to a
stable ID. Missing, duplicate, unknown, or ambiguous mappings fail instead of guessing.
Internal IDs are hidden in the readable comparison; all four context fields are shown.

Historic proposals without stable mapping must be rejected and recreated before
acceptance. Ambiguous historic accepted content retains the stored original stories
and reports the mapping problem; further refinement requires reconciliation. This is
an explicit safety limit, not a metadata backfill based on mutable titles.

### 2. Queue capacity after failed deletion

Deletion markers were excluded by claims but included in admission depth and oldest
queue statistics. Counts/statistics now use the same marker exclusion. Genuine queued
entries, including those with active processing leases, still consume capacity.
The existing deletion marker, active-lease conflict, cleanup order, and retry semantics
remain in place. The MongoDB read-filter contract explicitly permits `$exists` for
these repository-owned queries; there is no new dependency or collection.

### 3. Vault action layout

The row-wide sizing rule now targets only the open/title action. The delete action
has a 2.5rem fixed width and cannot shrink. Long titles wrap inside the remaining
space. Both actions retain accessible names, keyboard interaction, and scoped focus
indicators. A versioned browser regression checks actual desktop/mobile geometry,
long labels, keyboard confirmation/cancel, and the independent open action.

### Post-review validation

All three findings are **fixed**. Fourteen regression tests were added to the existing
default suites; existing tests/fixtures were adapted to the prepared identity/context
contract without removing their original acceptance, rejection, or stale-version checks.

Executed commands and actual final results:

```text
corepack pnpm --dir servers/api exec tsx --test features/story-agent/tests/story-agent.metadata.test.ts features/story-agent/tests/story-agent.deletion-capacity.test.ts features/story-agent/tests/story-agent.phase1.test.ts features/story-agent/tests/story-agent.phase1.route.test.ts
PASS: 24 tests, 0 failures

corepack pnpm --dir apps/web exec tsx --test tests/story-agent-ui.test.ts
PASS: 9 tests, 0 failures

node apps/web/tests/browser/story-agent-vault.mjs http://127.0.0.1:3111 http://127.0.0.1:9333
PASS: 13 actual-browser assertions; long labels and keyboard controls at 1440px/390px

corepack pnpm run validate
PASS: exit 0; syntax (55 modules), architecture, all lint/type checks, all 218 tests,
      production builds (types/API/web fresh; unchanged logging/UI cached)

node codebase/cli/repo.mjs scan --json
PASS: exit 0; dependency audit 0 findings; TruffleHog 3.97.5 clean, 0 findings

git diff --check
PASS: exit 0
```

Full default-suite counts: control plane 86, API 113, web 13, shared UI 3, logging 3;
**218 tests total**, all passed. Browser assertions are separate from this test count.
Focused API coverage includes title/content edits, repeated accepted revisions,
subtree reorder and explicit story addition/removal, ambiguous/missing/duplicate IDs,
metadata explanations/snapshots, reject/stale-version handling, queue admission after
20 failed deletion markers, normal worker claims, active leases, genuine full queues,
and isolated cleanup retry. Web coverage parses and renders original/proposed context
and verifies internal IDs are hidden. Browser checks observed 40px delete controls and
668px/302px open actions at desktop/mobile widths with no horizontal overflow.

The opt-in browser regression requires a loopback preview with the isolated
`Reading brief one` fixture and a local Chrome/Edge DevTools endpoint; it is not part
of the default `pnpm test` command. The actual verification used the existing cached
fake-provider/fake-persistence API fixture, an isolated headless Edge profile, and
Webpack dev mode after the local Turbopack watcher stalled. No repository bundler
configuration was changed. The ordinary production Turbopack build passed. Early
browser harness navigation/keyboard setup and test-filter logging issues were fixed
before the final successful runs. All temporary preview/API/browser processes stopped.

Evidence: `.repo-cache/post-review-focused-api.txt`, `post-review-focused-web.txt`,
`post-review-vault-browser.txt`, `post-review-api-lint.txt`, `post-review-web-lint.txt`,
`post-review-types.json`, `post-review-validate.txt`, and `post-review-scan.json`.
These local outputs are ignored and are not commit candidates.

No live-provider or Atlas smoke was run. Ambiguous historic mapping and pre-identity
pending proposals retain the explicit reconciliation/recreation limits above. No
remaining unresolved finding among the three authorized bug fixes.

### Exact files changed by this post-review pass

The prior Phase 1 work is retained. This pass modifies 21 of its existing files and
adds 4 files (25 touched files), solely for the three fixes, tests, and this record:

- `.project/story-agent/08-phase-1-quality-history.md`
- `apps/web/app/globals.css`
- `apps/web/features/story-agent/components/quality-review.tsx`
- `apps/web/features/story-agent/components/story-forge.tsx`
- `apps/web/features/story-agent/story-agent.client.ts`
- `apps/web/features/story-agent/story-agent.types.ts`
- `apps/web/tests/story-agent-ui.test.ts`
- `apps/web/tests/browser/story-agent-vault.mjs` (new)
- `packages/types/src/api/index.ts`
- `packages/types/src/api/story-agent/index.ts`
- `packages/types/src/api/story-agent/story-agent.ts`
- `packages/types/src/index.ts`
- `servers/api/features/story-agent/story-agent.controller.ts`
- `servers/api/features/story-agent/story-agent.metadata.ts` (new)
- `servers/api/features/story-agent/story-agent.refinement.ts`
- `servers/api/features/story-agent/story-agent.repository.ts`
- `servers/api/features/story-agent/story-agent.service.ts`
- `servers/api/features/story-agent/story-agent.validation.ts`
- `servers/api/features/story-agent/tests/story-agent.deletion-capacity.test.ts` (new)
- `servers/api/features/story-agent/tests/story-agent.metadata.test.ts` (new)
- `servers/api/features/story-agent/tests/story-agent.phase1.route.test.ts`
- `servers/api/features/story-agent/tests/story-agent.phase1.test.ts`
- `servers/api/integrations/mongodb/connection.ts`
- `servers/api/integrations/mongodb/types.ts`
- `servers/api/tests/mongodb.test.ts`

Combined final working tree: 39 changed files (26 modified tracked files, 13 new files).
Index empty; branch `feat/story-agent-quality-refinement` preserved. No staging, commit,
push, merge, deployment, Phase 2, external dependency, environment, generated-source,
foundation/control-plane change, or unrelated refactor was introduced by this pass.

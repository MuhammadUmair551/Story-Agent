# Project rules and backlog intelligence

## Baseline and boundaries

Phase 1 feature commit: `c7b12f9133c1d7ee46853fa404f0bab997fd3576`.
Normal merge on main: `329913c6da1192894a0d7c3c7793063f06fb5c49`.
Merged-main `pnpm run validate` passed all 218 tests, lint/typechecks, repository/security
checks and production builds. Main and origin/main were verified synchronized before
creating `feat/story-agent-rules-impact-analysis`. The Phase 1 branch is retained.

Audit: the application has generation, clarification/repair, hierarchy validation,
quality feedback, versioned refinement, run/draft history and a MongoDB adapter.
It has no application project model or semantic backlog analysis. Existing title
deduplication only protects generation against supplied titles. The repository control
plane's workspace projects are build units, not application projects, and are untouched.

Scope is application behavior, shared API contracts and project knowledge. No new
authentication, external integration, dependency, foundation or control-plane change.

## Milestone 1: project rules

Introduce feature-owned projects using the existing persistence adapter. Store glossary,
role definitions, per-level naming conventions, acceptance format/examples and ordered,
grouped, enabled/disabled rules. Validate ambiguous terms, duplicate keys/levels and
an 8,000-character configuration budget. Optimistic project updates retain snapshots.
The management UI uses existing shared shadcn primitives. Rules can be created, edited,
removed and reordered before saving. Runs retain their selected project's rules snapshot
for reproducible generation, queued retries and later refinement. Existing unscoped
generation remains supported. Output conventions are advisory in the existing Quality
Gate, while the existing structural checks remain blocking.

Review gate: deterministic schema/repository tests, real HTTP project/generation tests,
web client/control integration tests, lint and strict TypeScript.

## Milestone 2: duplicate and conflict review

Compare the effective saved hierarchy with existing artifacts in the same application
project. Reuse the provider router and generation budgets for semantic review. Keep
deterministic evidence distinct from provider findings. Validate every referenced
artifact/dependency, bound comparison context, and preserve review records. Findings
describe duplicate behavior, contradictory requirements and inconsistent terminology,
with evidence, reasons and concrete suggested updates. Analysis must not silently
modify a plan or unrelated entry.

Review gate: duplicate/conflict/terminology examples, invalid provider output and
reference handling, project isolation, context limits and HTTP/UI regressions.

## Milestone 3: requirement change impact

Compare saved original and explicitly updated requirements. Identify affected, stale,
contradictory or incomplete hierarchy artifacts and relevant dependencies. Show reasons,
the requirement comparison and concrete updates. Prepare proposals through Phase 1's
refinement gate; preserve original content, reject/stale-version behavior and explicit
acceptance. Requirement revisions must follow the same decision/history boundary.

Review gate: requirement comparison at all five hierarchy levels, dependency evidence,
proposal/reject/accept/restore history, stale-analysis guards and full repository validation.

## Validation repairs (2026-11-09)

The complete prior validation log had seven legacy route failures and one web test
failure. The seven route failures came from creating persistence repositories inside
the route factory, bypassing its injected dependencies. Feature composition now creates
the project and intelligence repositories once, passes both through route dependencies,
and reuses the project repository for index setup. Legacy route tests retain their
throwing Mongo stub and original response/persistence/rate-limit assertions. Additional
regressions prove repository reuse and project routing through injected dependencies.

The web disabled-state test matched the word "disabled" inside shared Button CSS classes.
It now inspects the actual disabled attribute. The browser journey additionally checks
the real DOM disabled property for current, rejected and accepted review versions.

The old contextTokenLimit remains the retrieval budget. A separate maxPromptCharacters
budget (24,000 by default, explicitly set in production composition) limits the complete
assembled provider request. The common request boundary covers clarification, generation,
repair, refinement snapshots/quality findings, and intelligence correction instructions.
An oversized stage never calls the provider; earlier successful stages may already have
consumed their normal budget. Existing call, token-usage and elapsed-time limits remain.
Boundary regressions verify exact-limit success and one-character-over rejection without
changing the original generation tests or reducing TypeScript/security strictness.

Comparison choices now display saved titles and retain stable run IDs. They exclude the
source entry, other projects, unavailable drafts and deletion markers, keep duplicate
titles distinct, and cap selection at 25. Choices load from the existing history API
(up to 100 recent entries). Explicit selection is separate from automatic project scope:
an empty or emptied explicit selection stays source-only instead of widening to all
project drafts. Existing history queries still default to 20 entries.

One new composition-test fixture initially lacked required runtime environment values;
it now supplies isolated test values and restores them after the test. Full lint then
caught dynamic-property deletion in that restoration; compliant property cleanup fixed
it without disabling the lint rule. The first browser readiness wait was shorter than
cold startup; the final browser run completed after readiness with no application error.

The preview-generated next-env.d.ts path changes were removed. Production build leaves
that tracked file identical to HEAD. No environment file, dependency, lockfile,
foundation/control-plane or security-policy change was needed.

## Final validation (2026-11-09)

- PASS: corepack pnpm run validate, exit 0, repository-pinned pnpm 11.19.0.
- PASS: syntax check of 55 module files and repository architecture/security checks.
- PASS: all five workspace lint tasks and all five strict typecheck tasks.
- PASS: 249 default-suite tests, zero failures/skips/cancellations:
  control plane 86, API 135, web 22, shared UI 3, logging 3.
- PASS: production types/API/web builds; unchanged logging/UI builds reused valid cache.
  Standard Next.js Turbopack compilation, TypeScript and static generation completed.
- PASS: focused API suite 56/56 and focused web suite 18/18. These overlap the default
  suite and are not additional tests in the 249 count.
- PASS: 32 separate actual-browser assertions against isolated fake-provider/persistence
  fixtures: rule CRUD/reordering and validation, generation binding, equal-title stable-ID
  selection, exact comparison scope, explicit empty selection, real disabled-state checks,
  backlog review, impact comparison, reject/accept/restore, entry isolation and desktop/
  mobile overflow checks. No browser JavaScript exceptions. The local preview used
  Webpack dev mode; the ordinary production Turbopack build passed independently.
- PASS: node codebase/cli/repo.mjs scan --json, exit 0:
  pnpm dependency audit zero findings; pinned TruffleHog 3.97.5 clean, zero findings.
- PASS: git diff --check plus Git whitespace checks for every untracked source file.
- Temporary test API, preview and isolated browser processes were stopped.

Evidence (ignored local outputs):

- .repo-cache/phase23-validate.txt (original eight failures)
- .repo-cache/phase23-fix-validate-attempt1.txt (fixture lint failure)
- .repo-cache/phase23-fix-validate.txt (final full validation, exit 0)
- .repo-cache/phase23-fix-scan.json
- .repo-cache/phase23-fix-api-focused.txt
- .repo-cache/phase23-fix-web-focused.txt
- .repo-cache/phase23-fix-browser.txt
- .repo-cache/phase23-fix-final-files.json

No live-provider or live MongoDB/Atlas smoke was run. Semantic findings remain advisory:
valid paths/quotes do not prove semantic correctness. Comparison evidence is scoped to
the selected run and its eligible comparison entries; other entries are not overwritten.
The character cap is not a model-specific tokenizer; reported usage still enforces the
existing token budget. Project/rule and analysis history limits remain deliberate.

## Final Git state

Branch: feat/story-agent-rules-impact-analysis.
HEAD remains 329913c6da1192894a0d7c3c7793063f06fb5c49.
40 combined Phase 2/3 changed files: 21 modified tracked files and 19 untracked files.
Index empty. Phase 1 and existing Phase 2/3 work retained. Nothing staged, committed,
pushed, merged or deployed during this validation-repair task.

## Complete combined changed-file list

These paths are relative to the repository root:

- .project/story-agent/09-rules-backlog-intelligence.md
- apps/web/app/globals.css
- apps/web/features/story-agent/components/intelligence-review.tsx
- apps/web/features/story-agent/components/project-rules.tsx
- apps/web/features/story-agent/components/quality-review.tsx
- apps/web/features/story-agent/components/story-forge.tsx
- apps/web/features/story-agent/story-agent.client.ts
- apps/web/features/story-agent/story-agent.comparisons.ts
- apps/web/features/story-agent/story-agent.intelligence.ts
- apps/web/features/story-agent/story-agent.projects.ts
- apps/web/features/story-agent/story-agent.types.ts
- apps/web/package.json
- apps/web/tests/story-agent-intelligence.test.tsx
- apps/web/tests/story-agent-projects.test.tsx
- packages/types/src/api/index.ts
- packages/types/src/api/story-agent/index.ts
- packages/types/src/api/story-agent/story-agent.intelligence.ts
- packages/types/src/api/story-agent/story-agent.projects.ts
- packages/types/src/api/story-agent/story-agent.ts
- packages/types/src/index.ts
- servers/api/features/story-agent/index.ts
- servers/api/features/story-agent/routes/story-agent.route.ts
- servers/api/features/story-agent/story-agent.controller.ts
- servers/api/features/story-agent/story-agent.intelligence.controller.ts
- servers/api/features/story-agent/story-agent.intelligence.repository.ts
- servers/api/features/story-agent/story-agent.intelligence.ts
- servers/api/features/story-agent/story-agent.projects.controller.ts
- servers/api/features/story-agent/story-agent.projects.repository.ts
- servers/api/features/story-agent/story-agent.projects.ts
- servers/api/features/story-agent/story-agent.quality.ts
- servers/api/features/story-agent/story-agent.queue.ts
- servers/api/features/story-agent/story-agent.refinement.ts
- servers/api/features/story-agent/story-agent.repository.ts
- servers/api/features/story-agent/story-agent.service.ts
- servers/api/features/story-agent/story-agent.validation.ts
- servers/api/features/story-agent/tests/story-agent.http-fixture.ts
- servers/api/features/story-agent/tests/story-agent.intelligence.test.ts
- servers/api/features/story-agent/tests/story-agent.phase1.route.test.ts
- servers/api/features/story-agent/tests/story-agent.projects.test.ts
- servers/api/features/story-agent/tests/story-agent.route.test.ts

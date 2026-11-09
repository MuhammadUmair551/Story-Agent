# Phase 4: evidence-based backlog intelligence

Baseline: main `71f929b08ce50d9e623000c8307412e859d8bee9`. Scope is application
behavior, shared API contracts, tests and project knowledge. No new dependency,
authentication, foundation/control-plane change, commit, push or deployment.

## Ownership and compatibility

The existing Story Agent intelligence service, provider router, budgets, persistence
adapter and web client remain the implementation boundary. The flat feature-owned
`story-agent.evidence.ts` contains pure catalogue/evidence functions;
`story-agent.findings.controller.ts` handles finding decisions, comparison pages and
freshness presentation. Shared optional fields extend the existing intelligence
contracts in `packages/types`; web parsing accepts both historical and new reports.
The UI composes existing shared Select, Button, Checkbox and Textarea primitives.

`POST /story-agent/runs/:id/analyses` accepts `evidenceVersion: 2` for backlog reviews.
The web backlog action uses this contract. Existing requests without that flag and
Requirement Impact Analysis retain their existing provider/validation contract.
Generation, Quality Gate checks, rule snapshots, refinement proposals and explicit
accept/reject/history behavior remain in their existing modules.

## Evidence and detection

The catalogue enumerates Initiative, Epic, Feature, User Story and Task, with exact
scalar fields owned by each node and server-derived hierarchy breadcrumbs. Child
fields cannot be cited as parent evidence. Reports store exact field paths, field
values, verified quote offsets, counterpart references and evidence fingerprints.
Terminology findings may cite the saved glossary definition as their counterpart.

Semantic duplicate/contradiction findings require quotes from distinct artifacts;
duplicates compare artifacts at the same level, while contradictions may span
parents and children. Provider instructions distinguish actors, conditions, negation,
numeric constraints, legitimate elaboration and approved aliases. Deterministic
title candidates additionally require matching owned content, requirements and parent
context. Unicode title normalization never erases numeric operators in body context.
Reversed duplicate pairs collapse; semantic evidence takes precedence over an
equivalent title candidate. All findings remain advisory and require human review.

## Review decisions and freshness

`POST /story-agent/runs/:id/analyses/:analysisId/findings/:findingId/decision`
accepts confirm, dismiss with a nonempty reason, and reopen. The request includes
the analysis reviewVersion. Decisions and their history are persisted without
changing the content/refinement version or the active plan. A separate run-level
intelligenceReviewVersion guards concurrent review/analysis writes. Evidence-linked
refinement writes also check that revision, including acceptance after a review.
Dismissed or missing findings cannot be applied. Confirming a finding does not
invalidate an existing pending proposal.

The source and compared snapshots are rechecked before decisions and proposals.
GET run details adds server-computed freshness to new reports. Fingerprints bind
participants, owned content, ancestor context, requirements and saved rules. A
decision carries to a subsequent analysis only when that evidence fingerprint
matches; content/rule changes require review again. Historical reports stay visible.

## Scope, pagination and coverage

`GET /story-agent/runs/:id/comparisons?limit=100&skip=...` pages available drafts in
the source entry's project, excluding the source and deletion markers. Unscoped
entries compare only with other unscoped entries. Ordering uses createdAt then
runId. The Mongo read-filter type now exposes the existing adapter's standard $ne
operator for this exclusion; no database implementation or new integration is added.
The chooser loads additional pages, retains valid older selections on refresh,
deduplicates page overlap and preserves explicit empty scope. Existing history API
defaults remain unchanged.

Reports record the selected entries, total/acknowledged artifacts, excluded artifacts
and partial/truncation reasons. Coverage means provider-reported review of the selected
scope, never proof of semantic completeness or a clean whole project. Failed provider
or evidence validation saves no report. The UI shows coverage, level/type/status filters,
side-by-side highlighted fields, counterparts and reversible finding decisions.

Existing budgets remain: 25 comparison entries, 24,000 prompt characters, 12,000
reported tokens, 60 seconds and at most two analysis attempts within the shared call
budget. Additional guards cap catalogues at 600 artifacts, reports at 50 findings,
history at 20 analyses and each finding at 20 decisions. Evidence storage is bounded
to 512,000 JSON UTF-8 bytes per new report and 4,000,000 bytes across stored analyses.
Partial reports and limit errors are explicit; nothing silently expands scope.

## Regression and browser verification

Default API tests cover all five levels for semantic duplicate/contradiction/terminology
contracts and negative cases for repeated names, approved aliases, actors, conditions
and numeric constraints. Additional cases cover exact ownership, glossary quotes,
reversed pairs, parent-child conflicts, coverage, provider budgets/failures, history,
concurrent writers, project isolation, pagination beyond 100 and decision limits.
Web tests cover legacy/new parsing, filters, evidence presentation and client contracts.

The committed browser journey uses an isolated in-memory/fake-provider API fixture:

```text
corepack pnpm --dir servers/api exec tsx features/story-agent/tests/story-agent.evidence.browser-fixture.ts
# Build web with NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4214, then serve on 127.0.0.1:3114.
# Start a dedicated headless browser with its debugging endpoint on loopback port 9334.
node apps/web/tests/browser/story-agent-evidence.mjs http://127.0.0.1:3114 http://127.0.0.1:9334
```

The journey verifies older comparison selection, filters, persisted confirm/dismiss/reopen,
unchanged-evidence decision retention, refinement acceptance, changed-evidence freshness,
provider failure, partial coverage and desktop/mobile layout. Full validation remains
`corepack pnpm run validate` with the repository-pinned pnpm 11.19.0.

## Limits

Exact quote/reference validation does not prove a model's semantic reasoning. Fake-provider
regressions verify contracts and safeguards, not live-model precision/recall. No live
provider or MongoDB/Atlas evaluation is implied. Cross-entry freshness checks occur at
request boundaries; the existing adapter does not provide a cross-document transaction.
Offset pages are not a frozen database snapshot; selected entries are revalidated before
analysis and modification. Scope, budget and history limits remain deliberate.

## Verification and changed files

The isolated browser journey passed 30 assertions, including actual keyboard confirmation,
decision persistence and refinement acceptance, with no JavaScript exceptions or desktop/mobile
overflow. Screenshots were inspected at 1440px and 390px. An initial browser assertion observed
the previous rendered report immediately after persistence; the journey now waits for the
new report to render. The recorded API report already contained the correct partial coverage.
The first full-validation attempt caught redundant test narrowing checks; those were corrected
without disabling lint. Final full-validation output is recorded locally in
`.repo-cache/phase4-final-validate.txt`; browser output is `.repo-cache/phase4-browser-test.txt`.
These local outputs and the dedicated browser profile are ignored artifacts.

Changed files, relative to the repository root:

- .project/story-agent/10-evidence-backlog-intelligence.md
- apps/web/app/globals.css
- apps/web/features/story-agent/components/intelligence-findings.tsx
- apps/web/features/story-agent/components/intelligence-review.tsx
- apps/web/features/story-agent/story-agent.client.ts
- apps/web/features/story-agent/story-agent.intelligence.ts
- apps/web/package.json
- apps/web/tests/browser/story-agent-evidence.mjs
- apps/web/tests/story-agent-evidence.test.tsx
- packages/types/src/api/story-agent/story-agent.intelligence.ts
- packages/types/src/api/story-agent/story-agent.ts
- servers/api/features/story-agent/routes/story-agent.route.ts
- servers/api/features/story-agent/story-agent.controller.ts
- servers/api/features/story-agent/story-agent.evidence.ts
- servers/api/features/story-agent/story-agent.findings.controller.ts
- servers/api/features/story-agent/story-agent.intelligence.controller.ts
- servers/api/features/story-agent/story-agent.intelligence.repository.ts
- servers/api/features/story-agent/story-agent.intelligence.ts
- servers/api/features/story-agent/story-agent.repository.ts
- servers/api/features/story-agent/story-agent.service.ts
- servers/api/features/story-agent/tests/story-agent.evidence.browser-fixture.ts
- servers/api/features/story-agent/tests/story-agent.evidence.test.ts
- servers/api/features/story-agent/tests/story-agent.memory.ts
- servers/api/integrations/mongodb/types.ts

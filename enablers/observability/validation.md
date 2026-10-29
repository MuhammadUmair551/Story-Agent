# Observability validation — 2026-10-29

Branch: `feat/story-agent-production-observability`. Existing work was preserved.
No accounts, credentials, deployment, commit, merge, or push were performed.

## Dependency recovery

The sandbox Corepack request failed with `getaddrinfo ENOTFOUND registry.npmjs.org`.
Approved network access succeeded but the default Corepack cache rename failed with
`EXDEV`. Setting `COREPACK_HOME` to `.repo-cache/corepack` resolved that failure.
`corepack pnpm --version` returned the repository pin, **11.19.0**.

`corepack pnpm install --no-frozen-lockfile` generated the lockfile without manual edits.
The default install returned `ERR_PNPM_IGNORED_BUILDS` for `protobufjs`; the resulting
temporary approval placeholder was removed from `pnpm-workspace.yaml`.
`corepack pnpm install --frozen-lockfile --ignore-scripts` was the earlier temporary
workaround. It is no longer required: the reviewed optional protobufjs version-warning
postinstall is explicitly denied with `allowBuilds.protobufjs: false`. Normal
`corepack pnpm install --frozen-lockfile` now passes, including owned prepare builds.
The architecture's allowed dependency-build list is unchanged.

On this Windows host, validation uses the same approved filesystem access as installation
and the local Corepack cache. The old ignored PATH shim was removed. Final root checks
use the normal PATH (including the conflicting global pnpm) without disabling dependency
verification or package-manager version guards. No alternative pnpm version or lockfile
generator was used.

## Demonstrated tooling root causes and fixes

- Under the API cwd, a nested bare `pnpm --version` resolved the global npm shim to
  **12.8.1** and failed `ERR_PNPM_BAD_PM_VERSION`; `corepack pnpm --version` returned
  **11.19.0**. The task runner inherited the lifecycle PATH and selected that conflicting
  global executable. Inherited Corepack state prevents that executable from silently
  switching versions. No workspace has a competing package-manager declaration.
- `codebase/tools/package-manager.mjs` locates Corepack from its environment, standard
  Node installation layouts, or its executable location. Structured workspace script
  tasks and audit commands invoke Corepack's pnpm entry with Node and literal argument
  arrays. Corepack resolves the root packageManager pin in the child's cwd. Missing
  Corepack fails explicitly. Root script delegation and prepare scripts also name
  Corepack, rather than resolving bare pnpm again. No personal paths are encoded.
- A post-fix call through `runToolCommand` in `servers/api` returned exit 0 and
  **11.19.0** while the conflicting global pnpm remained installed. Regression tests
  cover a competing shim, literal shell metacharacters, exit propagation, missing
  Corepack, retained shell quoting/compound-command behavior, and total task duration
  remaining independent of a tool's narrower duration field.
- `--trace-deprecation` located DEP0190 at `codebase/tools/command-runner.mjs`, where
  Windows pnpm audit used `spawn(command, args, {shell:true})`. Structured tools now use
  `shell:false`. Trusted repository task strings still use one shell command string
  when their operators or quoting require it; their behavior is preserved.
- shadcn 4.20.0 declares Zod `^3.24.1`, but a repository override forced unsupported
  Zod 4, causing `o.deepPartial is not a function`. Restoring Zod 3 was tested and rejected:
  audit exposed high advisory [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
  patched only in Zod 4.6.6 or later. Registry metadata verified that shadcn **4.22.0**
  supports Zod `^4.2.0` and Node `>=20.18.1`, compatible with the repository's Node floor.
  Its package and architecture pins were updated together. The general patched Zod
  **4.6.6** override remains; the obsolete shadcn-4.20-specific override was removed.
  Normal installation, `pnpm peers check`, CLI startup and audit now pass together.
- Telemetry subprocess tests previously applied one 30-second timeout to Node/tsx/SDK
  startup, generation and shutdown. Under shared Windows I/O, children were killed before
  imports completed. An isolated run measured SDK import at 13.5 seconds and subsequent
  generation/shutdown at about 40 ms; a focused test run also spent 19.9 seconds on the
  unreachable-exporter child including startup. Tests now allow 120 seconds for isolated
  process startup and independently assert dummy generation under 1 second and shutdown
  under 10 seconds. Production export/shutdown deadlines remain 5 seconds. All three
  focused telemetry cases passed, including incoming W3C parent trace propagation.

## Security advisory resolution

`corepack pnpm why systeminformation -r` identified the development-tool chain:
`packages/ui -> shadcn@4.20.0 -> @dotenvx/dotenvx@1.75.1 -> systeminformation` at the
initial audit. The CLI is now 4.22.0; its dotenvx dependency still uses the patched edge.
The parent declares `^5.22.11`. Registry metadata for `5.33.16` confirms Node `>=10.0.0`,
matching the previously resolved version's requirement.

The [reviewed advisory](https://github.com/advisories/GHSA-3f7j-7jwc-fxfj) affects
versions `<5.33.16`; `5.33.16` is patched. The
[upstream release](https://github.com/sebhildebrandt/systeminformation/releases/tag/v5.33.16)
and pinned-pnpm registry metadata verified its availability and artifact integrity.

`pnpm-workspace.yaml` now overrides only
`@dotenvx/dotenvx@1.75.1>systeminformation` to `5.33.16`, within the parent's declared
range. Pinned pnpm regenerated the lockfile with
`corepack pnpm install --lockfile-only`, followed by the successful
frozen install. The security fix changes only this dependency edge, its artifact and
snapshot, and the corresponding override. Existing observability lockfile changes remain.
No advisory exclusions or scan thresholds changed.

Post-fix `corepack pnpm audit --json` returned exit 0: high **0**, critical **0**.
Metadata still lists 3 low and 6 moderate issues below the repository's existing high
threshold. The normal scan and combined validation both pass.

## Latest results

| Command / verification | Result |
| --- | --- |
| `corepack pnpm install --lockfile-only` | PASS; pnpm 11.19.0 |
| `corepack pnpm install --frozen-lockfile` | PASS; exit 0; owned prepare builds run |
| `corepack pnpm peers check` | PASS; no peer dependency issues |
| `corepack pnpm run check` | PASS; exit 0; architecture and repository policy |
| `corepack pnpm run node:check` | PASS; exit 0; 54 modules |
| `corepack pnpm run lint` | PASS; exit 0; all five workspace tasks |
| `corepack pnpm run typecheck` | PASS; exit 0; all five workspace tasks |
| `corepack pnpm run test:control-plane` | PASS; exit 0; 86 tests |
| `corepack pnpm run test:units` | PASS; exit 0; API 89, web 8, UI 3, logging 3 (103 total) |
| `corepack pnpm test` | PASS; exit 0; 189 tests, no skips |
| `corepack pnpm run build` | PASS; exit 0; all five workspace builds rebuilt and passed |
| `corepack pnpm run scan` | PASS; exit 0; audit passes existing threshold; TruffleHog CLEAN |
| `corepack pnpm run validate` | PASS; exit 0; full CI entry point, 189 tests, no skips; all five build results cached after the successful fresh build |
| `node codebase/cli/repo.mjs validate --json` | PASS; exit 0; no issues; both security tools passed |
| `corepack pnpm audit --json` | PASS; exit 0; no high or critical vulnerabilities |
| `git diff --check` | PASS |
| Compiled API startup without OTLP credentials | PASS; health 200 on hosting `PORT`, host `0.0.0.0`, conflicting `API_PORT=1` |
| Story Agent capacity/controller concurrency tests | PASS; included in full API suite |
| Local mock OTLP collector | PASS; signal suffixes and percent-decoded auth header |
| No credentials / unreachable exporter | PASS; generation returns successfully and shutdown is bounded |
| `corepack pnpm --dir packages/ui exec shadcn --version` | PASS; 4.22.0 |
| `corepack pnpm run ui:add --help` | PASS; root delegation reaches the CLI without changing components |
| Grafana YAML/JSON parsing | PASS; six alert templates and fifteen dashboard panels |

Build validation used `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4000`; hosted builds must
use the actual API HTTPS origin. The production-type imports in `next-env.d.ts` were
present at the start of the latest audit, match Next.js production generation and were
preserved. Next dev regenerates its own development type imports when run.
Only `.env.example` changed; no private `.env` contents were added to the diff.
TruffleHog 3.97.5 finished with zero findings on the final implementation.

## Remaining blockers and limits

- No high/critical advisory remains under the existing scan policy. Lower-severity
  dependency findings remain in registry audit metadata.
- Upstream install deprecation notices remain for ESLint 9, Recharts 2,
  git-raw-commits 5 and deprecated OpenTelemetry compatibility packages. They were
  inspected; replacing those stacks is outside this bug fix. No peer warning is hidden.
- Real Grafana delivery, account permissions, dashboard/alert import, notifications,
  real provider traffic, Atlas access and hosted Render/Vercel builds remain unverified.
- One Render Web Service can run API and queue for a demo. Free-service sleep pauses
  its process-local poller. Queue stop cancels future polling but does not drain an
  in-flight background run; interrupted work depends on Mongo lease recovery.
- Direct Loki log shipping remains held by the earlier automatic review. No public
  telemetry scrape endpoint or hardcoded external collector was added.

Exact hosting values and build plans are recorded in [the deployment guide](README.md).

## Review corrections

Queue statistics failures no longer prevent processing queued work, covered by a new
regression test. Queue age remains a sampled snapshot instead of being reset to zero on
every claim. Queue failure logs use a fixed reason code. Provider decisions count actual
fallback attempts and classify retryable failures accurately. Failed spans set ERROR
status without exporting exception messages. Grafana templates include query ranges and
reference IDs, and the inactive Loki panel matches the local log service label `api`.
Cloud alert setup now explicitly uses the UI; filesystem provisioning is only for an
operator-managed Grafana instance. No hosted Grafana ingestion or deployment was tested.

HTTP spans extract validated W3C trace context without accepting baggage. Local collector
tests confirm the parent trace is preserved. Logs omit invalid no-op span IDs when export
is disabled. Existing request ID validation and query-string omission remain covered.

## Diff ownership and repository state

- Control-plane changes are limited to shared package-manager invocation, safe tool
  execution, task timing normalization, registry delegation policy and regression tests.
- Root/package prepare scripts, the shadcn architecture/package pin, dependency policy
  and pnpm-generated lockfile agree. Application Zod remains 4.6.6; no Zod 3 remains.
- Existing web request-ID changes belong to API correlation. The generated production
  type imports in `apps/web/next-env.d.ts` were present at task start and preserved.
- API/bootstrap/feature/logging changes remain owned by their existing workspace units;
  Grafana configuration and this audit record remain under the operational enabler.
- `.project` changes document the actual runtime, queue limitations, Corepack boundary
  and updated CLI pin. No unrelated application feature or deployment infrastructure was added.
- No private environment files changed, no credentials/personal paths were added, and
  no unexplained temporary artifact remains in the changed-file list.
- HEAD remains `ccbea08c1d7e6e52be71753ba3c38275b5146f25`; the branch has no configured
  upstream. No branch switch, commit, push, merge, rebase or deployment occurred.

Final root validation ran with deprecation tracing enabled and found no DEP0190 or
ERR_PNPM_BAD_PM_VERSION. The separate test commands and the full CI validation all
completed successfully after the fixes. **Merge verdict: READY TO MERGE**, following
human review and explicit authorization for Git actions. Hosted service checks remain a
later deployment phase.

The branch is ready for final human review with standard validation gates passing.
The operational limitations above remain review items;
no merge, commit, push, or deployment has been performed.

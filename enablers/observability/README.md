# Story Agent production observability

Operational dashboards, alerts, and deployment guidance belong here. Reusable structured
logging remains in `@workspace/logging`; API spans and metrics remain with their API and
Story Agent owners. No `servers/api/observability/` segment is created.

See [the validation record](validation.md) for verified commands and remaining blockers.

## Findings and decision

- `servers/api/server.ts` starts an Express listener and starts a `setInterval` queue
  worker in that same process. MongoDB persists queued work, but it is not independently
  consumed while the API process sleeps or stops.
- Admission and request limits are in-memory and per API process. Operate one API instance
  until a separately reviewed distributed-capacity/worker design exists.
- The web workspace is `apps/web`, and the API is `servers/api`. The frontend can deploy
  on Vercel; the API should remain a persistent Node process.
- Logging was Pino plus Morgan-formatted request strings, without request correlation.
  There were no metrics, trace exporters, dashboards, or alert rules. The health endpoint
  reports service/environment only. Tests use fake providers and do not prove production
  availability or capacity.
- No deployment, CI result, Grafana account, Mongo connection, or live provider result
  was available in this environment.

The selected path is optional OpenTelemetry OTLP/HTTP traces and metrics plus structured
Pino stdout logs. A Grafana Cloud Free stack is the documented hosted target; Vercel's
built-in Observability is useful for the frontend, but does not provide a permanent queue
worker. Vercel documents `@vercel/otel`; this API uses the standard Node SDK because it is
Express and must also run on a persistent VM. Its entry point initializes the SDK before
loading application code. Only explicitly configured signals are enabled. Automatic
instrumentation is disabled to avoid exporting raw URLs, database commands, or exception
messages; request, pipeline, provider and persistence spans use application field allowlists.
Self-hosted Prometheus/Grafana is not needed.

The current Grafana Cloud Free plan is listed as 10,000 metrics, 50 GB each for logs and
traces, three users, and 14-day retention. Verify current usage and terms in the account
before exporting production traffic. See [Grafana pricing](https://grafana.com/pricing/).

Direct application log forwarding to Loki was rejected by the automatic review because
request/error content could include sensitive data. That path is not implemented. Local
terminal logs and hosting-provider stdout remain available; any Grafana log drain requires
a separately reviewed field allowlist, redaction, retention, and destination.

## Dashboard and alert guides

Import [the overview dashboard](grafana/dashboards/story-agent-overview.json). Set the
Prometheus-compatible datasource UID to `prometheus` and Loki datasource UID to `loki`, or
edit those UID references in the dashboard JSON and alert rule file to match the UIDs in
your Grafana stack. The panels
show route rate and p95, 5xx ratio, generation outcomes/duration, provider outcomes,
queue depth/age/processing, active runs, and runtime measurements. The Loki panel is
prepared but has no data until an approved log pipeline is configured.

Use [the alert rules](grafana/alerts.yaml) as templates only after confirming the metrics
exist in Grafana Explore. Grafana Cloud does not support filesystem provisioning: create
the equivalent rules in its alerting UI using these queries, thresholds and durations.
The YAML provisioning file is for an operator-managed Grafana instance. See
[Grafana's provisioning documentation](https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/file-provisioning/).
The rules cover sustained 5xx ratio, p95 latency, oldest queue age, and the
default two active run slots. If `STORY_AGENT_MAX_CONCURRENT_RUNS` differs from `2`, tune
the capacity rule. Configure a notification contact point and tune the traffic minimum
and thresholds after observing real traffic; no alert delivery was tested here.

How to investigate: start from a route's error/latency panel, open a trace using the
returned request ID or trace ID, follow the Express/generation/provider/Mongo spans, then
search the host's structured stdout logs using `requestId` or `traceId`. Provider and
queue logs deliberately omit prompts, contexts, and generated content.

## Free-first deployment

1. **Frontend:** Vercel Hobby for personal/non-commercial use. Import the monorepo and set
   project root to `apps/web`; pnpm's root workspace remains `pnpm-workspace.yaml`. Set
   `NEXT_PUBLIC_API_BASE_URL` to the API HTTPS URL. See [Vercel monorepos](https://vercel.com/docs/monorepos).
2. **API:** an Oracle Cloud Always Free VM can host the current persistent Express process
   under systemd/Docker Compose. Oracle currently publishes up to 2 OCPUs and 12 GB RAM
   equivalent for A1 Always Free, but home-region capacity can block VM creation. This is
   a best-effort hobby setup; a small always-on paid VM is more predictable for production.
   Secure and patch the host, terminate HTTPS, restart the service on failure, and run one
   API instance.
3. **Avoid serverless/sleeping API hosting:** Vercel Functions have request duration limits
   and scale to isolated instances; they cannot serve as a permanent poller. Render Free
   web services sleep after 15 minutes idle and can restart at any time, so the worker
   pauses. Render Free is fine for previews where delayed queued stories are acceptable.
4. **Database:** Atlas Free is okay for a small preview, not an availability guarantee.
   Its current limits include 0.5 GB storage and 100 operations/second; free clusters can
   pause after 30 days with no connections. Add the API host to network access and use a
   least-privilege database user. See [Atlas free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/).
5. **LLM:** store provider keys only on the API host. Free inference quotas and provider
   uptime are separate from hosting. Keep provider profiles and retry/circuit behavior.
6. **Telemetry:** set the API OTLP endpoint and headers from Grafana Cloud's OTLP setup.
   No metrics scrape endpoint is exposed. Without those settings, local console logging
   stays active and normal story generation does not depend on Grafana.

The API now uses the host's normal DNS resolver. It accepts the host-provided `PORT` as
the listening port in preference to `API_PORT`. Set `API_HOST=0.0.0.0` on Render.

### Render demo settings

Use one Node Web Service, branch `feat/story-agent-production-observability`, repository
root (leave Root Directory empty). Use Node 24 (`NODE_VERSION=24.14.1` matches local validation).
Build command:
`corepack pnpm install --frozen-lockfile && node codebase/cli/repo.mjs run api:build`.
Start command: `corepack pnpm --dir servers/api start`.
These invoke the existing control-plane build for API plus logging/types dependencies
and the API `node dist/server.js` script. Set `NODE_ENV=production`, `API_HOST=0.0.0.0`,
`LOG_LEVEL=info`, `WEB_ORIGIN=<frontend origin>`, `MONGODB_URI` and provider variables.
Let Render supply `PORT`; do not pin it to a local development value. Health check: `/health`.
API startup starts the queue interval after the listener starts, only when MongoDB is
configured. No separate worker command exists. Free-service sleep suspends processing;
queued work resumes on later polls after wakeup. Queue shutdown cancels future polls,
but does not await an already running background job. A killed job must await its Mongo
lease expiry before recovery. Keep one service instance for the process-local capacity gate.

### Vercel settings

Framework: Next.js. Root Directory: `apps/web`. Enable inclusion of source files outside
the Root Directory. Install command: `cd ../.. && corepack pnpm install --frozen-lockfile`.
Build command: `cd ../.. && node codebase/cli/repo.mjs run web:build`. Output Directory: framework default
(`.next`). These use the root `packageManager` pin and existing build graph, including
the compiled `@workspace/ui` exports used by Next.js. The control-plane build selects web and its UI dependency. Set `NEXT_PUBLIC_API_BASE_URL=<Render HTTPS origin>` before building.
No `vercel.json` is present. These are configuration values derived from repository scripts;
successful hosted builds still need verification after dependency reconciliation.

Use the Node 24.x runtime. OTLP common endpoints are base URLs: the HTTP exporters append
`/v1/traces` and `/v1/metrics`. Per-signal `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and
`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` are complete signal URLs, with corresponding
per-signal headers taking precedence over common headers. Header values use the SDK's
comma-separated `key=value` syntax with percent encoding (for example,
`Authorization=Basic%20<encoded-value>`). Use the private authenticated HTTPS endpoint
provided by your collector; do not place telemetry credentials in Vercel public variables.

## Manual setup steps

1. Create a Grafana Cloud Free account/stack. In Connections, open the OpenTelemetry
   setup and copy the OTLP/HTTP endpoint plus access-policy token. Keep the token private.
2. On the API host, set `OTEL_EXPORTER_OTLP_ENDPOINT=<OTLP endpoint>` and
   `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64(instance-id:token)>` (or paste
   Grafana's generated header exactly); set `OTEL_SERVICE_NAME=story-agent-api`. For
   local testing, place these only in the ignored API `.env`, never Git or chat.
3. Configure API secrets: `NODE_ENV=production`, `API_HOST=0.0.0.0`, `PORT=<host port>` (or `API_PORT`),
   `WEB_ORIGIN=<Vercel origin>`, `MONGODB_URI=<Atlas URI>`, and the required provider
   settings. Permit the API host in Atlas network access, then confirm `/health` returns
   200 and submit a harmless sample requirement.
4. Import the repository to Vercel with root directory `apps/web`; set
   `NEXT_PUBLIC_API_BASE_URL=<API HTTPS origin>`, deploy a preview, and test the UI/API.
5. In Grafana Explore, look for `http_server_request_count_total` and
   `story_agent_generation_count_total`; in the trace view, find service
   `story-agent-api` and inspect request to generation/provider/database spans. Actual
   arrival needs your account token and was not verified here.
6. Import the dashboard and create Cloud alerts from the rule templates, select the Grafana Prometheus-compatible source, configure
   alert notifications, and check Grafana's usage page/retention before increasing load.
7. Test correlation safely by requesting a nonexistent API path (no body or secrets),
   then find the generated `x-request-id` in API host logs. Logs are searchable in the
   hosting dashboard; Grafana Loki ingestion remains unconfigured pending a reviewed
   sanitized log route.

## Limits and known gaps

- Pinned pnpm 11.19.0 is invoked through Corepack for root lifecycle delegation and
  workspace tasks. Normal frozen installation runs owned prepare scripts. The optional
  protobufjs version-warning script is explicitly denied; the allowed dependency-build
  list remains esbuild and unrs-resolver. No PATH shim or version-guard bypass is required.
- Live OTLP delivery, dashboard/alert import and hosted deployment remain unverified.
- API exporter failure behavior is designed to be non-blocking during normal requests,
  but must be checked against a real collector before production reliance.
- Queue storage is durable, but the only worker and active concurrency gate are
  process-local. No distributed rate limit, public metrics endpoint, worker split, or
  multi-instance guarantee has been added.
- MongoDB operation metrics are application-owned. Automatic driver spans are disabled;
  manual persistence spans do not include query contents. No live span export was observed.
- Direct Grafana Loki log shipping was explicitly held by automatic review.

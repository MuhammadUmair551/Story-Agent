import test from "node:test";
import assert from "node:assert/strict";
import type { Logger, LogContext } from "@workspace/logging";
import { createApp, createServer } from "../bootstrap/index.js";
import { ERROR_CODES, ERROR_MESSAGES, HTTP_STATUS } from "../constants/index.js";
import type { ApiConfig } from "../types/index.js";
import type { MongoPersistence } from "../integrations/index.js";

const logEntries: Array<Readonly<{ message: string; context?: LogContext }>> = [];
const logger: Logger = {
  info: (message, context) => { logEntries.push({ message, ...(context ? { context } : {}) }); },
  warn: () => undefined,
  error: () => undefined
};
const config: ApiConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 0,
  webOrigin: "http://localhost:3000",
  logLevel: "silent",
  queueIntervalMs: 120_000,
  storyAgentMaxConcurrentRuns: 2,
  storyAgentMaxRequestsPerWindow: 6,
  storyAgentRequestWindowMs: 60_000,
  storyAgentMaxTrackedClients: 1_000
};
const persistence: MongoPersistence = { getCollection: () => { throw new Error("Persistence is not used by this test."); } };

void test("unknown routes use the API error boundary", async (context) => {
  const server = createServer({ app: createApp({ config, logger, persistence }), config, logger });
  await server.start();
  context.after(async () => { await server.stop(); });
  const address = server.raw.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${String(address.port)}/missing?secret=not-logged`);
  assert.equal(response.status, HTTP_STATUS.notFound);
  assert.deepEqual(await response.json(), {
    error: {
      code: ERROR_CODES.routeNotFound,
      message: ERROR_MESSAGES.routeNotFound,
      details: { method: "GET", path: "/missing" }
    }
  });
  assert.match(response.headers.get("x-request-id") ?? "", /^[\w-]{1,128}$/);
  const entry = logEntries.at(-1);
  assert.ok(entry?.context);
  assert.equal(entry.context.route, "unmatched");
  assert.equal(entry.context.requestId, response.headers.get("x-request-id"));
  assert.equal(entry.context.method, "GET");
  assert.equal(entry.context.statusCode, HTTP_STATUS.notFound);
  assert.equal(entry.context.traceId, undefined);
  assert.equal(entry.context.spanId, undefined);
  assert.doesNotMatch(JSON.stringify(entry), /missing|secret|not-logged/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
void test("OTLP HTTP appends signal paths and decodes authentication headers", async () => {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OTEL_") && key !== "NODE_OPTIONS"));
  const { stdout, stderr } = await execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { createServer } from 'node:http';
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { trace } from '@opentelemetry/api';
    const requests = [];
    const server = createServer((req, res) => {
      requests.push({ path: req.url, auth: req.headers.authorization });
      req.resume();
      req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end('{}'); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:' + server.address().port + '/otlp';
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer%20test-secret';
      const { shutdownTelemetry } = await import('./bootstrap/telemetry.ts');
      const { withStorySpan, recordGeneration } = await import('./features/story-agent/story-agent.telemetry.ts');
      const { createHttpTelemetry } = await import('./bootstrap/http-telemetry.ts');
      const traceId = '12345678901234567890123456789012';
      const response = new EventEmitter();
      response.statusCode = 200;
      let activeTraceId;
      createHttpTelemetry()({ headers: { traceparent: '00-' + traceId + '-1234567890123456-01' }, method: 'GET', baseUrl: '', route: { path: '/test' } }, response, () => {
        activeTraceId = trace.getActiveSpan().spanContext().traceId;
      });
      response.emit('finish');
      assert.equal(activeTraceId, traceId);
      await withStorySpan('test.export', {}, async () => 'draft');
      recordGeneration('draft', 1);
      await shutdownTelemetry();
      assert.ok(requests.some(r => r.path === '/otlp/v1/traces'));
      assert.ok(requests.some(r => r.path === '/otlp/v1/metrics'));
      assert.ok(requests.every(r => r.auth === 'Bearer test-secret'));
      console.log('export-ok');
    } finally { await new Promise(resolve => server.close(resolve)); }
  `], { cwd: process.cwd(), timeout: 120_000, env: { ...environment, DOTENV_CONFIG_PATH: 'tests/nonexistent.env' } });
  assert.match(stdout, /export-ok/);
  assert.doesNotMatch(stdout + stderr, /test-secret/);
});

for (const enabled of [false, true]) {
  void test(`generation succeeds with ${enabled ? "an unreachable exporter" : "no telemetry credentials"}`, async () => {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OTEL_") && key !== "NODE_OPTIONS"));
    const { stdout, stderr } = await execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      const { shutdownTelemetry } = await import('./bootstrap/telemetry.ts');
      const { withStorySpan, recordGeneration } = await import('./features/story-agent/story-agent.telemetry.ts');
      const operationStarted = Date.now();
      const result = await withStorySpan('test.generation', {}, async () => 'draft');
      recordGeneration(result, 1);
      if (result !== 'draft') throw new Error('generation changed');
      if (Date.now() - operationStarted > 1000) throw new Error('generation waited on telemetry export');
      const shutdownStarted = Date.now();
      await shutdownTelemetry().catch(() => {});
      if (Date.now() - shutdownStarted > 10000) throw new Error('telemetry shutdown exceeded its export deadline');
      console.log('generation-ok');
    `], {
      // Process/tsx/SDK cold startup is separate from the operation/export deadlines
      // asserted inside the child. Shared Windows I/O can exceed 30s before imports finish.
      cwd: process.cwd(), timeout: 120_000,
      env: { ...environment, DOTENV_CONFIG_PATH: 'tests/nonexistent.env',
        ...(enabled ? { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20test-secret' } : {}) }
    });
    assert.match(stdout, /generation-ok/);
    assert.doesNotMatch(stdout + stderr, /test-secret/);
  });
}

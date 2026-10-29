import { context, metrics, propagation, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { RequestHandler } from "express";

const meter = metrics.getMeter("story-agent-api.http");
const requestCount = meter.createCounter("http.server.request.count", { description: "Completed API requests." });
const requestDuration = meter.createHistogram("http.server.request.duration", { unit: "ms", description: "API request duration." });

export const createHttpTelemetry = (): RequestHandler => (request, response, next) => {
  // Extract W3C trace context only; do not accept arbitrary baggage into telemetry.
  const parent = propagation.extract(context.active(), { traceparent: request.headers.traceparent, tracestate: request.headers.tracestate });
  const span = trace.getTracer("story-agent-api.http").startSpan("HTTP request", { kind: SpanKind.SERVER }, parent);
  let ended = false;
  const endSpan = (): void => { if (!ended) { ended = true; span.end(); } };
  const startedAt = process.hrtime.bigint();
  response.once("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const matched = request.route as { path?: unknown } | undefined;
    const route = typeof matched?.path === "string" ? `${request.baseUrl}${matched.path}` : "unmatched";
    const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE"].includes(request.method) ? request.method : "OTHER";
    const attributes = {
      "http.route": route,
      "http.request.method": method,
      "http.response.status_code": response.statusCode,
      "http.response.status_class": `${String(Math.floor(response.statusCode / 100))}xx`
    };
    requestCount.add(1, attributes);
    requestDuration.record(durationMs, attributes);
    span.updateName(`${method} ${route}`);
    span.setAttributes(attributes);
    if (response.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    endSpan();
  });
  response.once("close", endSpan);
  context.with(trace.setSpan(context.active(), span), next);
};

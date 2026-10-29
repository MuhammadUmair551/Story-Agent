import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isSpanContextValid, trace } from "@opentelemetry/api";
import type { Logger } from "./types.js";

type RoutedRequest = IncomingMessage & Readonly<{
  baseUrl?: string;
  originalUrl?: string;
  route?: Readonly<{ path?: string | readonly string[] }>;
}>;
type Next = (error?: unknown) => void;
type HttpLoggerOptions = Readonly<{ logger: Logger; createRequestId?: () => string }>;

const safeRequestId = (value: string | undefined): string | undefined =>
  value !== undefined && /^[\w-]{1,128}$/.test(value) ? value : undefined;

const firstHeader = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === "string" ? value : value?.[0];

const isRoutePathList = (value: string | readonly string[] | undefined): value is readonly string[] =>
  value !== undefined && typeof value !== "string" && Array.isArray(value);

const routeTemplate = (request: RoutedRequest): string => {
  const path = request.route?.path;
  if (typeof path === "string") return `${request.baseUrl ?? ""}${path}`;
  if (isRoutePathList(path)) return `${request.baseUrl ?? ""}${path[0] ?? "unknown"}`;
  return "unmatched";
};

const traceIdFrom = (value: string | undefined): string | undefined => {
  const match = value?.match(/^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return isSpanContextValid({ traceId: match[1], spanId: match[2], traceFlags: Number.parseInt(match[3], 16) }) ? match[1] : undefined;
};

export const createHttpLogger = ({ logger, createRequestId = randomUUID }: HttpLoggerOptions) =>
  (request: RoutedRequest, response: ServerResponse, next: Next): void => {
    const requestId = safeRequestId(firstHeader(request.headers["x-request-id"])) ?? createRequestId();
    const traceId = traceIdFrom(firstHeader(request.headers.traceparent));
    const span = trace.getActiveSpan();
    span?.setAttribute("request.id", requestId);
    const spanContext = span?.spanContext();
    const activeTraceId = spanContext && isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
    const startedAt = process.hrtime.bigint();
    response.setHeader("x-request-id", requestId);
    response.once("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const route = routeTemplate(request);
      const statusCode = response.statusCode;
      const quietRequest = request.method === "OPTIONS"
        || (request.method === "GET" && (route === "/health" || route.startsWith("/story-agent/runs")));
      if (quietRequest && statusCode < 400 && durationMs < 1_000) return;
      logger.info("HTTP request completed", {
        requestId,
        ...(activeTraceId ? { traceId: activeTraceId } : traceId ? { traceId } : {}),
        ...(activeTraceId ? { spanId: spanContext?.spanId } : {}),
        route,
        method: request.method ?? "UNKNOWN",
        statusCode,
        statusClass: `${String(Math.floor(statusCode / 100))}xx`,
        durationMs
      });
    });
    next();
  };

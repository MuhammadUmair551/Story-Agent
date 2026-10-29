import "dotenv/config";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

process.env.OTEL_SERVICE_NAME ||= "story-agent-api";
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const tracesEnabled = Boolean(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || endpoint);
const metricsEnabled = Boolean(process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || endpoint);
// Never let SDK defaults create localhost trace/log exporters. Only explicitly
// configured signals are enabled; application spans contain an allowlist of fields.
const createTelemetry = (): NodeSDK | undefined => {
  try {
    return tracesEnabled || metricsEnabled ? new NodeSDK({
      ...(tracesEnabled ? {
        traceExporter: new OTLPTraceExporter({ timeoutMillis: 5_000 }),
      } : { spanProcessors: [] }),
      metricReaders: metricsEnabled ? [
        new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ timeoutMillis: 5_000 }), exportIntervalMillis: 15_000, exportTimeoutMillis: 5_000 })
      ] : [],
      logRecordProcessors: [],
      instrumentations: []
    }) : undefined;
  } catch {
    console.error("Telemetry configuration failed; continuing without export.");
    return undefined;
  }
};
const sdk = createTelemetry();

try { sdk?.start(); }
catch { console.error("Telemetry initialization failed; continuing without export."); }

export const shutdownTelemetry = async (): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sdk?.shutdown(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("Telemetry shutdown timed out.")); }, 5_000); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

import { createTelemetry, installTelemetry, type Telemetry } from '../core/telemetry';

/**
 * Starts telemetry when it is wanted: a metrics token (the /metrics endpoint is on) or an OTLP endpoint (traces are exported).
 * Returns null otherwise: every telemetry call in the code is then a no-op.
 */
export function setupTelemetry(
  env: {
    METRICS_TOKEN?: string | undefined;
    OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
    OTEL_TRACE_SAMPLE_RATIO: number;
  },
  serviceName: string,
): Telemetry | null {
  if (!env.METRICS_TOKEN && !env.OTEL_EXPORTER_OTLP_ENDPOINT) return null;
  const telemetry = createTelemetry({
    serviceName,
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    sampleRatio: env.OTEL_TRACE_SAMPLE_RATIO,
  });
  installTelemetry(telemetry);
  return telemetry;
}

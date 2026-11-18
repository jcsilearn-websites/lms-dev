import {
  type Attributes,
  type Context,
  type Counter,
  context,
  type Histogram,
  type Meter,
  type Span,
  SpanStatusCode,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  ParentBasedSampler,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanProcessor,
  TraceIdRatioBasedSampler,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { onLegacyTokenVerified } from './keyring';

// OBSERVABILITY (step 14a, docs/slo.md). One place that owns the OpenTelemetry SDK:
//  - tracing: HTTP request -> service call -> database transaction spans (`withSpan`), exported over OTLP/HTTP when
//    OTEL_EXPORTER_OTLP_ENDPOINT is set; tests read them from an in-memory exporter;
//  - metrics: counters / histograms (request latency by route, errors, job outcomes, breaker state, legacy token use) and
//    observable gauges (pool, queue depth, ...), rendered in the Prometheus text format for the protected /metrics endpoint.
// Nothing is registered globally (except the async-context manager, which is idempotent): `installTelemetry()` makes ONE instance
// current for the process, and without one every helper below is a no-op, so the hot paths cost one null check in development
// and in tests that do not look.

export interface Telemetry {
  readonly tracer: Tracer;
  readonly meter: Meter;
  /** the finished spans (only with `inMemorySpans`, tests) */
  getSpans(): ReadableSpan[];
  /** the metrics in the Prometheus text exposition format */
  renderMetrics(): Promise<string>;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface TelemetryOptions {
  serviceName: string;
  /** OTLP/HTTP base URL (e.g. http://collector:4318); absent = spans are recorded but not exported */
  otlpEndpoint?: string | undefined;
  /** keep finished spans in memory (tests) */
  inMemorySpans?: boolean;
  /** fraction of root traces sampled (children follow their parent), default 1 */
  sampleRatio?: number;
}

let contextManagerReady = false;

export function createTelemetry(opts: TelemetryOptions): Telemetry {
  if (!contextManagerReady) {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    contextManagerReady = true;
  }
  const resource = resourceFromAttributes({ 'service.name': opts.serviceName });
  const spanProcessors: SpanProcessor[] = [];
  const memory = opts.inMemorySpans ? new InMemorySpanExporter() : null;
  if (memory) spanProcessors.push(new SimpleSpanProcessor({ exporter: memory }));
  if (opts.otlpEndpoint) {
    spanProcessors.push(
      new BatchSpanProcessor({
        exporter: new OTLPTraceExporter({
          url: `${opts.otlpEndpoint.replace(/\/$/, '')}/v1/traces`,
        }),
      }),
    );
  }
  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(opts.sampleRatio ?? 1),
    }),
  });
  const reader = new PrometheusExporter({ preventServerStart: true });
  const meterProvider = new MeterProvider({ resource, readers: [reader] });
  const serializer = new PrometheusSerializer();

  return {
    tracer: tracerProvider.getTracer('lms'),
    meter: meterProvider.getMeter('lms'),
    getSpans: () => (memory ? memory.getFinishedSpans() : []),
    async renderMetrics() {
      const { resourceMetrics } = await reader.collect();
      return serializer.serialize(resourceMetrics);
    },
    async forceFlush() {
      await tracerProvider.forceFlush();
    },
    async shutdown() {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
    },
  };
}

// ---- the current instance --------------------------------------------------------------------------------------------
let current: Telemetry | null = null;
const instruments = new Map<string, Counter | Histogram>();

/** Makes `t` the process's telemetry (null removes it). Instruments are re-created on the next use. */
export function installTelemetry(t: Telemetry | null): void {
  current = t;
  instruments.clear();
  onLegacyTokenVerified(
    t ? (purpose) => counter('lms_legacy_token_verifications_total').add(1, { purpose }) : null,
  );
}

export function currentTelemetry(): Telemetry | null {
  return current;
}

const NOOP_COUNTER = { add: (_n: number, _a?: Attributes) => {} };
const NOOP_HISTOGRAM = { record: (_n: number, _a?: Attributes) => {} };

/** A counter of the current telemetry (no-op without one). `name` is the Prometheus name (`_total` suffix included). */
export function counter(
  name: string,
  description = '',
): { add(n: number, attrs?: Attributes): void } {
  const t = current;
  if (!t) return NOOP_COUNTER;
  let c = instruments.get(name) as Counter | undefined;
  if (!c) {
    c = t.meter.createCounter(name.replace(/_total$/, ''), { description });
    instruments.set(name, c);
  }
  return c;
}

/** A histogram of the current telemetry (no-op without one); values in `unit` (default seconds). */
export function histogram(
  name: string,
  description = '',
  boundaries?: number[],
): { record(v: number, attrs?: Attributes): void } {
  const t = current;
  if (!t) return NOOP_HISTOGRAM;
  let h = instruments.get(name) as Histogram | undefined;
  if (!h) {
    h = t.meter.createHistogram(name, {
      description,
      ...(boundaries ? { advice: { explicitBucketBoundaries: boundaries } } : {}),
    });
    instruments.set(name, h);
  }
  return h;
}

/** Latency buckets in seconds. */
export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// ---- spans --------------------------------------------------------------------------------------------------------------

/**
 * Runs `fn` inside a child span of the active one (a root span when none is active). Records exceptions and the error status;
 * without telemetry it just calls `fn`. Attribute VALUES must never carry personal data (ids are fine, emails and names are not).
 */
export function withSpan<T>(
  name: string,
  attrs: Attributes | undefined,
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  const t = current;
  if (!t) return fn(undefined);
  return t.tracer.startActiveSpan(
    name,
    { ...(attrs ? { attributes: attrs } : {}) },
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error('non-error thrown'));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/** Starts a span that the caller ends (request spans: they span hooks, not one function). */
export function startSpan(
  name: string,
  attrs?: Attributes,
  parent?: Context,
): { span: Span; ctx: Context } | null {
  const t = current;
  if (!t) return null;
  const base = parent ?? context.active();
  const span = t.tracer.startSpan(name, { ...(attrs ? { attributes: attrs } : {}) }, base);
  return { span, ctx: trace.setSpan(base, span) };
}

/** Runs `fn` with `ctx` active (so spans started inside become children of the request span). */
export function runInContext<T>(ctx: Context, fn: () => T): T {
  return context.with(ctx, fn);
}

/**
 * Wraps the async functions of a service object so each call is a span `<name>.<function>`. A Proxy, so a new service function
 * is covered without touching it; non-function properties pass through; a synchronous return value stays synchronous.
 */
export function traced<T extends object>(name: string, service: T): T {
  return new Proxy(service, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        if (!current) return (value as (...a: unknown[]) => unknown).apply(target, args);
        const t = current;
        return t.tracer.startActiveSpan(`${name}.${prop}`, (span) => {
          let result: unknown;
          try {
            result = (value as (...a: unknown[]) => unknown).apply(target, args);
          } catch (err) {
            span.recordException(err instanceof Error ? err : new Error('non-error thrown'));
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
            throw err;
          }
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            return (result as Promise<unknown>).then(
              (v) => {
                span.end();
                return v;
              },
              (err: unknown) => {
                span.recordException(err instanceof Error ? err : new Error('non-error thrown'));
                span.setStatus({ code: SpanStatusCode.ERROR });
                span.end();
                throw err;
              },
            );
          }
          span.end();
          return result;
        });
      };
    },
  });
}

/** The trace id of the active span (for log correlation), when there is one. */
export function activeTraceId(): string | undefined {
  const s = trace.getActiveSpan();
  const id = s?.spanContext().traceId;
  return id && /^[0-9a-f]{32}$/.test(id) && id !== '0'.repeat(32) ? id : undefined;
}

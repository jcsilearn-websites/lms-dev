import { context, type Span, SpanStatusCode } from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';
import { counter, currentTelemetry, histogram, LATENCY_BUCKETS, startSpan } from './telemetry';

// HTTP telemetry (step 14a): one SERVER span per request (children: the service calls and the database transactions it makes), the
// latency histogram and the request counter by ROUTE TEMPLATE (never the raw URL: ids and tokens stay out of metric labels).
// Costs one null check per request when no telemetry is installed.

declare module 'fastify' {
  interface FastifyRequest {
    telemetrySpan?: Span;
  }
}

const statusClass = (code: number) => `${Math.floor(code / 100)}xx`;

export function registerHttpTelemetry(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    const started = startSpan(`HTTP ${request.method}`, {
      'http.request.method': request.method,
      'lms.request_id': request.id,
    });
    if (!started) return done();
    request.telemetrySpan = started.span;
    // the rest of the request (hooks, handler, service calls) runs inside the span's context
    context.with(started.ctx, done);
  });

  app.addHook('onResponse', async (request, reply) => {
    if (!currentTelemetry()) return;
    const route = request.routeOptions.url ?? 'unmatched';
    const status = reply.statusCode;
    const labels = { method: request.method, route, status_class: statusClass(status) };
    counter('lms_http_requests_total', 'HTTP requests by route template and status class').add(
      1,
      labels,
    );
    // the status class cannot tell a refused-for-rate answer from any other 4xx
    if (status === 429) {
      counter(
        'lms_http_rate_limited_total',
        '429 answers (rate limits, code lockouts) by route',
      ).add(1, { route });
    }
    histogram('lms_http_request_duration_seconds', 'HTTP request duration', LATENCY_BUCKETS).record(
      reply.elapsedTime / 1000,
      labels,
    );
    const span = request.telemetrySpan;
    if (span) {
      span.updateName(`HTTP ${request.method} ${route}`);
      span.setAttribute('http.route', route);
      span.setAttribute('http.response.status_code', status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
  });
}

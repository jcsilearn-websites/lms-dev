import type { FastifyReply, FastifyRequest } from 'fastify';
import { scrubReport } from '../../contracts/scrub';
import { NotFoundError, UnauthorizedError } from '../../core/errors';
import { metricsAuthorized } from '../../core/metrics-auth';
import { counter, currentTelemetry } from '../../core/telemetry';

/** `https://host/first-segment` of a URL: the query, the fragment and deeper path parts (playback tokens, ids) are dropped. */
export function scrubUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return value.slice(0, 40); // 'inline', 'eval', 'self', ...
  try {
    const u = new URL(value);
    const first = u.pathname.split('/').filter(Boolean)[0];
    return `${u.protocol}//${u.host}${first ? `/${first}` : ''}`.slice(0, 120);
  } catch {
    return '';
  }
}

const DIRECTIVE = /^[a-z-]{1,40}$/;

/** The reports of a body in either format (`application/csp-report` object, `application/reports+json` array). */
export function cspReportsOf(body: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const add = (r: unknown) => {
    if (r && typeof r === 'object') out.push(r as Record<string, unknown>);
  };
  if (Array.isArray(body)) {
    for (const item of body.slice(0, 20)) add((item as { body?: unknown } | null)?.body);
  } else if (body && typeof body === 'object') {
    const legacy = (body as Record<string, unknown>)['csp-report'];
    add(legacy ?? body);
  }
  return out;
}

export function createOpsController(deps: { metricsToken: string | undefined }) {
  return {
    /**
     * A browser's CSP violation report. Logged WITHOUT personal data: URLs are cut to origin + first path segment, no
     * sample text, no query. Counted by directive so an alert can fire on a rise after a deploy.
     */
    cspReport: async (request: FastifyRequest, reply: FastifyReply): Promise<null> => {
      for (const r of cspReportsOf(request.body)) {
        const raw = String(
          r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive'] ?? '',
        );
        const first = raw.split(' ')[0] ?? '';
        const directive = DIRECTIVE.test(first) ? first : 'unknown';
        counter('lms_csp_violations_total', 'CSP violation reports received').add(1, { directive });
        request.log.warn(
          {
            csp: {
              directive,
              blocked: scrubUrl(r['blocked-uri'] ?? r.blockedURL ?? r.blockedURI),
              document: scrubUrl(r['document-uri'] ?? r.documentURL ?? r.documentURI),
              disposition: r.disposition === 'report' ? 'report' : 'enforce',
            },
          },
          'csp violation',
        );
      }
      void reply.code(204);
      return null;
    },

    /**
     * A browser's error report. NO database access (this controller has none). The body is scrubbed AGAIN here (e-mail addresses, ids, tokens, hosts and
     * queries of URLs, long numbers: contracts/scrub.ts) before one log line is written; the report is counted by kind and never stored.
     */
    clientError: async (request: FastifyRequest, reply: FastifyReply): Promise<null> => {
      const body = request.body as {
        kind: 'render' | 'unhandled' | 'rejection' | 'chunk';
        message: string;
        stack?: string;
        route?: string;
        build?: string;
      };
      const report = scrubReport(body);
      counter('lms_client_errors_total', 'Browser error reports received').add(1, {
        kind: report.kind,
      });
      request.log.warn({ clientError: report }, 'client error');
      void reply.code(204);
      return null;
    },

    metrics: async (request: FastifyRequest, reply: FastifyReply): Promise<string> => {
      if (!deps.metricsToken) throw new NotFoundError('not_found', 'Not found');
      if (!metricsAuthorized(request.headers.authorization, deps.metricsToken)) {
        throw new UnauthorizedError('metrics_unauthorized', 'A metrics token is required');
      }
      const telemetry = currentTelemetry();
      void reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      void reply.header('cache-control', 'no-store');
      return telemetry ? await telemetry.renderMetrics() : '# telemetry is not installed\n';
    },
  };
}
export type OpsController = ReturnType<typeof createOpsController>;

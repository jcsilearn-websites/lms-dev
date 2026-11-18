import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { OpsController } from './ops.controller';
import { cspReportRouteSchema, metricsRouteSchema } from './ops.schemas';

// GET /metrics, at the ROOT (a scrape target, not an application route). Public in the permission sense (no session, no host rules)
// and protected by a bearer token; strictly rate limited per address so the token cannot be guessed.
export function createMetricsRoutes(deps: {
  opsController: OpsController;
}): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      '/metrics',
      {
        config: { public: true, strictRateLimit: { max: 60, windowMs: 60_000 } },
        schema: metricsRouteSchema,
      },
      deps.opsController.metrics,
    );
  };
}

// POST /api/csp-report: where browsers post CSP violations. A browser cannot send our CSRF headers, so the route is one of
// the three CSRF exemptions (core/csrf.ts); it creates nothing, authenticates nothing, reads at most 8 KB, and is limited to
// 60 reports per address per minute across every API instance.
export function createCspReportRoutes(deps: {
  opsController: OpsController;
}): FastifyPluginAsyncTypebox {
  return async (app) => {
    await app.register(async (r) => {
      r.addContentTypeParser(
        ['application/csp-report', 'application/reports+json'],
        { parseAs: 'string', bodyLimit: 8192 },
        (_req, body, done) => {
          try {
            done(null, JSON.parse(String(body)));
          } catch {
            done(null, null);
          }
        },
      );
      r.post(
        '/csp-report',
        {
          config: {
            public: true,
            csrfExempt: 'csp-report',
            strictRateLimit: { max: 60, windowMs: 60_000 },
          },
          bodyLimit: 8192,
          schema: cspReportRouteSchema,
        },
        deps.opsController.cspReport,
      );
    });
  };
}

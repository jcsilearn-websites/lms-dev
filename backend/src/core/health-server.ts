import { createServer, type Server } from 'node:http';
import { metricsAuthorized } from './metrics-auth';

// The worker's own HTTP port (step 14a): liveness, readiness and (with a token) metrics. A plain node:http server, not Fastify: the
// worker serves nothing else and this keeps it small. The API has the same probes (modules/health) and GET /metrics (modules/ops).
//   GET /health/live    200 while the process runs its event loop
//   GET /health/ready   200 when the database answers and the queue loop is alive; 503 otherwise (a platform restarts or stops routing)
//   GET /metrics        Prometheus text, bearer token; 404 when no token is configured

export interface HealthReadiness {
  ok: boolean;
  /** safe, small details (no hosts, no errors with secrets) */
  details: Record<string, string | number | boolean>;
}

export interface HealthServerOptions {
  port: number;
  host: string;
  ready(): Promise<HealthReadiness>;
  metricsToken?: string | undefined;
  renderMetrics?: (() => Promise<string>) | undefined;
}

export interface HealthServer {
  /** the port actually bound (0 = an ephemeral one in tests) */
  readonly port: number;
  close(): Promise<void>;
}

export function startHealthServer(opts: HealthServerOptions): Promise<HealthServer> {
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    });
    res.end(text);
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0];
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return json(res, 405, { status: 'method_not_allowed' });
      if (path === '/health/live') return json(res, 200, { status: 'ok' });
      if (path === '/health/ready') {
        try {
          const r = await opts.ready();
          return json(res, r.ok ? 200 : 503, { status: r.ok ? 'ok' : 'unavailable', ...r.details });
        } catch {
          return json(res, 503, { status: 'unavailable' });
        }
      }
      if (path === '/metrics') {
        if (!opts.metricsToken || !opts.renderMetrics)
          return json(res, 404, { status: 'not_found' });
        if (!metricsAuthorized(req.headers.authorization, opts.metricsToken)) {
          return json(res, 401, { status: 'unauthorized' });
        }
        const text = await opts.renderMetrics();
        res.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'cache-control': 'no-store',
        });
        return res.end(text);
      }
      return json(res, 404, { status: 'not_found' });
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { status: 'error' });
      else res.end();
    });
  });
  // a probe must never hold the process open
  server.keepAliveTimeout = 5000;
  server.requestTimeout = 10_000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : opts.port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

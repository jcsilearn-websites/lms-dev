import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { ApiEnv } from '../config/env';
import { notFoundHandler } from './error-handler';
import { hashToken } from './tokens';

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Who a request counts against. A request that carries a session cookie counts against THAT SESSION; anyone else
 * (login, password reset, invite, a probe, a bad cookie) against the client address. A computer lab shares one public
 * address: 60 students in it must not share one budget, so signed-in traffic is never limited per address. A forged
 * cookie does not get around the address limit: a cookie that does not resolve to a session is counted against the
 * address by `createBadSessionLimiter` (see registerAuthContext).
 */
export function rateLimitKey(
  request: { headers: { cookie?: string | undefined }; ip: string },
  cookieName: string,
): string {
  const header = request.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === cookieName) {
        const token = part.slice(i + 1).trim();
        if (TOKEN_SHAPE.test(token)) return `s:${hashToken(token).toString('hex')}`;
      }
    }
  }
  return `ip:${request.ip}`;
}

/**
 * Counts failed session lookups per address (a cookie of the right shape that is not a live session). Without this a
 * client could send a fresh random cookie with every request, get a fresh per-session budget each time and make the
 * API run a database lookup per request. In memory, per instance, like the other limiters.
 */
export function createBadSessionLimiter(opts: {
  max: number;
  windowMs: number;
  now?: () => number;
}) {
  const now = opts.now ?? (() => Date.now());
  const seen = new Map<string, { n: number; reset: number }>();
  return {
    /** true = this address has used up its budget of unresolved sessions in the window */
    exceeded(ip: string): boolean {
      const t = now();
      if (seen.size > 10_000) for (const [k, v] of seen) if (v.reset <= t) seen.delete(k);
      const e = seen.get(ip);
      if (!e || e.reset <= t) {
        seen.set(ip, { n: 1, reset: t + opts.windowMs });
        return false;
      }
      e.n += 1;
      return e.n > opts.max;
    },
  };
}
export type BadSessionLimiter = ReturnType<typeof createBadSessionLimiter>;

/** helmet security headers, CORS restricted by config, and rate limiting (404s included). */
export function registerSecurity(
  app: FastifyInstance,
  env: Pick<ApiEnv, 'CORS_ORIGINS' | 'RATE_LIMIT_MAX' | 'RATE_LIMIT_WINDOW_MS'>,
  cookieName: string,
): void {
  void app.register(helmet);
  void app.register(cors, {
    origin: env.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  });
  void app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (request) => rateLimitKey(request, cookieName),
    // in-memory store: per instance. Needs a shared store before production (see CLAUDE.md).
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      code: 'FST_ERR_RATE_LIMIT',
      error: 'Too Many Requests',
      message: `Rate limit exceeded, retry in ${context.after}`,
    }),
  });

  // 404s are rate limited too (scanners); the limiter must be loaded before it can be referenced.
  void app.after(() => {
    app.setNotFoundHandler({ preHandler: app.rateLimit() }, notFoundHandler);
  });
}

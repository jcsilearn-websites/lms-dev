import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { ApiEnv } from '../config/env';
import { notFoundHandler } from './error-handler';
import { TooManyRequestsError } from './errors';
import {
  type BatchedLimiter,
  createBatchedLimiter,
  createFastifyRateLimitStore,
  type StrictLimiter,
} from './rate-limit';
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
 * API run a database lookup per request. Counted in the local tier (batched into the shared store when there is one, so the
 * count is shared by every API instance).
 */
export function createBadSessionLimiter(opts: {
  max: number;
  windowMs: number;
  limiter?: BatchedLimiter;
  now?: () => number;
}) {
  const limiter =
    opts.limiter ?? createBatchedLimiter({ shared: null, ...(opts.now ? { now: opts.now } : {}) });
  return {
    /** true = this address has used up its budget of unresolved sessions in the window */
    exceeded(ip: string): boolean {
      return this.retryAfterSeconds(ip) > 0;
    },
    /** Counts one unresolved session. 0 = within the budget, else the seconds until the window ends. */
    retryAfterSeconds(ip: string): number {
      const hit = limiter.hit(`bad-session|${ip}`, opts.windowMs, opts.max);
      return hit.count > opts.max ? Math.max(1, Math.ceil(hit.ttlMs / 1000)) : 0;
    },
  };
}
export type BadSessionLimiter = ReturnType<typeof createBadSessionLimiter>;

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * An anonymous / authentication route counted in the SHARED store on every request (the strict tier, core/rate-limit/strict.ts):
     * at most `max` requests per address in `windowMs`, across every API instance. One extra autocommit statement per request.
     */
    strictRateLimit?: { max: number; windowMs: number };
  }
}

export interface SecurityDeps {
  /** the local tier (every route's limit; batched into the shared store when there is one) */
  limiter: BatchedLimiter;
  /** the strict tier (routes declaring `config.strictRateLimit`) */
  strict: StrictLimiter;
}

/** helmet security headers, CORS restricted by config, and rate limiting (404s included). */
export function registerSecurity(
  app: FastifyInstance,
  env: Pick<ApiEnv, 'CORS_ORIGINS' | 'RATE_LIMIT_MAX' | 'RATE_LIMIT_WINDOW_MS'>,
  cookieName: string,
  deps: SecurityDeps,
): void {
  // The API answers JSON and files: nothing it sends may load or run anything (the SPA's policy is contracts/csp.ts).
  void app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
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
    store: createFastifyRateLimitStore(deps.limiter),
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      code: 'FST_ERR_RATE_LIMIT',
      error: 'Too Many Requests',
      message: `Rate limit exceeded, retry in ${context.after}`,
    }),
  });

  // Authenticated and personal responses must not be kept by a browser or a shared cache (ASVS 8.1.1): `no-store` unless the route chose
  // its own policy (downloads, the bell's `private, no-cache` + ETag, video playlists).
  app.addHook('onSend', async (_request, reply, payload) => {
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
    return payload;
  });

  // The strict tier: routes that declare `config.strictRateLimit` count in the shared store, per address and route.
  app.addHook('onRequest', async (request, reply) => {
    const cfg = request.routeOptions.config?.strictRateLimit;
    if (!cfg) return;
    const hit = await deps.strict.hit(
      `strict|${request.method} ${request.routeOptions.url ?? ''}|${request.ip}`,
      cfg.windowMs,
    );
    if (hit.count > cfg.max) {
      const retry = Math.max(1, Math.ceil(hit.ttlMs / 1000));
      void reply.header('retry-after', String(retry));
      throw new TooManyRequestsError('rate_limited', `Too many requests, retry in ${retry}s`);
    }
  });

  // 404s are rate limited too (scanners); the limiter must be loaded before it can be referenced.
  void app.after(() => {
    app.setNotFoundHandler({ preHandler: app.rateLimit() }, notFoundHandler);
  });
}

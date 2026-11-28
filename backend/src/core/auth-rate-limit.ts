import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, ServiceBusyError } from './errors';
import { createStrictLimiter, type StrictLimiter } from './rate-limit';

export interface AuthRateLimitConfig {
  /** per address and route on the credential routes OTHER than sign-in (codes, reset request, invite acceptance) */
  perIp: number;
  /** sign-in attempts per address: generous, a college behind one address (a lab) signs in at once */
  signInPerIp: number;
  /** FAILED sign-ins per address: much stricter (password spraying); once reached, every sign-in from there waits */
  signInFailuresPerIp: number;
  perEmail: number;
  windowMs: number;
}

export class TooManyRequestsError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(429, 'rate_limited', `Too many attempts, retry in ${retryAfterSeconds}s`);
  }
}

/**
 * Fixed-window counter keyed by string. In-memory (per instance, like the global limiter: a shared
 * store is a known gap) and bounded: expired windows are pruned, and when the table is still full
 * the oldest keys are dropped so memory cannot grow without limit under a key-flooding attack.
 */
export function createWindowLimiter(opts: {
  max: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}) {
  const maxKeys = opts.maxKeys ?? 50_000;
  const now = opts.now ?? Date.now;
  const hits = new Map<string, { count: number; resetAt: number }>();

  function prune(t: number): void {
    for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key);
    while (hits.size >= maxKeys) {
      const oldest = hits.keys().next().value;
      if (oldest === undefined) break;
      hits.delete(oldest);
    }
  }

  return {
    /** Counts one hit. Returns the seconds to wait when over the limit, otherwise 0. */
    hit(key: string): number {
      const t = now();
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        if (hits.size >= maxKeys) prune(t);
        hits.set(key, { count: 1, resetAt: t + opts.windowMs });
        return 0;
      }
      entry.count++;
      return entry.count > opts.max ? Math.max(1, Math.ceil((entry.resetAt - t) / 1000)) : 0;
    },
    size: () => hits.size,
  };
}

const emailOf = (request: FastifyRequest): string => {
  const email = (request.body as { email?: unknown } | null)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase().slice(0, 320) : '';
};

/**
 * Stricter limits for credential-sensitive endpoints (login, password-reset request, invite
 * accept): one bucket per client IP (onRequest) and one per target email (preHandler, needs the
 * parsed body), both per route. 429 uses the standard error shape plus Retry-After.
 * With a `strict` limiter the buckets are SHARED by every API instance (step 14a): the email is hashed before it becomes a
 * key, so the shared table never holds an address. Without one (unit tests, a single instance) they are in memory.
 */
export function createAuthRateLimits(
  cfg: AuthRateLimitConfig,
  strict?: StrictLimiter,
  /** is the password-hashing queue full right now? */
  hashingFull: () => boolean = () => false,
) {
  const ipLimiter = createWindowLimiter({ max: cfg.perIp, windowMs: cfg.windowMs });
  const emailLimiter = createWindowLimiter({ max: cfg.perEmail, windowMs: cfg.windowMs });
  const route = (r: FastifyRequest) => r.routeOptions.url ?? r.url;

  const enforce = (retryAfter: number, reply: FastifyReply) => {
    if (retryAfter > 0) {
      reply.header('retry-after', String(retryAfter));
      throw new TooManyRequestsError(retryAfter);
    }
  };

  const shared = async (key: string, max: number): Promise<number> => {
    if (!strict) return 0;
    const hit = await strict.hit(key, cfg.windowMs);
    return hit.count > max ? Math.max(1, Math.ceil(hit.ttlMs / 1000)) : 0;
  };
  const emailKey = (request: FastifyRequest) =>
    createHash('sha256').update(emailOf(request)).digest('hex').slice(0, 32);

  // ---- sign-in: attempts and failures per address. Failures are counted when they happen (before the 401 goes out), and the
  // address is remembered as spent by the instance that saw the count reach the limit: a successful sign-in costs no extra
  // look-up. Another instance learns it with the next failure it counts itself, so N instances let at most N - 1 more through.
  const counters = strict ?? createStrictLimiter({ shared: null });
  const spent = new Map<string, number>(); // address -> the time its window ends
  const secondsLeft = (until: number) => Math.ceil((until - Date.now()) / 1000);

  return {
    /**
     * Goes BEFORE the sign-in limits: a sign-in that could not be hashed anyway is refused without being counted, so the
     * automatic retries of a busy moment do not spend the person's (or their lab's) attempts. A request that passes here and
     * finds the queue full later gets the same 503 and has been counted.
     */
    admitHashing: async () => {
      if (hashingFull()) throw new ServiceBusyError();
    },
    signInPerIp: async (request: FastifyRequest, reply: FastifyReply) => {
      const until = spent.get(request.ip);
      if (until !== undefined) {
        if (until > Date.now()) enforce(secondsLeft(until), reply);
        else spent.delete(request.ip);
      }
      const hit = await counters.hit(`auth-ip|${route(request)}|${request.ip}`, cfg.windowMs);
      enforce(hit.count > cfg.signInPerIp ? Math.max(1, Math.ceil(hit.ttlMs / 1000)) : 0, reply);
    },
    /** An `onError` hook of the sign-in route: only a refused credential counts (never a 429, a 503 or a bad request). */
    signInFailed: async (request: FastifyRequest, _reply: FastifyReply, error: unknown) => {
      if ((error as { code?: unknown }).code !== 'invalid_credentials') return;
      const hit = await counters.hit(`auth-fail|${route(request)}|${request.ip}`, cfg.windowMs);
      if (hit.count < cfg.signInFailuresPerIp) return;
      if (spent.size >= 10_000) {
        for (const [ip, until] of spent) if (until <= Date.now()) spent.delete(ip);
        const oldest = spent.keys().next().value;
        if (spent.size >= 10_000 && oldest !== undefined) spent.delete(oldest);
      }
      spent.set(request.ip, Date.now() + hit.ttlMs);
    },
    perIp: async (request: FastifyRequest, reply: FastifyReply) =>
      enforce(
        strict
          ? await shared(`auth-ip|${route(request)}|${request.ip}`, cfg.perIp)
          : ipLimiter.hit(`${route(request)}|${request.ip}`),
        reply,
      ),
    perEmail: async (request: FastifyRequest, reply: FastifyReply) =>
      enforce(
        strict
          ? await shared(`auth-email|${route(request)}|${emailKey(request)}`, cfg.perEmail)
          : emailLimiter.hit(`${route(request)}|${emailOf(request)}`),
        reply,
      ),
  };
}

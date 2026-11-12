import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hashToken } from './tokens';

// DEADLINE FAIRNESS UNDER LOAD. A request that arrived before a deadline must not be marked late because it waited for a
// database connection (or was refused with 503 busy and retried).
//
//  1. The ARRIVAL time is taken in Node by the first hook of the request, before anything waits for the pool, and travels to
//     the deadline-sensitive database functions (assignment finalize and upload request, exam autosave and submit), which
//     validate it (lms.effective_arrival: never in the future, never older than a bounded wait) and use it instead of now().
//  2. When such a request is refused with 503 busy, the answer carries a signed RECEIPT (HMAC, computed here with no database
//     access at all): who (the user, when known, and the session), which college, which resource, which operation, the arrival
//     time, an expiry. The client sends it back on the retry (`X-Deadline-Receipt`). A receipt that verifies and is bound to
//     THAT session / user, college, resource and operation, and has not expired, gives the retry the receipt's arrival time (for
//     at most the receipt window). Anything else is ignored: the retry then counts from its own arrival, like any request.
//
// Only routes that declare `config.deadline = { operation, param }` take part: `param` names the route parameter that is the
// resource (an assignment item id, an attempt id).

export interface Arrival {
  /** epoch ms: when the request (or the receipt it carries) says it reached the server */
  atMs: number;
  /** the database never believes an arrival older than this many seconds */
  maxAgeSeconds: number;
  /** the receipt the arrival came from, so a second 503 hands the SAME receipt back (never a later arrival) */
  receipt: string | null;
}

export interface ReceiptClaims {
  v: 1;
  /** the user, when the session was already resolved at the time of the refusal */
  u: string | null;
  /** the college */
  t: string;
  /** SHA-256 (hex) of the session token: the user is not known when the session lookup itself was refused */
  s: string;
  /** the resource: the id in the route */
  r: string;
  /** the operation, e.g. `assignment.submit` */
  o: string;
  /** arrival, epoch ms */
  a: number;
  /** expiry, epoch ms */
  e: number;
}

export interface ReceiptSigner {
  readonly windowSeconds: number;
  sign(c: Omit<ReceiptClaims, 'v' | 'e'>): string;
  /** The claims of a genuine, unexpired receipt; null for anything else. */
  verify(token: string): ReceiptClaims | null;
}

const LABEL = 'lms deadline receipts v1';

/** The signing key: the configured one, or derived (HKDF, own label) from the storage key. */
export function receiptKey(opts: {
  secret?: string | undefined;
  storageSecret?: string | undefined;
}): string {
  if (opts.secret) return opts.secret;
  return Buffer.from(hkdfSync('sha256', opts.storageSecret ?? '', '', LABEL, 32)).toString('hex');
}

export function createReceiptSigner(opts: {
  key: string;
  windowSeconds: number;
  now?: () => number;
}): ReceiptSigner {
  const now = opts.now ?? (() => Date.now());
  const mac = (payload: string) => createHmac('sha256', opts.key).update(payload).digest();
  return {
    windowSeconds: opts.windowSeconds,
    sign(c) {
      const claims: ReceiptClaims = { v: 1, ...c, e: now() + opts.windowSeconds * 1000 };
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return `${payload}.${mac(payload).toString('base64url')}`;
    },
    verify(token) {
      if (typeof token !== 'string' || token.length > 700) return null;
      const dot = token.indexOf('.');
      if (dot < 1) return null;
      const payload = token.slice(0, dot);
      const given = Buffer.from(token.slice(dot + 1), 'base64url');
      const want = mac(payload);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
      try {
        const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ReceiptClaims;
        if (
          c.v !== 1 ||
          typeof c.t !== 'string' ||
          typeof c.s !== 'string' ||
          typeof c.r !== 'string' ||
          typeof c.o !== 'string' ||
          typeof c.a !== 'number' ||
          typeof c.e !== 'number' ||
          (c.u !== null && typeof c.u !== 'string')
        )
          return null;
        return c.e > now() ? c : null;
      } catch {
        return null;
      }
    },
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    arrival: Arrival;
  }
  interface FastifyInstance {
    receipts: ReceiptSigner | null;
    /** the session cookie's name, for the error handler (which has no other way to know it) */
    receiptCookie: string | null;
  }
  interface FastifyContextConfig {
    /** A deadline-sensitive route: the operation and the route parameter that names the resource. */
    deadline?: { operation: string; param: string };
  }
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function sessionHash(request: FastifyRequest, cookieName: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  const token = cookie.parse(header)[cookieName];
  return token && TOKEN_SHAPE.test(token) ? hashToken(token).toString('hex') : null;
}

/**
 * The FIRST hook of every request: the arrival time, taken before the tenant or the session is looked up (those wait for the
 * database pool too). A plain request is believed for at most `queueWaitSeconds` of waiting.
 */
export function registerArrivalClock(
  app: FastifyInstance,
  opts: { queueWaitSeconds: number },
): void {
  app.decorate('receipts', null);
  app.decorate('receiptCookie', null);
  app.decorateRequest('arrival', null as never);
  app.addHook('onRequest', async (request) => {
    request.arrival = { atMs: Date.now(), maxAgeSeconds: opts.queueWaitSeconds, receipt: null };
  });
}

/**
 * Register AFTER the session is resolved (registerAuthContext): reads `X-Deadline-Receipt` on a deadline-sensitive route and,
 * when it is valid for this session / user, college, resource and operation, makes its arrival the request's arrival.
 */
/** The claims of the receipt the request carries when it is valid for THIS session / user, college, resource and operation. */
function matchingReceipt(
  request: FastifyRequest,
  signer: ReceiptSigner,
  cookieName: string,
): { claims: ReceiptClaims; token: string } | null {
  const cfg = request.routeOptions?.config?.deadline;
  const header = request.headers['x-deadline-receipt'];
  if (!cfg || typeof header !== 'string') return null;
  const c = signer.verify(header);
  if (!c) return null;
  const params = (request.params ?? {}) as Record<string, string | undefined>;
  if (c.o !== cfg.operation || c.r !== params[cfg.param] || c.t !== request.tenant?.id) return null;
  const sh = sessionHash(request, cookieName);
  const sameUser = c.u !== null && request.auth?.userId === c.u;
  if (!sameUser && !(sh !== null && c.s === sh)) return null;
  return { claims: c, token: header };
}

export function registerReceipts(
  app: FastifyInstance,
  deps: { signer: ReceiptSigner; cookieName: string },
): void {
  app.receipts = deps.signer;
  app.receiptCookie = deps.cookieName;
  app.addHook('onRequest', async (request) => {
    const m = matchingReceipt(request, deps.signer, deps.cookieName);
    if (m) {
      request.arrival = {
        atMs: m.claims.a,
        maxAgeSeconds: deps.signer.windowSeconds,
        receipt: m.token,
      };
    }
  });
}

/**
 * The receipt for a request that was refused with 503 busy, or null when there is nothing to bind it to (not a deadline route,
 * no college, no session cookie) or no signer. A request that ALREADY carried a valid receipt gets the same one back: the
 * arrival never moves later because the retry was refused too. No database access.
 */
export function issueReceipt(request: FastifyRequest): string | null {
  const signer = request.server.receipts;
  const cookieName = request.server.receiptCookie;
  const cfg = request.routeOptions?.config?.deadline;
  const tenant = request.tenant?.id;
  if (!signer || !cookieName || !cfg || !tenant) return null;
  // a retry that carried a valid receipt and was refused again (even before the receipt was read, at the session lookup)
  // gets the SAME receipt: the arrival never moves later
  const carried = matchingReceipt(request, signer, cookieName);
  if (carried) return carried.token;
  const params = (request.params ?? {}) as Record<string, string | undefined>;
  const resource = params[cfg.param];
  const sh = sessionHash(request, cookieName);
  if (!resource || !sh || !request.arrival) return null;
  return signer.sign({
    u: request.auth?.userId ?? null,
    t: tenant,
    s: sh,
    r: resource,
    o: cfg.operation,
    a: request.arrival.atMs,
  });
}

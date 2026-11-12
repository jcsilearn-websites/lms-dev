import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { FastifyContextConfig, FastifyInstance, FastifyRequest } from 'fastify';
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
//  3. A receipt is also bound to the PAYLOAD that was refused: `h` is a hash of the operation, the resource and the canonical form of
//     what the request carried (`config.deadline.payload`: the hand-in's text, link, file ids and request key; an autosave's
//     (position, answer, rev) entries; a submit's attempt id). On the retry the receipt's arrival applies ONLY when the payload hashes
//     to the same value; a changed payload is judged by its own arrival, with no error (the receipt is simply ignored). A file id
//     stands for its bytes: a file is measured and its SHA-256 recorded once, when it is confirmed, and never again.
//
// Only routes that declare `config.deadline = { operation, param, payload }` take part: `param` names the route parameter that is the
// resource (an assignment item id, an attempt id), `payload` maps the request body to the value that is hashed (null: unusable).

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
  /** hash (base64url SHA-256) of the operation, the resource and the payload that was refused */
  h: string;
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
      if (typeof token !== 'string' || token.length > 900) return null;
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
          typeof c.h !== 'string' ||
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
    /** a receipt that is valid for this session, college, resource and operation; its payload is checked once the body is parsed */
    receiptCandidate: { claims: ReceiptClaims; token: string } | null;
  }
  interface FastifyInstance {
    receipts: ReceiptSigner | null;
    /** the session cookie's name, for the error handler (which has no other way to know it) */
    receiptCookie: string | null;
  }
  interface FastifyContextConfig {
    /** A deadline-sensitive route: the operation and the route parameter that names the resource. */
    deadline?: {
      operation: string;
      param: string;
      /** the part of the body that the receipt is bound to (any JSON value; null = cannot be bound) */
      payload: (body: unknown) => unknown;
    };
  }
}

/** JSON with the keys of every object sorted, so the same data always has the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

/** The value a receipt is bound to; null when the route cannot say what the payload is. */
export function payloadHash(
  cfg: NonNullable<FastifyContextConfig['deadline']>,
  resource: string,
  body: unknown,
): string | null {
  let value: unknown;
  try {
    value = cfg.payload(body);
  } catch {
    return null;
  }
  if (value === null || value === undefined) return null;
  return createHash('sha256')
    .update(canonicalJson([cfg.operation, resource, value]))
    .digest('base64url');
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
  app.decorateRequest('receiptCandidate', null as never);
  // 1. before the body exists: is this receipt for this session / user, college, resource and operation?
  app.addHook('onRequest', async (request) => {
    request.receiptCandidate = matchingReceipt(request, deps.signer, deps.cookieName);
  });
  // 2. the body is parsed and validated: the receipt's arrival applies only to the exact payload that was refused. Anything
  // else (an edited answer, another file, other text) is judged by its own arrival, silently.
  app.addHook('preHandler', async (request) => {
    const m = request.receiptCandidate;
    const cfg = request.routeOptions?.config?.deadline;
    if (!m || !cfg) return;
    const resource = (request.params as Record<string, string | undefined>)[cfg.param];
    const h = resource ? payloadHash(cfg, resource, request.body) : null;
    if (h === null || !sameHash(h, m.claims.h)) return;
    request.arrival = {
      atMs: m.claims.a,
      maxAgeSeconds: deps.signer.windowSeconds,
      receipt: m.token,
    };
  });
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The body of a request that was refused BEFORE it was parsed (the refusal came from the session lookup, which waits for the
 * pool first): read straight from the socket, bounded in size and time, no database. null when it cannot be read.
 */
async function readRawJson(request: FastifyRequest): Promise<unknown> {
  // no JSON body (a submit sends none): undefined, which the payload function of such a route does not need
  if (!String(request.headers['content-type'] ?? '').includes('json')) return undefined;
  const limit = request.routeOptions?.bodyLimit ?? 1_048_576;
  const declared = Number(request.headers['content-length'] ?? 0);
  if (!(declared >= 0) || declared > limit) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  const read = (async () => {
    for await (const chunk of request.raw) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += b.length;
      if (size > limit) return null;
      chunks.push(b);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  })().catch(() => null);
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000).unref());
  return Promise.race([read, timeout]);
}

/**
 * The receipt for a request that was refused with 503 busy, or null when there is nothing to bind it to (not a deadline route,
 * no college, no session cookie, a body that cannot be read) or no signer. The receipt carries the hash of the payload that was
 * refused. A retry that carried a valid receipt FOR THE SAME PAYLOAD and was refused again gets the same receipt back (the
 * arrival never moves later); a retry with a changed payload gets a new receipt for its own arrival. No database access.
 */
export async function issueReceipt(request: FastifyRequest): Promise<string | null> {
  const signer = request.server.receipts;
  const cookieName = request.server.receiptCookie;
  const cfg = request.routeOptions?.config?.deadline;
  const tenant = request.tenant?.id;
  if (!signer || !cookieName || !cfg || !tenant) return null;
  const params = (request.params ?? {}) as Record<string, string | undefined>;
  const resource = params[cfg.param];
  const sh = sessionHash(request, cookieName);
  if (!resource || !sh || !request.arrival) return null;
  const body = request.body !== undefined ? request.body : await readRawJson(request);
  const h = payloadHash(cfg, resource, body);
  if (h === null) return null;
  // refused again before the receipt was looked at (at the session lookup): the same payload keeps the same receipt
  const carried = matchingReceipt(request, signer, cookieName);
  if (carried && sameHash(h, carried.claims.h)) return carried.token;
  return signer.sign({
    u: request.auth?.userId ?? null,
    t: tenant,
    s: sh,
    r: resource,
    o: cfg.operation,
    h,
    a: request.arrival.atMs,
  });
}

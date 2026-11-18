import type { LightMyRequestResponse } from 'fastify';
import { DeferJobError } from '../src/core/handlers';
import type { TestApp } from './app';

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Send Origin + X-Requested-With like a browser would (default true). */
  browser?: boolean;
  query?: string;
}

/**
 * A tiny browser stand-in for inject(): one host, a cookie jar, and the Origin /
 * X-Requested-With headers the CSRF check requires.
 */
/** Application routes live under /api; the health probes and /docs stay at the root. */
export function withApiPrefix(url: string): string {
  return /^\/(api|health|docs)(\/|\?|$)/.test(url) ? url : `/api${url}`;
}

export class TestClient {
  cookies = new Map<string, string>();

  constructor(
    readonly t: TestApp,
    readonly host: string,
  ) {}

  /** The current value of a cookie (undefined if absent/cleared). */
  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  get sessionToken(): string | undefined {
    return this.cookie('sid') ?? this.cookie('__Host-sid');
  }

  async request(method: string, url: string, opts: RequestOptions = {}) {
    const headers: Record<string, string> = { host: this.host, ...opts.headers };
    if (opts.browser !== false) {
      headers.origin ??= `http://${this.host}`;
      headers['x-requested-with'] ??= 'lms';
    }
    if (this.cookies.size > 0 && !headers.cookie) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const path = withApiPrefix(url);
    const res = await this.t.app.inject({
      method: method as never,
      url: opts.query ? `${path}?${opts.query}` : path,
      headers,
      ...(opts.body !== undefined ? { payload: opts.body as never } : {}),
    });
    this.store(res);
    return res;
  }

  get(url: string, opts?: RequestOptions) {
    return this.request('GET', url, opts);
  }
  post(url: string, body?: unknown, opts?: RequestOptions) {
    return this.request('POST', url, { ...opts, body });
  }
  put(url: string, body?: unknown, opts?: RequestOptions) {
    return this.request('PUT', url, { ...opts, body });
  }
  patch(url: string, body?: unknown, opts?: RequestOptions) {
    return this.request('PATCH', url, { ...opts, body });
  }
  delete(url: string, opts?: RequestOptions) {
    return this.request('DELETE', url, opts);
  }

  private store(res: LightMyRequestResponse) {
    for (const c of res.cookies) {
      if (c.value === '' || (c.maxAge !== undefined && c.maxAge <= 0)) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
  }

  async login(email: string, password: string) {
    return this.post('/auth/login', { email, password });
  }
}

/**
 * Runs every `email.send` job that is due, inline, through the app's REAL handler (claim -> mint -> render -> the
 * capturing provider -> mark): what the worker does. Waits for background work first (reset requests are queued in the
 * background). Returns how many jobs ran.
 */
export async function deliverEmails(
  t: TestApp,
  opts: { maxRounds?: number } = {},
): Promise<number> {
  await t.app.modules.background.drain();
  const jobs = t.app.modules.jobs.service;
  const handler = t.app.modules.handlers['email.send'];
  if (!handler) throw new Error('no email.send handler');
  const worker = `test-mail-${Math.random().toString(16).slice(2, 8)}`;
  let ran = 0;
  for (let round = 0; round < (opts.maxRounds ?? 50); round++) {
    const claimed = await jobs.claim('email.send', worker, 50);
    if (claimed.length === 0) break;
    for (const job of claimed) {
      const ctx = {
        jobId: job.id,
        queue: job.queue,
        tenantId: job.tenantId,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        signal: new AbortController().signal,
      };
      try {
        const result = await handler.run(job.payload, ctx);
        await jobs.complete(job.id, worker, result ?? null);
      } catch (err) {
        // a handler whose dependency is down defers the job (no attempt charged), exactly like the real runner
        if (err instanceof DeferJobError) await jobs.defer(job.id, worker, err.delaySeconds);
        else await jobs.fail(job.id, worker, err instanceof Error ? err.message : String(err));
      }
      ran++;
    }
  }
  return ran;
}

/** The newest emailed link token (`?token=...`) sent to an address (delivers queued mail first). */
export async function lastTokenFor(t: TestApp, to: string): Promise<string> {
  await deliverEmails(t);
  const mail = [...t.mailer.sent].reverse().find((m) => m.to === to);
  const token = mail && /token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
  if (!token) throw new Error(`no email with a token sent to ${to}`);
  return token;
}

/** Delivers queued mail (reset mail is queued in the background), then checks one arrived for `to`. */
export async function waitForMail(t: TestApp, to: string): Promise<void> {
  await deliverEmails(t);
  if (!t.mailer.sent.some((m) => m.to === to)) throw new Error(`no email sent to ${to}`);
}

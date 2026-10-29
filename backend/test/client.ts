import type { LightMyRequestResponse } from 'fastify';
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
    const res = await this.t.app.inject({
      method: method as never,
      url: opts.query ? `${url}?${opts.query}` : url,
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

/** The first emailed link token (`?token=...`) sent to an address. */
export function lastTokenFor(t: TestApp, to: string): string {
  const mail = [...t.mailer.sent].reverse().find((m) => m.to === to);
  const token = mail && /token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
  if (!token) throw new Error(`no email with a token sent to ${to}`);
  return token;
}

/** Waits for background tasks, then for a mail to arrive (reset mail is sent in the background). */
export async function waitForMail(t: TestApp, to: string): Promise<void> {
  await t.app.modules.background.drain();
  if (!t.mailer.sent.some((m) => m.to === to)) throw new Error(`no email sent to ${to}`);
}

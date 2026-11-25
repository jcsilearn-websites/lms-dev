// An HTTP client for ONE simulated user, on undici: a cookie jar, the two headers the API's CSRF rule needs (Origin equal to the request host and
// X-Requested-With: lms), the Host header of a college when the load goes to an IP, latency recorded per route template, and the retry a browser
// of ours does on 503 `busy` (the Retry-After wait, and the deadline receipt sent back).

import { Agent, request } from 'undici';
import { assertAllowedTarget } from './guard.mjs';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const HEX_TOKEN = /\/[0-9a-f]{24,}/g;

/** `GET /offerings/:id/items/:id/assignment` from a path with ids: statistics are kept per route, never per id. */
export function routeLabel(method, path) {
  const p = path.split('?')[0].replace(UUID, ':id').replace(HEX_TOKEN, '/:token');
  return `${method} ${p}`;
}

export function createTarget({ baseUrl, host, connections = 256 }) {
  assertAllowedTarget(baseUrl, { what: 'API' });
  const base = new URL(baseUrl);
  const hostHeader = host ?? base.host;
  const agent = new Agent({
    connections,
    pipelining: 1,
    keepAliveTimeout: 30_000,
    headersTimeout: 60_000,
    bodyTimeout: 60_000,
  });
  return {
    origin: base.origin,
    prefix: base.pathname.replace(/\/$/, ''),
    hostHeader,
    // the Origin of a browser on that page: the same scheme and host
    pageOrigin: `${base.protocol}//${hostHeader}`,
    agent,
    close: () => agent.close(),
  };
}

export class ApiClient {
  /** @param {{ target: ReturnType<typeof createTarget>, recorder: import('./stats.mjs').Recorder, name?: string }} o */
  constructor({ target, recorder, name = 'user' }) {
    this.target = target;
    this.recorder = recorder;
    this.name = name;
    this.cookies = new Map();
  }

  #cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  #store(setCookie) {
    for (const line of [setCookie ?? []].flat()) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (i < 1) continue;
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v === '' || /max-age=0/i.test(line)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }

  get signedIn() {
    return this.cookies.size > 0;
  }

  /**
   * One call. `path` starts with `/api/...`. Returns `{ status, json, text, buffer, headers, ms }`; a transport failure is recorded with status 0 and returned
   * with `error`. `label` overrides the route template; `record: false` keeps a call (preparation) out of the statistics.
   */
  async call(
    method,
    path,
    {
      json,
      body,
      headers = {},
      label,
      record = true,
      retryBusy = 0,
      binary = false,
      absolute = false,
    } = {},
  ) {
    const mutating = method !== 'GET' && method !== 'HEAD';
    const url = absolute ? new URL(path, this.target.origin) : null;
    const fullPath = absolute ? url.pathname + url.search : this.target.prefix + path;
    // a signed URL of an object store is another origin: no cookie, no CSRF header, its own Host
    const external = absolute && url.origin !== this.target.origin;
    const origin = external ? url.origin : this.target.origin;
    let attempt = 0;
    let receipt;
    for (;;) {
      const h = {
        host: external ? url.host : this.target.hostHeader,
        accept: 'application/json, */*',
        ...(this.cookies.size && !external ? { cookie: this.#cookieHeader() } : {}),
        ...(mutating && !external
          ? { origin: this.target.pageOrigin, 'x-requested-with': 'lms' }
          : {}),
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(receipt ? { 'x-deadline-receipt': receipt } : {}),
        ...headers,
      };
      const payload = json !== undefined ? JSON.stringify(json) : body;
      const t0 = performance.now();
      let res;
      try {
        res = await request(origin + fullPath, {
          method,
          headers: h,
          body: payload,
          dispatcher: this.target.agent,
        });
      } catch (err) {
        const ms = performance.now() - t0;
        const code = err.code ?? err.name ?? 'error';
        if (record)
          this.recorder.record(label ?? routeLabel(method, path), ms, 0, { error: String(code) });
        return { status: 0, error: String(code), ms, headers: {} };
      }
      let text;
      let buffer;
      let bytes = 0;
      try {
        if (binary) {
          buffer = Buffer.from(await res.body.arrayBuffer());
          bytes = buffer.length;
        } else {
          text = await res.body.text();
          bytes = Buffer.byteLength(text);
        }
      } catch (err) {
        const ms = performance.now() - t0;
        if (record)
          this.recorder.record(label ?? routeLabel(method, path), ms, 0, {
            error: String(err.code ?? err.name ?? 'body'),
          });
        return { status: 0, error: String(err.code ?? 'body'), ms, headers: res.headers };
      }
      const ms = performance.now() - t0;
      this.#store(res.headers['set-cookie']);
      let parsed;
      if (text && /json/.test(String(res.headers['content-type'] ?? ''))) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
      }
      const busy = res.statusCode === 503 && parsed?.error?.code === 'busy';
      if (record)
        this.recorder.record(label ?? routeLabel(method, path), ms, res.statusCode, { bytes });
      if (busy && attempt < retryBusy) {
        attempt++;
        receipt = res.headers['deadline-receipt'] ?? receipt;
        const wait = Math.min(10, Number(res.headers['retry-after'] ?? 2)) * 1000;
        await new Promise((r) => setTimeout(r, wait + Math.random() * 250));
        continue;
      }
      return { status: res.statusCode, json: parsed, text, buffer, headers: res.headers, ms };
    }
  }

  get(path, opts) {
    return this.call('GET', path, opts);
  }

  post(path, json, opts) {
    return this.call('POST', path, { json, ...opts });
  }

  put(path, json, opts) {
    return this.call('PUT', path, { json, ...opts });
  }

  patch(path, json, opts) {
    return this.call('PATCH', path, { json, ...opts });
  }

  /** Signs in. Returns true when the session cookie arrived. `record: false` for preparation. */
  async login(email, password, opts = {}) {
    const r = await this.post('/api/auth/login', { email, password }, { retryBusy: 3, ...opts });
    return r.status === 200 && this.signedIn;
  }
}

/** Throws with the answer when a call that must work did not (seeding, scenario setup: the run is meaningless otherwise). */
export function must(res, what) {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `${what} failed: ${res.status} ${res.error ?? ''} ${String(res.text ?? '').slice(0, 300)}`,
    );
  }
  return res.json;
}

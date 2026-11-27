// A fake service-worker global scope for the tests: it runs the text of frontend/sw/sw.js (the template the build ships) or sw-retire.js. Cache Storage records
// EVERY put, so a test (and the afterEach of each test) can fail when anything of /api ever lands in a cache.

import { vi } from 'vitest';
import workerSource from '../sw/sw.js?raw';
import retireSource from '../sw/sw-retire.js?raw';

export const ORIGIN = 'http://college.test';

export interface FakeResponse {
  ok: boolean;
  status: number;
  redirected: boolean;
  url: string;
  body: string;
  headers: { get(name: string): string | null };
  clone(): FakeResponse;
  json(): Promise<unknown>;
}

export function res(
  body: string,
  init: { status?: number; type?: string; redirected?: boolean; url?: string } = {},
): FakeResponse {
  const status = init.status ?? 200;
  const type = init.type ?? 'text/html; charset=utf-8';
  const self: FakeResponse = {
    ok: status >= 200 && status < 300,
    status,
    redirected: init.redirected ?? false,
    url: init.url ?? '',
    body,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? type : null) },
    clone: () => self,
    json: async () => JSON.parse(body),
  };
  return self;
}

const urlOf = (key: unknown): string =>
  new URL(typeof key === 'string' ? key : (key as { url: string }).url, ORIGIN).pathname;

class FakeCache {
  entries = new Map<string, FakeResponse>();
  constructor(
    private readonly name: string,
    private readonly log: string[],
  ) {}
  async put(key: unknown, response: FakeResponse) {
    const path = urlOf(key);
    this.log.push(`${this.name} ${path}`);
    this.entries.set(path, response);
  }
  async match(key: unknown) {
    return this.entries.get(urlOf(key));
  }
}

export class FakeCaches {
  stores = new Map<string, FakeCache>();
  /** `<cache name> <path>` of every put ever made */
  puts: string[] = [];
  async open(name: string) {
    let c = this.stores.get(name);
    if (!c) {
      c = new FakeCache(name, this.puts);
      this.stores.set(name, c);
    }
    return c;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
  async has(name: string) {
    return this.stores.has(name);
  }
  paths(name: string) {
    return [...(this.stores.get(name)?.entries.keys() ?? [])];
  }
  /** Every path stored anywhere, plus every put ever made: used to prove nothing of /api was cached. */
  everything() {
    return [
      ...this.puts.map((p) => p.split(' ')[1] as string),
      ...[...this.stores.values()].flatMap((s) => [...s.entries.keys()]),
    ];
  }
}

export interface FakeClient {
  url: string;
  /** what the page answers to "is an exam running?" (undefined = it never answers) */
  busy: boolean | undefined;
  messages: unknown[];
  postMessage(message: unknown, transfer?: MessagePort[]): void;
}

export const client = (busy: boolean | undefined = false): FakeClient => {
  const c: FakeClient = {
    url: `${ORIGIN}/`,
    busy,
    messages: [],
    postMessage(message, transfer) {
      c.messages.push(message);
      if ((message as { type?: string }).type === 'EXAM_BUSY?' && c.busy !== undefined)
        transfer?.[0]?.postMessage(c.busy);
    },
  };
  return c;
};

type Handler = (event: Record<string, unknown>) => void;

export interface Env {
  self: Record<string, unknown>;
  caches: FakeCaches;
  clients: FakeClient[];
  /** the network: path -> response, or a function; `offline` makes every fetch reject */
  routes: Map<string, FakeResponse | ((init?: unknown) => FakeResponse)>;
  offline: boolean;
  fetched: { path: string; init?: unknown }[];
  skipWaiting: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
  fire(type: string, event?: Record<string, unknown>): Promise<unknown[]>;
  /** a fetch event: returns what respondWith got (undefined when the worker did not answer) and the promises of waitUntil */
  fetchEvent(request: {
    url: string;
    method?: string;
    mode?: string;
  }): Promise<{ response: unknown; answered: boolean }>;
  message(data: unknown, source?: { postMessage(m: unknown): void }): Promise<void>;
}

export interface WorkerConfig {
  buildId: string;
  precache: string[];
}

export function createEnv(
  source: string,
  config: WorkerConfig | null,
  opts: { clients?: FakeClient[] } = {},
): Env {
  const handlers = new Map<string, Handler[]>();
  const caches = new FakeCaches();
  const skipWaiting = vi.fn(async () => undefined);
  const unregister = vi.fn(async () => true);
  const env: Env = {
    self: {},
    caches,
    clients: opts.clients ?? [],
    routes: new Map(),
    offline: false,
    fetched: [],
    skipWaiting,
    unregister,
    async fire(type, event = {}) {
      const waits: Promise<unknown>[] = [];
      const ev = { ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) };
      for (const h of handlers.get(type) ?? []) h(ev);
      return Promise.all(waits);
    },
    async fetchEvent(request) {
      const waits: Promise<unknown>[] = [];
      let answered = false;
      let response: unknown;
      const ev = {
        request: { method: 'GET', mode: 'same-origin', ...request },
        waitUntil: (p: Promise<unknown>) => waits.push(p),
        respondWith: (p: Promise<unknown>) => {
          answered = true;
          response = p;
        },
      };
      for (const h of handlers.get('fetch') ?? []) h(ev);
      if (answered)
        response = await (response as Promise<unknown>).catch((e: unknown) => ({ error: e }));
      await Promise.all(waits);
      return { response, answered };
    },
    async message(data, sourceArg) {
      const waits: Promise<unknown>[] = [];
      for (const h of handlers.get('message') ?? [])
        h({ data, source: sourceArg, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    },
  };
  const scope = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, h: Handler) =>
      handlers.set(type, [...(handlers.get(type) ?? []), h]),
    caches,
    skipWaiting,
    registration: { unregister },
    clients: { matchAll: async () => env.clients },
    // no `claim` on purpose: a worker that called clients.claim() would throw in these tests
    fetch: async (input: unknown, init?: unknown) => {
      const path = urlOf(input);
      env.fetched.push({ path, init });
      if (env.offline) throw new TypeError('Failed to fetch');
      const r = env.routes.get(path);
      if (!r) return res('not found', { status: 404 });
      return typeof r === 'function' ? r(init) : r;
    },
  };
  Object.assign(env.self, scope);
  const text = config ? source.replace('__SW_CONFIG__', JSON.stringify(config)) : source;
  new Function('self', text)(scope);
  return env;
}

export const worker = (config: WorkerConfig, opts?: { clients?: FakeClient[] }) =>
  createEnv(workerSource, config, opts);
export const retiringWorker = (opts?: { clients?: FakeClient[] }) =>
  createEnv(retireSource, null, opts);
export { retireSource, workerSource };

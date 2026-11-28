import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { buildApp } from '../app';
import { parseApiEnv } from '../config/env';
import { createLogger } from '../config/logger';
import { createCapturingProvider } from '../core/mail';
import { createDb } from '../db/client';
import { connectionConfig } from '../db/connection';
import { assertDemoTarget } from './guard';

// What the demo commands run on: the OWNER connection (the tenant itself, backdating, removal) and an in-process copy of the
// API with the real routes, job handlers and database role. Nothing needs to be running: no server, no worker.

export interface DemoOptions {
  slug: string;
  /** DATABASE_URL, DATABASE_APP_URL and the rest, as in .env */
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}

export interface DemoState {
  slug: string;
  password: string;
  adminEmail: string;
  /** the TOTP secret of the pre-enrolled administrator (base32), and their one-time recovery codes */
  adminTotpSecret: string;
  adminRecoveryCodes: string[];
}

/** The repository root: the state of a demo college lives in `.demo/` there (git-ignored). */
export function repoRoot(from = process.cwd()): string {
  let dir = from;
  while (!existsSync(join(dir, 'pnpm-workspace.yaml')) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}
export const stateDir = (env: Record<string, string | undefined>) =>
  env.DEMO_STATE_DIR ?? join(repoRoot(), '.demo');
const stateFile = (env: Record<string, string | undefined>, slug: string) =>
  join(stateDir(env), `${slug}.json`);

export function writeState(env: Record<string, string | undefined>, state: DemoState): string {
  mkdirSync(stateDir(env), { recursive: true });
  const file = stateFile(env, state.slug);
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return file;
}
export function readState(env: Record<string, string | undefined>, slug: string): DemoState | null {
  const file = stateFile(env, slug);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as DemoState) : null;
}

/** The guard first, then the owner connection. Every demo command goes through here before it touches anything. */
export async function openOwner(opts: DemoOptions): Promise<pg.Client> {
  const env = opts.env ?? process.env;
  assertDemoTarget(opts.slug, [env.DATABASE_URL, env.DATABASE_APP_URL], env);
  const client = new pg.Client(
    connectionConfig(
      env.DATABASE_URL as string,
      (env.DB_SSL ?? 'off') as 'off' | 'no-verify' | 'verify-full',
      env.DB_SSL_CA,
    ),
  );
  await client.connect();
  return client;
}

export interface Response {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: the demo reads the API's JSON answers field by field
  json: any;
  text: string;
}

/** One signed-in person's browser, in process. */
export class Browser {
  private cookies = new Map<string, string>();
  constructor(
    private readonly app: ReturnType<typeof buildApp>,
    readonly host: string,
  ) {}

  async send(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const res = await this.app.inject({
      method,
      url,
      headers: {
        host: this.host,
        origin: `http://${this.host}`,
        'x-requested-with': 'lms',
        ...(this.cookies.size
          ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
          : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: body as object }),
    });
    for (const c of res.cookies) {
      if (c.value) this.cookies.set(c.name, c.value);
      else this.cookies.delete(c.name);
    }
    let json: unknown = null;
    try {
      json = res.json();
    } catch {
      // not JSON (a file, an empty answer)
    }
    return { status: res.statusCode, json, text: res.body };
  }

  /** An application route (`/api` is added); anything but a 2xx stops the command with the server's words. */
  private async must(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown) {
    const res = await this.send(method, `/api${path}`, body);
    if (res.status >= 300) {
      throw new Error(`${method} ${path} -> ${res.status} ${res.text.slice(0, 300)}`);
    }
    return res.json;
  }
  get = (path: string) => this.must('GET', path);
  post = (path: string, body: unknown = {}) => this.must('POST', path, body);
  put = (path: string, body: unknown) => this.must('PUT', path, body);
  patch = (path: string, body: unknown) => this.must('PATCH', path, body);

  async signIn(email: string, password: string): Promise<Response> {
    const res = await this.send('POST', '/api/auth/login', { email, password });
    if (res.status !== 200 && res.status !== 202) {
      throw new Error(`sign-in of ${email} failed: ${res.status} ${res.text.slice(0, 200)}`);
    }
    return res;
  }
}

export async function openRuntime(opts: DemoOptions) {
  const source = opts.env ?? process.env;
  const env = parseApiEnv({
    ...source,
    // this in-process copy signs in dozens of people from one "address": its own limits are wide, in memory. The running API
    // keeps its own configuration. Two-step sign-in stays as configured: enforcement is never switched off here.
    LOG_LEVEL: 'silent',
    RATE_LIMIT_STORE: 'memory',
    RATE_LIMIT_MAX: '1000000',
    RATE_LIMIT_LOGIN_PER_IP: '100000',
    RATE_LIMIT_LOGIN_FAILURES_PER_IP: '100000',
    RATE_LIMIT_LOGIN_PER_EMAIL: '100000',
    RATE_LIMIT_AUTH_PER_IP: '100000',
  });
  const db = createDb({
    url: env.DATABASE_APP_URL,
    ssl: env.DB_SSL,
    sslCa: env.DB_SSL_CA,
    max: 5,
    connectionTimeoutMs: 20_000,
    applicationName: 'lms-demo',
  });
  const mail = createCapturingProvider();
  const app = buildApp({ env, db, logger: createLogger(env), emailProvider: mail });
  await app.ready();
  const worker = `demo-${randomBytes(4).toString('hex')}`;
  const domain = env.APP_BASE_DOMAIN;
  const port = env.APP_PUBLIC_PORT ?? 5173;
  const host = `${opts.slug}.${domain}:${port}`;

  /**
   * Runs the queued jobs of THIS college through the real handlers, as the worker would. A job of another college (or a system
   * job) is handed back unrun, so a developer's own queued mail is never swallowed by the capturing provider here.
   */
  async function drain(tenantId: string, queues: string[]): Promise<void> {
    await app.modules.background.drain();
    const jobs = app.modules.jobs.service;
    for (const queue of queues) {
      const handler = app.modules.handlers[queue];
      if (!handler) throw new Error(`no handler for ${queue}`);
      for (let round = 0; round < 1000; round++) {
        const claimed = await jobs.claim(queue, worker, 20);
        if (claimed.length === 0) break;
        for (const job of claimed) {
          if (job.tenantId !== tenantId) {
            await jobs.defer(job.id, worker, 30);
            continue;
          }
          try {
            const result = await handler.run(job.payload, {
              jobId: job.id,
              queue,
              tenantId: job.tenantId,
              attempt: job.attempts,
              maxAttempts: job.maxAttempts,
              signal: new AbortController().signal,
            });
            await jobs.complete(job.id, worker, result ?? null);
          } catch (err) {
            await jobs.fail(job.id, worker, err instanceof Error ? err.message : String(err));
            throw err;
          }
        }
      }
    }
  }

  return {
    env,
    app,
    mail,
    host,
    url: `http://${host}`,
    drain,
    browser: () => new Browser(app, host),
    async close(): Promise<void> {
      await app.modules.background.drain();
      await app.close();
      await db.close();
    },
  };
}

export type DemoRuntime = Awaited<ReturnType<typeof openRuntime>>;

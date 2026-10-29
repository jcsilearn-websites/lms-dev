import type pg from 'pg';
import pino from 'pino';
import type { HandlerMap } from '../src/core/handlers';
import { createJobRunner, type JobsConfig } from '../src/modules/jobs';
import type { TestApp } from './app';
import type { TestClient } from './client';

// Shared helpers of the import tests: build a CSV, upload it as multipart, run the job queue.

export const STUDENT_HEADER =
  'email,full_name,register_number,department_code,program_code,batch,section';
export const FACULTY_HEADER = 'email,full_name,employee_id,department_code';

export function csv(header: string, rows: readonly (readonly string[])[], eol = '\r\n'): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [header, ...rows.map((r) => r.map(cell).join(','))].join(eol) + eol;
}

/** POST /imports?kind=... as a browser would: multipart/form-data with the file in the field "file". */
export function upload(
  c: TestClient,
  kind: string,
  content: string | Buffer,
  opts: { fileName?: string; contentType?: string; field?: string } = {},
) {
  const boundary = `----lmsBoundary${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${opts.field ?? 'file'}"; filename="${opts.fileName ?? 'import.csv'}"\r\nContent-Type: ${opts.contentType ?? 'text/csv'}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([
    head,
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    tail,
  ]);
  return c.request('POST', '/imports', {
    query: `kind=${kind}`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

/** A job runner over the app's REAL modules (real handlers, capturing mailer): a stand-in for the worker. */
export function startRunner(
  t: TestApp,
  opts: {
    queues?: string[];
    config?: Partial<JobsConfig>;
    workerId?: string;
    handlers?: HandlerMap;
  } = {},
) {
  const all = opts.handlers ?? t.app.modules.handlers;
  const handlers: HandlerMap = opts.queues
    ? Object.fromEntries(opts.queues.map((q) => [q, all[q] as never]))
    : all;
  const jobs = t.app.modules.jobs.service;
  const runner = createJobRunner({
    jobs,
    handlers,
    config: {
      ...jobs.config,
      pollIntervalMs: 30,
      pollMaxIntervalMs: 150,
      leaseSeconds: 30,
      concurrency: { default: 2, 'imports.process': 1, 'invites.send': 4 },
      ...opts.config,
    },
    workerId: opts.workerId ?? `test-runner-${Math.random().toString(16).slice(2, 8)}`,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  runner.start();
  return runner;
}

export const silentLogger = pino({ level: 'silent' });

export async function waitFor<T>(
  fn: () => Promise<T | false | undefined | null>,
  ms = 60_000,
  every = 100,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, every));
  }
}

export async function count(owner: pg.Pool, sql: string, params: unknown[] = []): Promise<number> {
  return (await owner.query(sql, params)).rows[0].n as number;
}

const TERMINAL = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);
/** Waits until the import reaches a terminal status; returns its JSON. */
export async function waitForImport(c: TestClient, id: string, ms = 120_000) {
  return waitFor(
    async () => {
      const res = await c.get(`/imports/${id}`);
      const j = res.json();
      return TERMINAL.has(j.status) ? j : false;
    },
    ms,
    200,
  );
}

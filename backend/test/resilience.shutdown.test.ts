import http from 'node:http';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { makeApp } from './app';
import { TestClient } from './client';
import {
  type AuthFixture,
  createAuthFixture,
  TEST_PASSWORD,
  testAppDbOptions,
  testOwnerPool,
} from './support';

// Step 14a: the API is shut down WHILE it serves traffic (what a deploy or a scale-in does). It runs the same two steps as
// server.ts: app.close() (stop accepting, let in-flight requests finish, run the onClose hooks) and then db.close() (end the pool).
// The signal itself cannot be delivered on Windows; the process-level SIGTERM path is test/shutdown.test.ts (Linux / CI).

let owner: pg.Pool;
let A: AuthFixture;

beforeAll(async () => {
  owner = testOwnerPool();
  A = await createAuthFixture(owner, 'res-d');
});
afterAll(async () => {
  await owner.end();
});

interface Outcome {
  status?: number;
  complete?: boolean;
  error?: string;
}

function get(port: number, cookie: string, agent: http.Agent): Promise<Outcome> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/auth/me',
        method: 'GET',
        agent,
        headers: { host: A.host, cookie },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let complete = false;
          try {
            complete =
              typeof JSON.parse(Buffer.concat(chunks).toString()).user?.id === 'string' ||
              res.statusCode !== 200;
          } catch {
            complete = false;
          }
          resolve({ status: res.statusCode ?? 0, complete });
        });
        res.on('error', (e) => resolve({ error: e.message }));
      },
    );
    req.on('error', (e) => resolve({ error: (e as NodeJS.ErrnoException).code ?? e.message }));
    req.end();
  });
}

describe('API shutdown under load', () => {
  it('in-flight requests complete in full, new connections are refused, the pool closes, nothing is left unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);

    const db = createDb({ ...testAppDbOptions(4) });
    const t = makeApp({ db });
    await t.app.ready();
    // sign in through inject, then use the session cookie over real HTTP
    const c = new TestClient(t, A.host);
    expect((await c.login(A.memberEmail, TEST_PASSWORD)).statusCode).toBe(200);
    const cookie = [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (t.app.server.address() as { port: number }).port;

    const agent = new http.Agent({ keepAlive: true, maxSockets: 40 });
    const outcomes: Outcome[] = [];
    let stop = false;
    const loop = async () => {
      while (!stop) {
        outcomes.push(await get(port, cookie, agent));
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const loops = Array.from({ length: 24 }, () => loop());
    await new Promise((r) => setTimeout(r, 800));
    const beforeClose = outcomes.length;
    expect(beforeClose).toBeGreaterThan(20);

    // the shutdown sequence of server.ts
    const started = Date.now();
    await t.app.close();
    await db.close();
    const closeMs = Date.now() - started;
    await new Promise((r) => setTimeout(r, 300));
    stop = true;
    await Promise.all(loops);
    agent.destroy();
    process.off('unhandledRejection', onUnhandled);

    expect(closeMs).toBeLessThan(5000);
    // every request that got an answer got a COMPLETE one: no truncated body, no 500
    const answered = outcomes.filter((o) => o.status !== undefined);
    expect(answered.length).toBeGreaterThan(beforeClose - 1);
    expect(answered.every((o) => o.complete)).toBe(true);
    // a request that arrives on a kept-alive connection while the server is closing gets Fastify's clean 503 (retryable), never a 500
    expect(answered.filter((o) => (o.status ?? 0) >= 500 && o.status !== 503)).toEqual([]);
    // after the close the only failures are refused / reset connections (the load balancer has stopped sending traffic by then)
    const failures = outcomes.filter((o) => o.error);
    expect(
      failures.every((o) => /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/.test(o.error ?? '')),
    ).toBe(true);
    expect(unhandled).toEqual([]);
    // the pool is really closed (a second close would throw: pg-pool refuses a closed pool)
    await expect(db.ping(500)).rejects.toBeTruthy();
  }, 30_000);
});

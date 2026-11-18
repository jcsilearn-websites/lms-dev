import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../src/db/client';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import { type FaultProxy, startFaultProxy } from './fault-proxy';
import {
  type AuthFixture,
  createAuthFixture,
  getTestDatabases,
  TEST_PASSWORD,
  testAppDbOptions,
  testOwnerPool,
} from './support';

// Step 14a: PostgreSQL goes away under traffic (a restart, a failover, a hung network). A fault-injection TCP proxy sits between the
// API and the database; it resets every connection and refuses new ones for a while. The API must answer 503 + Retry-After (never a
// 500, never a hang), recover on its own as soon as the database is back, and leave no corrupted state: every write is ALL of its
// rows or none (each invite is one membership + one audit row + one outbox row, never a part).

let owner: pg.Pool;
let A: AuthFixture;
let proxy: FaultProxy;
let db: Database;
let t: TestApp;
let admin: TestClient;
const apps: TestApp[] = [];

function proxiedUrl(): string {
  const u = new URL(getTestDatabases().appUrl);
  u.hostname = '127.0.0.1';
  u.port = String(proxy.port);
  return u.toString();
}

beforeAll(async () => {
  owner = testOwnerPool();
  A = await createAuthFixture(owner, 'res-p');
  const real = new URL(getTestDatabases().appUrl);
  proxy = await startFaultProxy({
    host: real.hostname === 'localhost' ? '127.0.0.1' : real.hostname,
    port: Number(real.port || 5432),
  });
  db = createDb({
    ...testAppDbOptions(4),
    url: proxiedUrl(),
    connectionTimeoutMs: 3000,
    queryTimeoutMs: 1500,
  });
  t = makeApp({ db });
  apps.push(t);
  await t.app.ready();
  admin = new TestClient(t, A.host);
  expect((await admin.login(A.adminEmail, TEST_PASSWORD)).statusCode).toBe(200);
});
afterAll(async () => {
  for (const a of apps) await a.close();
  await proxy.close();
  await owner.end();
});

interface Sample {
  status: number;
  startedAt: number;
  ms: number;
  kind: 'read' | 'write' | 'ready';
  email?: string;
}

describe('PostgreSQL restarts under traffic', () => {
  it('answers 503 (never 500, never a hang) while it is down, recovers by itself, and leaves no partial writes', async () => {
    const samples: Sample[] = [];
    const t0 = Date.now();
    const DURATION = 7000;
    let n = 0;

    const worker = async (id: number) => {
      while (Date.now() - t0 < DURATION) {
        const kind = (['read', 'write', 'ready'] as const)[(n++ + id) % 3] as Sample['kind'];
        const startedAt = Date.now();
        let status: number;
        let email: string | undefined;
        if (kind === 'read') status = (await admin.get('/auth/me')).statusCode;
        else if (kind === 'ready')
          status = (await t.app.inject({ method: 'GET', url: '/health/ready' })).statusCode;
        else {
          email = `chaos${id}-${n}@res-p.test`;
          status = (await admin.post('/auth/invites', { email, role: 'member' })).statusCode;
        }
        samples.push({
          status,
          startedAt: startedAt - t0,
          ms: Date.now() - startedAt,
          kind,
          ...(email ? { email } : {}),
        });
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    // the database is "restarted" at 1.5 s: every connection reset, new ones refused for 2 s
    const chaos = (async () => {
      await new Promise((r) => setTimeout(r, 1500));
      await proxy.refuseFor(2000);
    })();
    await Promise.all([chaos, ...Array.from({ length: 6 }, (_, i) => worker(i))]);

    const statuses = new Set(samples.map((s) => s.status));
    // only success and "try again": no 500, and no 401 (a failed session lookup is not "not signed in")
    expect([...statuses].filter((s) => ![200, 201, 503].includes(s))).toEqual([]);
    const failed = samples.filter((s) => s.status === 503);
    expect(failed.length).toBeGreaterThan(0); // the outage was seen
    // nothing hung: a request is answered within the connection / statement deadlines
    expect(Math.max(...samples.map((s) => s.ms))).toBeLessThan(6500);
    // recovery: requests succeed again after the outage window (1.5 s + 2 s), within a few seconds of it ending
    const afterOutage = samples.filter((s) => s.startedAt > 3500 && s.status !== 503);
    expect(afterOutage.length).toBeGreaterThan(10);
    const firstGood = Math.min(...afterOutage.map((s) => s.startedAt));
    expect(firstGood).toBeLessThan(3500 + 3500);
    // readiness reported the outage and the recovery
    expect(samples.some((s) => s.kind === 'ready' && s.status === 503)).toBe(true);
    expect(samples.filter((s) => s.kind === 'ready').at(-1)?.status).toBe(200);
    // the pool is not leaking: nobody is still waiting for a connection
    expect(db.stats().waiting).toBe(0);

    // NO CORRUPTED STATE. A write whose answer was lost may or may not have committed, but whatever committed is complete.
    const emails = samples.filter((s) => s.kind === 'write').map((s) => s.email as string);
    const members = await owner.query<{ id: string; email: string }>(
      `SELECT m.id, u.email FROM lms.tenant_memberships m JOIN lms.users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND u.email = ANY($2::text[])`,
      [A.tenantId, emails],
    );
    const ok = new Set(
      samples.filter((s) => s.kind === 'write' && s.status === 201).map((s) => s.email),
    );
    for (const e of ok)
      expect(
        members.rows.map((r) => r.email),
        `${e} answered 201 but is missing`,
      ).toContain(e);
    const ids = members.rows.map((r) => r.id);
    const audit = await owner.query<{ target_id: string; n: string }>(
      `SELECT target_id::text, count(*)::text AS n FROM lms.audit_log
        WHERE tenant_id = $1 AND action = 'auth.invite_created' AND target_id = ANY($2::text[]) GROUP BY target_id`,
      [A.tenantId, ids],
    );
    const outbox = await owner.query<{ membership: string; n: string }>(
      `SELECT params ->> 'membershipId' AS membership, count(*)::text AS n FROM lms.email_outbox
        WHERE tenant_id = $1 AND template = 'invite' AND params ->> 'membershipId' = ANY($2::text[]) GROUP BY 1`,
      [A.tenantId, ids],
    );
    expect(audit.rows).toHaveLength(ids.length); // one audit row per membership that exists
    expect(audit.rows.every((r) => r.n === '1')).toBe(true);
    expect(outbox.rows).toHaveLength(ids.length); // and one queued invite email
    expect(outbox.rows.every((r) => r.n === '1')).toBe(true);
    // and no audit row of a membership that was rolled back
    const orphans = await owner.query(
      `SELECT a.target_id FROM lms.audit_log a
        WHERE a.tenant_id = $1 AND a.action = 'auth.invite_created'
          AND a.created_at > now() - interval '5 minutes'
          AND NOT EXISTS (SELECT 1 FROM lms.tenant_memberships m WHERE m.id::text = a.target_id)`,
      [A.tenantId],
    );
    expect(orphans.rows).toEqual([]);
  }, 30_000);

  it('a hung network (the server stops answering, no reset) is cut at the statement deadline: 503 within seconds, then recovery', async () => {
    const fresh = await admin.get('/auth/me');
    expect(fresh.statusCode).toBe(200);
    proxy.blackhole();
    const started = Date.now();
    const res = await admin.get('/auth/me');
    const took = Date.now() - started;
    expect(res.statusCode, res.body).toBe(503);
    expect(res.headers['retry-after']).toBeDefined();
    expect(took).toBeLessThan(6000);
    proxy.resume();
    // recovery: the dead connections were discarded, new ones go through
    let code = 0;
    for (let i = 0; i < 20 && code !== 200; i++) {
      code = (await admin.get('/auth/me')).statusCode;
      if (code !== 200) await new Promise((r) => setTimeout(r, 250));
    }
    expect(code).toBe(200);
    expect(db.stats().waiting).toBe(0);
  }, 30_000);
});

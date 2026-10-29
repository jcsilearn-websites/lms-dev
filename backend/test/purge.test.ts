import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { makeApp, type TestApp } from './app';
import { expectPgError, SQLSTATE } from './helpers';
import { type AuthFixture, createAuthFixture, testAppPool, testOwnerPool } from './support';

let owner: pg.Pool;
let app: pg.Pool;
let t: TestApp;
let A: AuthFixture;

beforeAll(async () => {
  owner = testOwnerPool();
  app = testAppPool();
  t = makeApp();
  A = await createAuthFixture(owner, 'purge-a');
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
  await app.end();
  await owner.end();
});

/** Inserts a session with explicit lifecycle timestamps (relative to now, in days). */
async function session(opts: {
  revokedDaysAgo?: number;
  idleExpiredDaysAgo?: number;
  absoluteExpiredDaysAgo?: number;
}) {
  const id = newId();
  const day = (d: number) => `now() - interval '${d} days'`;
  await owner.query(
    `INSERT INTO lms.sessions (id, token_hash, user_id, tenant_id, idle_expires_at, absolute_expires_at, revoked_at)
     VALUES ($1, $2, $3, $4,
       ${opts.idleExpiredDaysAgo !== undefined ? day(opts.idleExpiredDaysAgo) : "now() + interval '1 day'"},
       ${opts.absoluteExpiredDaysAgo !== undefined ? day(opts.absoluteExpiredDaysAgo) : "now() + interval '2 days'"},
       ${opts.revokedDaysAgo !== undefined ? day(opts.revokedDaysAgo) : 'NULL'})`,
    [id, randomBytes(32), A.memberUserId, A.tenantId],
  );
  return id;
}

async function token(opts: { usedDaysAgo?: number; expiredDaysAgo?: number }) {
  const id = newId();
  await owner.query(
    `INSERT INTO lms.auth_tokens (id, purpose, token_hash, user_id, expires_at, used_at)
     VALUES ($1, 'password_reset', $2, $3, ${opts.expiredDaysAgo !== undefined ? `now() - interval '${opts.expiredDaysAgo} days'` : "now() + interval '1 day'"},
       ${opts.usedDaysAgo !== undefined ? `now() - interval '${opts.usedDaysAgo} days'` : 'NULL'})`,
    [id, randomBytes(32), A.memberUserId],
  );
  return id;
}

const exists = async (table: 'sessions' | 'auth_tokens', id: string) =>
  ((await owner.query(`SELECT 1 FROM lms.${table} WHERE id = $1`, [id])).rowCount ?? 0) > 0;

describe('session purge', () => {
  it('deletes sessions that died longer ago than the retention period, and nothing else', async () => {
    const old = [
      await session({ revokedDaysAgo: 40 }),
      await session({ idleExpiredDaysAgo: 40 }),
      await session({ absoluteExpiredDaysAgo: 40 }),
    ];
    const keep = [
      await session({}), // live
      await session({ revokedDaysAgo: 1 }), // revoked, but inside the retention window
      await session({ idleExpiredDaysAgo: 29 }), // expired, inside the window
    ];
    const deleted = await t.app.modules.sessions.service.purgeDead({
      retentionDays: 30,
      batchSize: 100,
    });
    expect(deleted).toBeGreaterThanOrEqual(3);
    for (const id of old) expect(await exists('sessions', id), 'old session purged').toBe(false);
    for (const id of keep)
      expect(await exists('sessions', id), 'recent/live session kept').toBe(true);
  });

  it('deletes in bounded batches: one call never removes more than the batch size', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await session({ revokedDaysAgo: 60 }));
    const first = await t.app.modules.sessions.service.purgeDead({
      retentionDays: 30,
      batchSize: 2,
      maxBatches: 1,
    });
    expect(first).toBe(2);
    const remaining = (
      await owner.query('SELECT count(*)::int AS n FROM lms.sessions WHERE id = ANY($1)', [ids])
    ).rows[0].n;
    expect(remaining).toBe(3);
    const rest = await t.app.modules.sessions.service.purgeDead({
      retentionDays: 30,
      batchSize: 2,
    });
    expect(rest).toBeGreaterThanOrEqual(3); // loops batch by batch until a short batch
    expect(
      (await owner.query('SELECT 1 FROM lms.sessions WHERE id = ANY($1)', [ids])).rowCount,
    ).toBe(0);
  });

  it('a live session keeps working while purges run', async () => {
    const { TestClient } = await import('./client');
    const c = new TestClient(t, A.host);
    expect((await c.login(A.memberEmail, 'correct-horse-battery-staple')).statusCode).toBe(200);
    await t.app.modules.sessions.service.purgeDead({ retentionDays: 0, batchSize: 100 });
    expect((await c.get('/auth/me')).statusCode).toBe(200);
  });
});

describe('auth token purge', () => {
  it('deletes used and expired tokens older than the retention period; keeps recent and live ones', async () => {
    const old = [await token({ usedDaysAgo: 40 }), await token({ expiredDaysAgo: 40 })];
    const keep = [
      await token({}),
      await token({ usedDaysAgo: 2 }),
      await token({ expiredDaysAgo: 3 }),
    ];
    const deleted = await t.app.modules.auth.service.purgeTokens({
      retentionDays: 30,
      batchSize: 100,
    });
    expect(deleted).toBeGreaterThanOrEqual(2);
    for (const id of old) expect(await exists('auth_tokens', id)).toBe(false);
    for (const id of keep) expect(await exists('auth_tokens', id)).toBe(true);
  });

  it('is bounded by the batch size too', async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await token({ expiredDaysAgo: 90 }));
    expect(
      await t.app.modules.auth.service.purgeTokens({
        retentionDays: 30,
        batchSize: 3,
        maxBatches: 1,
      }),
    ).toBe(3);
    expect(
      (await owner.query('SELECT 1 FROM lms.auth_tokens WHERE id = ANY($1)', [ids])).rowCount,
    ).toBe(1);
    await t.app.modules.auth.service.purgeTokens({ retentionDays: 30, batchSize: 3 });
  });
});

describe('handlers and permissions', () => {
  it('the worker handler map exposes both purge handlers with the configured interval', async () => {
    const { handlers } = t.app.modules;
    for (const name of ['sessions.purge_dead', 'auth.purge_tokens']) {
      expect(handlers[name]?.everyMs, name).toBe(3_600_000);
    }
    await session({ revokedDaysAgo: 45 });
    const result = await handlers['sessions.purge_dead']?.run(undefined, {} as never);
    expect(result).toMatchObject({ deleted: expect.any(Number) });
    expect((result as { deleted: number }).deleted).toBeGreaterThanOrEqual(1);
  });

  it('lms_app cannot DELETE these tables directly: only the bounded definer functions can', async () => {
    await expectPgError(app.query('DELETE FROM lms.sessions'), SQLSTATE.insufficientPrivilege);
    await expectPgError(app.query('DELETE FROM lms.auth_tokens'), SQLSTATE.insufficientPrivilege);
    const viaFunction = await app.query('SELECT lms.auth_purge_sessions(36500, 1) AS n');
    expect(viaFunction.rows[0].n).toBe(0); // nothing is that old, and at most 1 row could ever be removed
  });

  it('the batch size is clamped inside the database, whatever the caller passes', async () => {
    for (let i = 0; i < 3; i++) await token({ expiredDaysAgo: 90 });
    const r = await app.query('SELECT lms.auth_purge_tokens(30, -5) AS n'); // nonsense batch -> 1
    expect(r.rows[0].n).toBe(1);
    await t.app.modules.auth.service.purgeTokens({ retentionDays: 30, batchSize: 100 });
  });
});

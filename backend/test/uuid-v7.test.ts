import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testAppPool, testOwnerPool } from './support';

// lms.uuid_v7(): a portable RFC 9562 UUIDv7 made in SQL (no PostgreSQL 18 uuidv7()).

let owner: pg.Pool;
let app: pg.Pool;
beforeAll(() => {
  owner = testOwnerPool();
  app = testAppPool();
});
afterAll(async () => {
  await owner.end();
  await app.end();
});

const RFC9562_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const timeOf = (id: string) => Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);

describe('lms.uuid_v7()', () => {
  it('makes valid RFC 9562 version 7 ids (version nibble 7, variant 10xx), as the app role', async () => {
    const { rows } = await app.query<{ id: string }>(
      'SELECT lms.uuid_v7()::text AS id FROM generate_series(1, 2000)',
    );
    expect(rows).toHaveLength(2000);
    for (const r of rows) expect(r.id).toMatch(RFC9562_V7);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2000);
  });

  it('embeds the current unix time in milliseconds', async () => {
    const before = Date.now();
    const { rows } = await owner.query<{ id: string }>('SELECT lms.uuid_v7()::text AS id');
    const after = Date.now();
    const ms = timeOf(rows[0]?.id as string);
    expect(ms).toBeGreaterThanOrEqual(before - 2000); // the database clock may differ a little from Node's
    expect(ms).toBeLessThanOrEqual(after + 2000);
  });

  it('is time-ordered: ids made one after another sort in creation order, inside one statement and across time', async () => {
    const { rows } = await owner.query<{ id: string }>(
      'SELECT lms.uuid_v7()::text AS id FROM generate_series(1, 3000)',
    );
    // timestamp + version + sub-millisecond bits (the first 64 bits) never go backwards
    const heads = rows.map((r) => r.id.replace(/-/g, '').slice(0, 16));
    for (let i = 1; i < heads.length; i++)
      expect((heads[i] as string) >= (heads[i - 1] as string), `row ${i}`).toBe(true);
    const a = (await owner.query<{ id: string }>('SELECT lms.uuid_v7()::text AS id')).rows[0]
      ?.id as string;
    await owner.query('SELECT pg_sleep(0.01)');
    const b = (await owner.query<{ id: string }>('SELECT lms.uuid_v7()::text AS id')).rows[0]
      ?.id as string;
    expect(b > a).toBe(true);
    // and an index on them keeps insertion order (the point of v7 as a primary key)
    const sorted = [...rows.map((r) => r.id)].sort();
    expect(sorted.map((x) => x.replace(/-/g, '').slice(0, 16))).toEqual(heads);
  });

  it('is hardened: pinned search_path, executable by lms_app only', async () => {
    const { rows } = await owner.query<{ config: string[]; acl: string[] }>(
      `SELECT p.proconfig AS config,
              COALESCE((SELECT array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)
                          FROM aclexplode(p.proacl) a), '{}') AS acl
         FROM pg_proc p WHERE p.pronamespace = 'lms'::regnamespace AND p.proname = 'uuid_v7'`,
    );
    expect(rows[0]?.config).toContain('search_path=pg_catalog, pg_temp');
    expect(rows[0]?.acl).toContain('lms_app');
    expect(rows[0]?.acl).not.toContain('PUBLIC');
  });
});

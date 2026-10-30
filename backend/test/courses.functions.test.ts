import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { expectPgError, SQLSTATE } from './helpers';
import { type AuthFixture, createAuthFixture, testAppPool, testOwnerPool } from './support';

// The Step 6 database functions (migrations 0016-0019): hardening, grants, tenant isolation of the sync
// marker, the file purge, and the fractional ordering keys.

let owner: pg.Pool;
let app: pg.Pool;
let A: AuthFixture;
let B: AuthFixture;

beforeAll(async () => {
  owner = testOwnerPool();
  app = testAppPool();
  A = await createAuthFixture(owner, 'cf-a');
  B = await createAuthFixture(owner, 'cf-b');
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

/** Runs `fn` on one lms_app connection inside a transaction with the tenant context of `tenantId`. */
async function asTenant<T>(
  tenantId: string | null,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    if (tenantId) await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

describe('hardening of the step 6 functions', () => {
  it('files_purge is SECURITY DEFINER, owner-owned, with a pinned search_path, executable by lms_app only', async () => {
    const { rows } = await owner.query<{
      prosecdef: boolean;
      config: string[];
      owner: string;
      acl: string[];
    }>(
      `SELECT p.prosecdef, p.proconfig AS config, r.rolname AS owner,
              COALESCE((SELECT array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)
                          FROM aclexplode(p.proacl) a), '{}') AS acl
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.pronamespace = 'lms'::regnamespace AND p.proname = 'files_purge'`,
    );
    expect(rows).toHaveLength(1);
    const f = rows[0];
    const me = (await owner.query<{ current_user: string }>('SELECT current_user')).rows[0]
      ?.current_user;
    expect(f?.prosecdef).toBe(true);
    expect(f?.owner).toBe(me);
    expect(f?.config).toContain('search_path=lms, pg_temp');
    expect(f?.acl).toContain('lms_app');
    expect(f?.acl).not.toContain('PUBLIC');
    expect(f?.acl).not.toContain('anon');
    expect(f?.acl).not.toContain('authenticated');
  });

  it('the trigger and helper functions are not callable by PUBLIC; the marker is callable by lms_app only', async () => {
    const { rows } = await owner.query<{ proname: string; acl: string[] }>(
      `SELECT p.proname,
              COALESCE((SELECT array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)
                          FROM aclexplode(p.proacl) a), '{}') AS acl
         FROM pg_proc p
        WHERE p.pronamespace = 'lms'::regnamespace
          AND p.proname IN ('course_sync_mark', 'course_sync_on_profile_insert', 'course_sync_on_profile_update',
                            'course_sync_on_membership_update', 'course_archive_guard', 'offering_parent_guard',
                            'content_file_unref_on_delete', 'content_file_unref_on_update',
                            'position_between', 'position_midpoint')`,
    );
    expect(rows.map((r) => r.proname).sort()).toHaveLength(10);
    for (const r of rows) {
      expect(r.acl, r.proname).not.toContain('PUBLIC');
      expect(r.acl, r.proname).not.toContain('anon');
      expect(r.acl, r.proname).not.toContain('authenticated');
    }
  });

  it('lms_app has no DELETE on files, courses, offerings, participants; and cannot rewrite identity columns', async () => {
    for (const table of ['files', 'courses', 'course_offerings', 'course_participants']) {
      const { rows } = await owner.query<{ ok: boolean }>(
        "SELECT has_table_privilege('lms_app', $1, 'DELETE') AS ok",
        [`lms.${table}`],
      );
      expect(rows[0]?.ok, table).toBe(false);
    }
    // tenant_id, id, code ... are not updatable columns
    for (const [table, column] of [
      ['courses', 'tenant_id'],
      ['courses', 'code'],
      ['courses', 'origin'],
      ['course_offerings', 'course_id'],
      ['course_offerings', 'term_id'],
      ['course_participants', 'membership_id'],
      ['course_participants', 'offering_id'],
      ['files', 'storage_key'],
      ['files', 'created_by'],
      ['content_items', 'tenant_id'],
      ['content_items', 'offering_id'],
    ] as const) {
      const { rows } = await owner.query<{ ok: boolean }>(
        "SELECT has_column_privilege('lms_app', $1, $2, 'UPDATE') AS ok",
        [`lms.${table}`, column],
      );
      expect(rows[0]?.ok, `${table}.${column}`).toBe(false);
    }
  });
});

describe('the enrolment marker', () => {
  it('cannot mark another college, and cannot run without a college', async () => {
    const mine = A.memberMembershipId;
    const theirs = B.memberMembershipId;
    // own college: fine
    await asTenant(A.tenantId, (c) =>
      c.query('SELECT lms.course_sync_mark($1::uuid[], $2::uuid[])', [[A.tenantId], [mine]]),
    );
    // a row for ANOTHER college is refused by the row-level security policy of the table
    await expectPgError(
      asTenant(A.tenantId, (c) =>
        c.query('SELECT lms.course_sync_mark($1::uuid[], $2::uuid[])', [[B.tenantId], [theirs]]),
      ),
      SQLSTATE.insufficientPrivilege,
    );
    // no tenant context at all: nothing can be inserted
    await expectPgError(
      asTenant(null, (c) =>
        c.query('SELECT lms.course_sync_mark($1::uuid[], $2::uuid[])', [[A.tenantId], [mine]]),
      ),
      SQLSTATE.insufficientPrivilege,
    );
    await owner.query('DELETE FROM lms.course_sync_pending WHERE tenant_id = $1', [A.tenantId]);
    await owner.query("DELETE FROM lms.jobs WHERE tenant_id = $1 AND queue = 'courses.sync'", [
      A.tenantId,
    ]);
  });
});

describe('files_purge', () => {
  const insertFile = async (
    tenantId: string,
    hoursOld: number,
    status: 'pending' | 'ready' = 'ready',
  ) => {
    const id = newId();
    await owner.query(
      `INSERT INTO lms.files (id, tenant_id, storage_key, original_name, content_type, declared_size,
                              size_bytes, sha256, status, created_by, created_at, confirmed_at)
       VALUES ($1, $2, $3, 'a.pdf', 'application/pdf', 10, $4, $5, $6, $7,
               now() - make_interval(hours => $8::int), $9)`,
      [
        id,
        tenantId,
        `${tenantId}/${id}`,
        status === 'ready' ? 10 : null,
        status === 'ready' ? 'a'.repeat(64) : null,
        status,
        A.adminUserId,
        hoursOld,
        status === 'ready' ? new Date(Date.now() - hoursOld * 3_600_000) : null,
      ],
    );
    return id;
  };

  it('returns the keys of old unreferenced files only, across colleges, and keeps young ones', async () => {
    const oldA = await insertFile(A.tenantId, 48);
    const oldB = await insertFile(B.tenantId, 48);
    const young = await insertFile(A.tenantId, 1);
    const pendingOld = await insertFile(A.tenantId, 48, 'pending');
    const { rows } = await app.query<{ storage_key: string }>(
      "SELECT storage_key FROM lms.files_purge(interval '24 hours', 100)",
    );
    const keys = rows.map((r) => r.storage_key);
    expect(keys).toContain(`${A.tenantId}/${oldA}`);
    expect(keys).toContain(`${B.tenantId}/${oldB}`);
    expect(keys).toContain(`${A.tenantId}/${pendingOld}`);
    expect(keys).not.toContain(`${A.tenantId}/${young}`);
    const left = await owner.query('SELECT id FROM lms.files WHERE id = ANY($1::uuid[])', [
      [oldA, oldB, young, pendingOld],
    ]);
    expect(left.rows.map((r) => r.id)).toEqual([young]);
  });

  it('does not depend on the caller search_path (hijack attempt)', async () => {
    const id = await insertFile(A.tenantId, 48);
    const c = await app.connect();
    try {
      await c.query('SET search_path = pg_temp');
      await c.query('CREATE TEMP TABLE files (storage_key text)');
      const { rows } = await c.query<{ storage_key: string }>(
        "SELECT storage_key FROM lms.files_purge(interval '24 hours', 100)",
      );
      expect(rows.map((r) => r.storage_key)).toContain(`${A.tenantId}/${id}`);
    } finally {
      c.release();
    }
  });

  it('never returns more than the limit, and cannot be told to ignore the grace period of a referenced file', async () => {
    for (let n = 0; n < 5; n++) await insertFile(A.tenantId, 72);
    const { rows } = await app.query(
      "SELECT storage_key FROM lms.files_purge(interval '24 hours', 2)",
    );
    expect(rows).toHaveLength(2);
    await app.query("SELECT storage_key FROM lms.files_purge(interval '24 hours', 100)"); // drain the rest
  });
});

describe('fractional ordering keys', () => {
  const between = async (lo: string | null, hi: string | null) =>
    (await owner.query<{ p: string }>('SELECT lms.position_between($1, $2) AS p', [lo, hi])).rows[0]
      ?.p as string;
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // JS compares code units = COLLATE "C"

  it('always lands strictly between its neighbours and never ends in 0', async () => {
    expect(await between(null, null)).toMatch(/^[0-9A-Za-z]*[1-9A-Za-z]$/);
    const keys: string[] = [];
    // 600 random insertions into a growing list: the list stays sorted and unique
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let n = 0; n < 600; n++) {
      const at = rnd(keys.length + 1); // insert before index `at`
      const lo = at === 0 ? null : (keys[at - 1] as string);
      const hi = at === keys.length ? null : (keys[at] as string);
      const k = await between(lo, hi);
      expect(k, `between ${lo} and ${hi}`).toMatch(/^[0-9A-Za-z]*[1-9A-Za-z]$/);
      if (lo !== null) expect(cmp(lo, k)).toBeLessThan(0);
      if (hi !== null) expect(cmp(k, hi)).toBeLessThan(0);
      keys.splice(at, 0, k);
    }
    expect(new Set(keys).size).toBe(keys.length);
    const sorted = [...keys].sort(cmp);
    expect(keys).toEqual(sorted);
    // keys stay short enough to be cheap: the longest one is far below a screenful
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(40);
  });

  it('appending 300 entries in a row keeps the keys short and ordered', async () => {
    let last: string | null = null;
    const seen: string[] = [];
    for (let n = 0; n < 300; n++) {
      const k = await between(last, null);
      if (last !== null) expect(cmp(last, k)).toBeLessThan(0);
      seen.push(k);
      last = k;
    }
    expect(Math.max(...seen.map((k) => k.length))).toBeLessThan(120);
  });

  it('refuses nonsense: equal or reversed neighbours', async () => {
    await expect(between('V', 'V')).rejects.toThrow(/must sort before/);
    await expect(between('z', 'a')).rejects.toThrow(/must sort before/);
  });
});

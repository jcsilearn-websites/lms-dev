import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { testAppPool, testOwnerPool } from './support';

// The job_* SECURITY DEFINER functions (migration 0010): hardened like the auth_* functions (see
// auth.functions.test.ts): owner-owned, pinned search_path, EXECUTE for lms_app only, narrow columns,
// and not hijackable through search_path or temp objects.

let owner: pg.Pool;
let app: pg.Pool;

beforeAll(() => {
  owner = testOwnerPool();
  app = testAppPool();
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

const JOB_FUNCTIONS = [
  'job_claim',
  'job_complete',
  'job_enqueue_system',
  'job_extend_lease',
  'job_fail',
  'job_purge',
  'job_release',
];

describe('job_* functions are hardened', () => {
  it('are SECURITY DEFINER, owner-owned, with a pinned search_path', async () => {
    const { rows } = await owner.query<{
      proname: string;
      prosecdef: boolean;
      owner: string;
      config: string[] | null;
    }>(
      `SELECT p.proname, p.prosecdef, r.rolname AS owner, p.proconfig AS config
       FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.pronamespace = 'lms'::regnamespace AND p.proname LIKE 'job\\_%'`,
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([...JOB_FUNCTIONS].sort());
    const me = (await owner.query<{ current_user: string }>('SELECT current_user')).rows[0]
      ?.current_user;
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(r.owner, r.proname).toBe(me);
      expect(r.config, r.proname).toContain('search_path=lms, pg_temp');
    }
  });

  it('EXECUTE is granted to lms_app only (not PUBLIC / anon / authenticated)', async () => {
    const { rows } = await owner.query<{ proname: string; grantees: string[] }>(
      `SELECT p.proname,
              COALESCE(array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END), '{}') AS grantees
       FROM pg_proc p
       LEFT JOIN LATERAL aclexplode(p.proacl) a ON true
       WHERE p.pronamespace = 'lms'::regnamespace AND p.proname LIKE 'job\\_%'
       GROUP BY p.proname`,
    );
    const me = (await owner.query<{ current_user: string }>('SELECT current_user')).rows[0]
      ?.current_user;
    expect(rows).toHaveLength(JOB_FUNCTIONS.length);
    for (const r of rows) {
      expect(r.grantees, r.proname).toContain('lms_app');
      expect(r.grantees, r.proname).not.toContain('PUBLIC');
      expect(r.grantees, r.proname).not.toContain('anon');
      expect(r.grantees, r.proname).not.toContain('authenticated');
      for (const g of r.grantees) expect([me, 'lms_app'], `${r.proname} -> ${g}`).toContain(g);
    }
  });

  it('return only the documented columns', async () => {
    const res = await app.query("SELECT * FROM lms.job_claim('no-such-queue', 'w', 1, 60)");
    expect(res.fields.map((f) => f.name)).toEqual([
      'r_id',
      'r_queue',
      'r_tenant_id',
      'r_payload',
      'r_attempts',
      'r_max_attempts',
    ]);
    expect(res.rowCount).toBe(0);
  });

  it('cannot be hijacked through search_path or a temp jobs table', async () => {
    const q = `hijack-${Date.now()}`;
    const id = newId();
    expect(
      (
        await app.query('SELECT lms.job_enqueue_system($1, $2, $3, NULL, 3, NULL) AS ok', [
          id,
          q,
          '{}',
        ])
      ).rows[0].ok,
    ).toBe(true);
    const client = await app.connect();
    try {
      await client.query('CREATE TEMP TABLE jobs (id uuid, queue text, status text)');
      await client.query('SET search_path = pg_temp, public');
      const claimed = await client.query('SELECT * FROM lms.job_claim($1, $2, 5, 60)', [q, 'w']);
      expect(claimed.rows.map((r) => r.r_id)).toEqual([id]); // the real table, not the temp one
      const temp = await client.query('SELECT count(*)::int AS n FROM pg_temp.jobs');
      expect(temp.rows[0].n).toBe(0);
    } finally {
      await client.query('RESET search_path').catch(() => {});
      client.release(true);
    }
  });

  it('an unknown job id changes nothing and says so', async () => {
    const id = newId();
    const r = await app.query(
      `SELECT lms.job_complete($1, 'w', NULL) AS c, lms.job_fail($1, 'w', 'x', 1, 1) AS f,
              lms.job_extend_lease($1, 'w', 5) AS e, lms.job_release($1, 'w') AS r`,
      [id],
    );
    expect(r.rows[0]).toEqual({ c: false, f: 'lost', e: false, r: false });
  });
});

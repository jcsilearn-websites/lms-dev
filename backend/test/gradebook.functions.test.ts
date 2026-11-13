// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import type { TestClient } from './client';
import { type Json, loginAs, ok, type Structure, structure } from './courses-helpers';
import {
  type Class,
  configureDb,
  gradebookClass,
  participantIds,
  setMark,
} from './gradebook-helpers';
import { type AuthFixture, createAuthFixture, testAppPool, testOwnerPool } from './support';

// Step 11: the hardening of the database functions (grants, search_path, owner), what lms_app may and may not write, history
// (nothing cascades from a participant or an item into marks, overrides and snapshots), isolation between colleges.

let owner: pg.Pool;
let app: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
let admin: TestClient;
let st: Structure;
let e: Class;
let pids: string[];

beforeAll(async () => {
  owner = testOwnerPool();
  app = testAppPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'gbf-a');
  B = await createAuthFixture(owner, 'gbf-b');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
  e = await gradebookClass(owner, t, A, admin, st, ['Fn One', 'Fn Two']);
  pids = await participantIds(owner, e.offeringId, e.learners);
}, 120_000);
afterAll(async () => {
  await t.close();
  await owner.end();
  await app.end();
});

const DEFINERS = ['gradebook_me', 'gradebook_purge_imports'];
const INVOKERS = [
  'gradebook_compute',
  'gradebook_assessment_scores',
  'gradebook_config',
  'gradebook_config_json',
  'gradebook_settings_update',
  'gradebook_categories_save',
  'gradebook_items_save',
  'gradebook_grid',
  'gradebook_explain',
  'gradebook_marks_save',
  'gradebook_import_stage',
  'gradebook_import_get',
  'gradebook_import_apply',
  'gradebook_import_summary',
  'gradebook_override_set',
  'gradebook_override_revoke',
  'gradebook_problems',
  'gradebook_excluded',
  'gradebook_submit',
  'gradebook_review_action',
  'gradebook_unlock',
  'gradebook_review',
  'gradebook_queue',
  'gradebook_snapshot_meta',
  'gradebook_snapshot_page',
  'grade_scales_list',
  'grade_scale_json',
  'grade_scale_save',
  'grade_scale_archive',
  'gb_audit',
  'gb_self_approval',
  'round_frac',
  'frac_key',
  'frac_add',
];

describe('the functions of step 11', () => {
  const info = async (names: string[]) =>
    (
      await owner.query(
        `SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
                has_function_privilege('lms_app', p.oid, 'EXECUTE') AS app,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
                has_function_privilege('public', p.oid, 'EXECUTE') AS pub
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'lms' AND p.proname = ANY($1)`,
        [names],
      )
    ).rows;

  it('the definer functions are SECURITY DEFINER, pinned to search_path = lms, pg_temp, owned by the migration role, EXECUTE for lms_app only', async () => {
    const rows = await info(DEFINERS);
    expect(rows.map((r) => r.proname).sort()).toEqual([...DEFINERS].sort());
    const migrationOwner = (await owner.query('SELECT current_user AS u')).rows[0].u;
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(r.owner, r.proname).toBe(migrationOwner);
      expect(r.proconfig, r.proname).toContain('search_path=lms, pg_temp');
      expect(r.app, r.proname).toBe(true);
      expect(r.anon, r.proname).toBe(false);
      expect(r.authed, r.proname).toBe(false);
      expect(r.pub, r.proname).toBe(false);
    }
  });

  it("the invoker functions run with the caller's rights (so row-level security applies), are pinned and reachable by lms_app only", async () => {
    const rows = await info(INVOKERS);
    expect(rows.map((r) => r.proname).sort()).toEqual([...INVOKERS].sort());
    for (const r of rows) {
      expect(r.prosecdef, `${r.proname} must not be SECURITY DEFINER`).toBe(false);
      expect(r.proconfig, r.proname).toContain('search_path=lms, pg_temp');
      expect(r.app, r.proname).toBe(true);
      expect(r.anon, r.proname).toBe(false);
      expect(r.authed, r.proname).toBe(false);
      expect(r.pub, r.proname).toBe(false);
    }
  });

  it('the trigger functions are out of reach, and a hijacked search_path cannot redirect the learner function', async () => {
    const r = await owner.query(
      `SELECT p.proname, has_function_privilege('lms_app', p.oid, 'EXECUTE') AS app
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'lms' AND p.proname IN ('gradebook_immutable', 'gradebook_make_default')`,
    );
    for (const x of r.rows) expect(x.app, x.proname).toBe(false);
    const c = await app.connect();
    try {
      await c.query('CREATE TEMP TABLE course_participants (id uuid)');
      await c.query('SET search_path = pg_temp, public');
      const res = await c.query('SELECT lms.gradebook_me($1, $2, $3) AS r', [
        A.tenantId,
        e.learners[0]!.userId,
        e.offeringId,
      ]);
      expect(res.rows[0].r.result).toBe('ok');
    } finally {
      await c.query('RESET search_path');
      await c.query('DROP TABLE IF EXISTS pg_temp.course_participants');
      c.release();
    }
  });
});

describe('what lms_app may write', () => {
  it('can write the grading columns it needs and nothing of the history', async () => {
    const priv = async (table: string, p: string) =>
      (
        await owner.query(`SELECT has_table_privilege('lms_app', $1, $2) AS ok`, [
          `lms.${table}`,
          p,
        ])
      ).rows[0].ok as boolean;
    for (const table of [
      'gradebook_versions',
      'gradebook_snapshot_rows',
      'gradebook_events',
      'manual_mark_history',
      'grade_overrides',
    ]) {
      expect(await priv(table, 'SELECT'), table).toBe(true);
      expect(await priv(table, 'INSERT'), table).toBe(true);
      expect(await priv(table, 'DELETE'), `${table} DELETE`).toBe(false);
    }
    for (const table of [
      'gradebook_versions',
      'gradebook_snapshot_rows',
      'gradebook_events',
      'manual_mark_history',
    ]) {
      expect(await priv(table, 'UPDATE'), `${table} UPDATE`).toBe(false);
    }
    // an override is revoked, never edited: only the revoke columns can change
    const cols = (
      await owner.query(
        `SELECT column_name FROM information_schema.column_privileges
          WHERE grantee = 'lms_app' AND table_schema = 'lms' AND table_name = 'grade_overrides' AND privilege_type = 'UPDATE'`,
      )
    ).rows
      .map((r) => r.column_name)
      .sort();
    expect(cols).toEqual(['revoked_at', 'revoked_by']);
    // an offering cannot be re-pointed and a gradebook cannot move to another offering or college
    const gcols = (
      await owner.query(
        `SELECT column_name FROM information_schema.column_privileges
          WHERE grantee = 'lms_app' AND table_schema = 'lms' AND table_name = 'gradebooks' AND privilege_type = 'UPDATE'`,
      )
    ).rows.map((r) => r.column_name);
    expect(gcols).not.toContain('offering_id');
    expect(gcols).not.toContain('tenant_id');
    expect(gcols).not.toContain('id');
  });

  it('with no college set the gradebook tables are empty (row-level security), even for the app role', async () => {
    const c = await app.connect();
    try {
      for (const table of [
        'gradebooks',
        'gradebook_items',
        'manual_marks',
        'grade_overrides',
        'gradebook_snapshot_rows',
        'grade_scales',
      ]) {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM lms.${table}`);
        expect(rows[0].n, table).toBe(0);
      }
    } finally {
      c.release();
    }
  });
});

describe('history is never deleted', () => {
  it('a participant, an item or an offering with marks cannot be deleted (RESTRICT), nor a gradebook with versions', async () => {
    const cfg = await configureDb(owner, A.tenantId, e.offeringId, {
      weighted: false,
      categories: [{ name: 'W', weight: 0 }],
      manual: [{ title: 'X', points: 10, category: 'W', released: true }],
      scale: [{ min: 0, label: 'X' }],
    });
    await setMark(owner, A.tenantId, cfg.itemIds.X!, pids[0]!, 5);
    await owner.query(
      `INSERT INTO lms.grade_overrides (id, tenant_id, gradebook_id, participant_id, item_id, points, reason, set_by)
       VALUES (lms.uuid_v7(), $1, $2, $3, $4, 6, 'because', (SELECT id FROM lms.users LIMIT 1))`,
      [A.tenantId, cfg.gradebookId, pids[0], cfg.itemIds.X],
    );
    await expect(
      owner.query('DELETE FROM lms.gradebook_items WHERE id = $1', [cfg.itemIds.X]),
    ).rejects.toThrow(/foreign key|restrict|violates/i);
    await expect(
      owner.query('DELETE FROM lms.course_participants WHERE id = $1', [pids[0]]),
    ).rejects.toThrow(/foreign key|restrict|violates/i);
    await expect(
      owner.query('DELETE FROM lms.course_offerings WHERE id = $1', [e.offeringId]),
    ).rejects.toThrow(/foreign key|restrict|violates/i);
    await expect(
      owner.query('DELETE FROM lms.gradebooks WHERE id = $1', [cfg.gradebookId]),
    ).rejects.toThrow(/foreign key|restrict|violates/i);
    await expect(
      owner.query('DELETE FROM lms.grade_scales WHERE tenant_id = $1', [A.tenantId]),
    ).rejects.toThrow(/foreign key|restrict|violates/i);
  });

  it('the history of a mark change is append-only even for the owner', async () => {
    await owner.query(
      `INSERT INTO lms.manual_mark_history (id, tenant_id, item_id, participant_id, before_points, after_points, source, changed_by)
       SELECT lms.uuid_v7(), tenant_id, item_id, participant_id, NULL, points, 'grid', entered_by FROM lms.manual_marks LIMIT 1`,
    );
    await expect(
      owner.query('UPDATE lms.manual_mark_history SET after_points = 1'),
    ).rejects.toThrow(/append-only/);
    await expect(owner.query('DELETE FROM lms.manual_mark_history')).rejects.toThrow(/append-only/);
  });
});

describe('isolation between colleges', () => {
  it('another college cannot read or change a gradebook through the functions, and its learner function says "no offering"', async () => {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [B.tenantId]);
      const cfg = await c.query('SELECT lms.gradebook_config($1, $2) AS r', [
        B.tenantId,
        e.offeringId,
      ]);
      expect(cfg.rows[0].r).toBeNull();
      const cross = await c.query('SELECT lms.gradebook_config($1, $2) AS r', [
        A.tenantId,
        e.offeringId,
      ]);
      expect(cross.rows[0].r).toBeNull(); // asking for A's offering with B's context: row-level security hides it
      const set = await c.query(
        `SELECT lms.gradebook_settings_update($1, $2, $3, '{"outOf": 7}') AS r`,
        [A.tenantId, B.adminUserId, e.offeringId],
      );
      expect(set.rows[0].r.result).toBe('not_found');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    const me = await app.query('SELECT lms.gradebook_me($1, $2, $3) AS r', [
      B.tenantId,
      e.learners[0]!.userId,
      e.offeringId,
    ]);
    expect(me.rows[0].r.result).toBe('no_offering');
    const { rows } = await owner.query('SELECT out_of FROM lms.gradebooks WHERE offering_id = $1', [
      e.offeringId,
    ]);
    expect(Number(rows[0].out_of)).not.toBe(7);
  });

  it('a grade scale of one college is not visible to another', async () => {
    const mk = (client: TestClient) =>
      client.post('/grade-scales', {
        name: 'Same name',
        bands: [{ minPercent: 0, label: 'P', isPass: true }],
      });
    ok(await mk(admin));
    const adminB = await loginAs(t, B.host, B.adminEmail);
    ok(await mk(adminB)); // the name is unique per college, not globally
    const a = ok(await admin.get('/grade-scales')) as Json;
    const b = ok(await adminB.get('/grade-scales')) as Json;
    const mineA = a.items.filter((x: Json) => x.name === 'Same name');
    const mineB = b.items.filter((x: Json) => x.name === 'Same name');
    expect(mineA).toHaveLength(1);
    expect(mineB).toHaveLength(1);
    expect(mineA[0].id).not.toBe(mineB[0].id);
    expect(b.items.map((x: Json) => x.id)).not.toContain(
      a.items.find((x: Json) => x.name !== 'Same name')?.id,
    );
  });
});

describe('the purge of staged marks imports', () => {
  it('removes imports nobody applied after the grace period (cells with them) and keeps the recent ones', async () => {
    const gb = (
      await owner.query('SELECT id FROM lms.gradebooks WHERE tenant_id = $1 AND offering_id = $2', [
        A.tenantId,
        e.offeringId,
      ])
    ).rows[0].id;
    const user = (await owner.query('SELECT id FROM lms.users LIMIT 1')).rows[0].id;
    const mk = async (hoursAgo: number) => {
      const id = (await owner.query(`SELECT lms.uuid_v7() AS id`)).rows[0].id;
      await owner.query(
        `INSERT INTO lms.mark_imports (id, tenant_id, gradebook_id, created_by, created_at) VALUES ($1, $2, $3, $4, now() - make_interval(hours => $5))`,
        [id, A.tenantId, gb, user, hoursAgo],
      );
      await owner.query(
        `INSERT INTO lms.mark_import_cells (tenant_id, import_id, row_no, cell_no, register_number, column_name, raw) VALUES ($1, $2, 1, 1, 'R1', 'X', '1')`,
        [A.tenantId, id],
      );
      return id as string;
    };
    const old = await mk(48);
    const recent = await mk(1);
    const r = await app.query('SELECT lms.gradebook_purge_imports(24, 100) AS n');
    expect(r.rows[0].n).toBeGreaterThanOrEqual(1);
    const left = await owner.query('SELECT id FROM lms.mark_imports WHERE id = ANY($1)', [
      [old, recent],
    ]);
    expect(left.rows.map((x) => x.id)).toEqual([recent]);
    const cells = await owner.query(
      'SELECT count(*)::int AS n FROM lms.mark_import_cells WHERE import_id = $1',
      [old],
    );
    expect(cells.rows[0].n).toBe(0);
  });
});

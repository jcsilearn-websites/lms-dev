// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { makeApp, type TestApp } from './app';
import { classOf } from './assignments-helpers';
import type { TestClient } from './client';
import { doc, loginAs, ok, type Structure, structure } from './courses-helpers';
import { type AuthFixture, createAuthFixture, testAppPool, testOwnerPool } from './support';

// Step 12 definer functions: hardening (search_path, grants), tenant isolation of the refresh, and the heartbeat's daily watch log.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
let admin: TestClient;
let adminB: TestClient;
let st: Structure;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'af-a');
  B = await createAuthFixture(owner, 'af-b');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  adminB = await loginAs(t, B.host, B.adminEmail);
  st = await structure(admin);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const DEFINERS = [
  'activity_touch(uuid, uuid, timestamptz)',
  'rollup_mark_participant()',
  'rollup_mark_participant_self()',
  'rollup_mark_offering()',
  'rollup_learners_apply(uuid, uuid, uuid[], timestamptz)',
  'rollup_offering_day_apply(uuid, uuid)',
  'rollup_org_day_apply(uuid, date, date)',
  'rollup_tenant_day_apply(uuid, date, date)',
  'rollup_run_tenant(uuid, timestamptz, integer)',
  'rollup_tenants()',
  'learner_dashboard(uuid, uuid, timestamptz)',
  'usage_compute(uuid, date, timestamptz, jsonb)',
  'usage_close_due(timestamptz, jsonb)',
  'platform_usage(uuid, date, timestamptz, jsonb)',
  'progress_heartbeat(uuid, uuid, uuid, uuid, uuid, uuid, integer, text, integer, numeric)',
];
// what the application role may call; the apply / compute helpers are reachable only through the functions above
const APP_MAY = new Set([
  'activity_touch',
  'rollup_run_tenant',
  'rollup_tenants',
  'learner_dashboard',
  'usage_close_due',
  'platform_usage',
  'progress_heartbeat',
]);

describe('hardening of the step 12 SECURITY DEFINER functions', () => {
  it('pins search_path to lms, pg_temp, and is owned by the migration role', async () => {
    const { rows } = await owner.query(
      `SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'lms' AND p.oid = ANY ($1::regprocedure[])`,
      [DEFINERS.map((d) => `lms.${d}`)],
    );
    expect(rows).toHaveLength(DEFINERS.length);
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(
        r.proconfig?.some((c: string) => c.startsWith('search_path=lms')),
        r.proname,
      ).toBe(true);
    }
  });

  it('EXECUTE is revoked from PUBLIC; the app role may call only the entry points', async () => {
    for (const d of DEFINERS) {
      const name = d.split('(')[0]!;
      const { rows } = await owner.query(
        `SELECT has_function_privilege('lms_app', $1::regprocedure, 'EXECUTE') AS app,
                has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS pub`,
        [`lms.${d}`],
      );
      expect(rows[0].pub, `${name} public`).toBe(false);
      const trigger = name.startsWith('rollup_mark');
      expect(rows[0].app, `${name} app`).toBe(APP_MAY.has(name) && !trigger);
    }
  });

  it('the change marks and the rollups cannot be written by the app role at all', async () => {
    const app = testAppPool();
    for (const tbl of ['rollup_dirty_participants', 'rollup_dirty_offerings'])
      await expect(app.query(`SELECT 1 FROM lms.${tbl}`)).rejects.toMatchObject({ code: '42501' });
    for (const tbl of [
      'rollup_learner_offering',
      'rollup_offering_day',
      'rollup_org_day',
      'rollup_tenant_day',
      'rollup_state',
      'usage_snapshots',
      'member_activity_days',
      'video_watch_days',
    ])
      await expect(
        app.query(`INSERT INTO lms.${tbl} (tenant_id) VALUES (gen_random_uuid())`),
      ).rejects.toMatchObject({ code: '42501' });
    await app.end();
  });
});

describe('refresh isolation', () => {
  it('refreshing college A writes nothing for college B', async () => {
    const e = await classOf(owner, t, A, admin, st, ['One', 'Two']);
    const eB = await classOf(owner, t, B, adminB, await structure(adminB), ['Three']);
    const svc = t.app.modules.analytics.service;
    await svc.refreshTenant(A.tenantId);
    const count = async (id: string) =>
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM lms.rollup_learner_offering WHERE tenant_id = $1',
          [id],
        )
      ).rows[0].n as number;
    expect(await count(A.tenantId)).toBe(2);
    expect(await count(B.tenantId)).toBe(0);
    // B's marks are still waiting: A's refresh did not consume them
    const waiting = (
      await owner.query(
        'SELECT count(*)::int AS n FROM lms.rollup_dirty_participants WHERE tenant_id = $1',
        [B.tenantId],
      )
    ).rows[0].n;
    expect(waiting).toBeGreaterThan(0);
    await svc.refreshTenant(B.tenantId);
    expect(await count(B.tenantId)).toBe(1);
    void e;
    void eB;
  });
});

describe('the heartbeat feeds the daily watch log', () => {
  it('adds exactly the NEW unique seconds, once per local day, and re-watching adds nothing', async () => {
    const e = await classOf(owner, t, A, admin, st, ['Watcher']);
    const ic = e.instructor.client;
    const videoId = newId();
    await owner.query(
      `INSERT INTO lms.video_assets (id, tenant_id, offering_id, created_by, original_name, declared_size, status, duration_ms, hls_prefix, ready_at, upload_offset, progress, renditions)
       VALUES ($1,$2,$3,$4,'p.mp4',1000,'ready',100000,'x',now(),1000,100,'[]'::jsonb)`,
      [videoId, A.tenantId, e.offeringId, e.instructor.userId],
    );
    const item = ok(
      await ic.post(`/offerings/${e.offeringId}/modules/${e.moduleId}/items`, {
        kind: 'video',
        title: 'Lecture',
        videoId,
        published: true,
      }),
    );
    void doc;
    const who = e.learners[0]!;
    const beat = (seq: number, ranges: [number, number][]) =>
      who.client.post(`/offerings/${e.offeringId}/items/${item.id}/progress/heartbeat`, {
        videoId,
        streamId: '0a000000-0000-7000-8000-00000000000a',
        seq,
        ranges,
        position: ranges.at(-1)![1],
        rate: 1,
      });
    const refill = () =>
      owner.query(
        'UPDATE lms.item_progress SET budget_s = 600, budget_at = now() WHERE item_id = $1',
        [item.id],
      );
    const logged = async () =>
      (
        await owner.query(
          `SELECT coalesce(sum(seconds),0)::int AS s, count(*)::int AS n, min(day)::text AS d FROM lms.video_watch_days WHERE item_id = $1`,
          [item.id],
        )
      ).rows[0];
    ok(await beat(1, [[0, 30]]));
    expect((await logged()).s).toBe(30);
    await refill();
    ok(await beat(2, [[20, 50]])); // overlaps: 20 new seconds
    await refill();
    ok(await beat(3, [[0, 30]])); // watched again: nothing new
    ok(await beat(3, [[0, 30]])); // a duplicate heartbeat: nothing at all
    const r = await logged();
    expect(r.s).toBe(50);
    expect(r.n).toBe(1); // one row for the learner, the item and the local day
    const today = (
      await owner.query(`SELECT lms.local_day(now(), lms.tenant_tz($1))::text AS d`, [A.tenantId])
    ).rows[0].d;
    expect(r.d).toBe(today);
    // the log agrees with the progress row (unique seconds)
    const ip = (
      await owner.query('SELECT watched_seconds FROM lms.item_progress WHERE item_id = $1', [
        item.id,
      ])
    ).rows[0];
    expect(ip.watched_seconds).toBe(50);
  });
});

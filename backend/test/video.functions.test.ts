import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { expectPgError } from './helpers';
import { type AuthFixture, createAuthFixture, testAppPool, testOwnerPool } from './support';

// The Step 7 database objects (migration 0025): hardening of the two worker sweeps, grants, tenant isolation of
// the video tables and the composite foreign key that keeps an item from pointing at another college's video.

let owner: pg.Pool;
let app: pg.Pool;
let A: AuthFixture;
let B: AuthFixture;

beforeAll(async () => {
  owner = testOwnerPool();
  app = testAppPool();
  A = await createAuthFixture(owner, 'vf-a');
  B = await createAuthFixture(owner, 'vf-b');
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

async function asTenant<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
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

/** A published offering of the college and a video row (owner connection: fixtures bypass the app's rules). */
async function offeringAndVideo(f: AuthFixture, over: string = '') {
  const y = newId();
  const term = newId();
  const dept = newId();
  const course = newId();
  const off = newId();
  const video = newId();
  await owner.query('BEGIN');
  try {
    await owner.query(
      `INSERT INTO lms.academic_years (id, tenant_id, label, start_date, end_date) VALUES ($1, $2, $3, '2026-06-01', '2027-05-31')`,
      [y, f.tenantId, `Y${y.slice(-6)}`],
    );
    await owner.query(
      `INSERT INTO lms.terms (id, tenant_id, academic_year_id, name, start_date, end_date) VALUES ($1, $2, $3, $4, '2026-06-01', '2026-11-30')`,
      [term, f.tenantId, y, `T${term.slice(-6)}`],
    );
    await owner.query(
      `INSERT INTO lms.courses (id, tenant_id, code, title) VALUES ($1, $2, $3, 'C')`,
      [course, f.tenantId, `C${course.slice(-6)}`.toUpperCase()],
    );
    await owner.query(
      `INSERT INTO lms.course_offerings (id, tenant_id, course_id, term_id, label) VALUES ($1, $2, $3, $4, 'O')`,
      [off, f.tenantId, course, term],
    );
    void dept;
    await owner.query(
      `INSERT INTO lms.video_assets (id, tenant_id, offering_id, created_by, original_name, declared_size ${over ? `, ${over.split('=')[0]}` : ''})
       VALUES ($1, $2, $3, $4, 'a.mp4', 1000 ${over ? `, ${over.split('=')[1]}` : ''})`,
      [video, f.tenantId, off, newId()],
    );
    await owner.query('COMMIT');
  } catch (e) {
    await owner.query('ROLLBACK');
    throw e;
  }
  return { offeringId: off, videoId: video };
}

describe('hardening of the video functions', () => {
  it('video_purge and video_sources_expire are SECURITY DEFINER, owner-owned, with a pinned search_path, executable by lms_app only', async () => {
    const { rows } = await owner.query<{
      proname: string;
      prosecdef: boolean;
      config: string[];
      owner: string;
      acl: string[];
    }>(
      `SELECT p.proname, p.prosecdef, p.proconfig AS config, r.rolname AS owner,
              COALESCE((SELECT array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)
                          FROM aclexplode(p.proacl) a), '{}') AS acl
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.pronamespace = 'lms'::regnamespace AND p.proname IN ('video_purge', 'video_sources_expire')`,
    );
    expect(rows.map((r) => r.proname).sort()).toEqual(['video_purge', 'video_sources_expire']);
    const me = (await owner.query<{ current_user: string }>('SELECT current_user')).rows[0]
      ?.current_user;
    for (const f of rows) {
      expect(f.prosecdef, f.proname).toBe(true);
      expect(f.owner, f.proname).toBe(me);
      expect(f.config, f.proname).toContain('search_path=lms, pg_temp');
      expect(f.acl, f.proname).toContain('lms_app');
      for (const bad of ['PUBLIC', 'anon', 'authenticated'])
        expect(f.acl, `${f.proname} ${bad}`).not.toContain(bad);
    }
  });

  it('the tables have no policy that opens them up, and RLS is enabled and forced', async () => {
    const { rows } = await owner.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace = 'lms'::regnamespace AND relname IN ('video_assets', 'video_captions')`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows)
      expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
  });

  it('lms_app cannot rewrite who owns a video, where it lives, or how big it was announced to be', async () => {
    for (const column of [
      'tenant_id',
      'offering_id',
      'created_by',
      'original_name',
      'declared_size',
      'provider',
      'created_at',
    ]) {
      const { rows } = await owner.query<{ ok: boolean }>(
        "SELECT has_column_privilege('lms_app', 'lms.video_assets', $1, 'UPDATE') AS ok",
        [column],
      );
      expect(rows[0]?.ok, column).toBe(false);
    }
    for (const column of ['status', 'progress', 'upload_offset', 'renditions']) {
      const { rows } = await owner.query<{ ok: boolean }>(
        "SELECT has_column_privilege('lms_app', 'lms.video_assets', $1, 'UPDATE') AS ok",
        [column],
      );
      expect(rows[0]?.ok, column).toBe(true);
    }
  });
});

describe('tenant isolation of the video tables', () => {
  it('a college sees only its own videos, and cannot update or delete another college’s', async () => {
    const a = await offeringAndVideo(A);
    const seen = await asTenant(B.tenantId, (c) =>
      c.query('SELECT id FROM lms.video_assets WHERE id = $1', [a.videoId]),
    );
    expect(seen.rowCount).toBe(0);
    const upd = await asTenant(B.tenantId, (c) =>
      c.query('UPDATE lms.video_assets SET progress = 50 WHERE id = $1', [a.videoId]),
    );
    expect(upd.rowCount).toBe(0);
    const del = await asTenant(B.tenantId, (c) =>
      c.query('DELETE FROM lms.video_assets WHERE id = $1', [a.videoId]),
    );
    expect(del.rowCount).toBe(0);
    const mine = await asTenant(A.tenantId, (c) =>
      c.query('SELECT id FROM lms.video_assets WHERE id = $1', [a.videoId]),
    );
    expect(mine.rowCount).toBe(1);
  });

  it('a college cannot insert a video for another college, or for an offering that is not its own', async () => {
    const a = await offeringAndVideo(A);
    await expectPgError(
      asTenant(B.tenantId, (c) =>
        c.query(
          `INSERT INTO lms.video_assets (id, tenant_id, offering_id, created_by, original_name, declared_size)
           VALUES ($1, $2, $3, $4, 'x.mp4', 10)`,
          [newId(), A.tenantId, a.offeringId, newId()],
        ),
      ),
      '42501',
    );
    // its own tenant id, but A's offering: the composite foreign key refuses it
    await expectPgError(
      asTenant(B.tenantId, (c) =>
        c.query(
          `INSERT INTO lms.video_assets (id, tenant_id, offering_id, created_by, original_name, declared_size)
           VALUES ($1, $2, $3, $4, 'x.mp4', 10)`,
          [newId(), B.tenantId, a.offeringId, newId()],
        ),
      ),
      '23503',
    );
  });

  it('a video asset must be whole to be ready, and a failed one must say why', async () => {
    const a = await offeringAndVideo(A);
    await expectPgError(
      owner.query("UPDATE lms.video_assets SET status = 'ready' WHERE id = $1", [a.videoId]),
      '23514',
    );
    await expectPgError(
      owner.query("UPDATE lms.video_assets SET status = 'failed' WHERE id = $1", [a.videoId]),
      '23514',
    );
    await expectPgError(
      owner.query('UPDATE lms.video_assets SET upload_offset = declared_size + 1 WHERE id = $1', [
        a.videoId,
      ]),
      '23514',
    );
  });
});

describe('items and videos', () => {
  async function itemFor(f: AuthFixture, offeringId: string) {
    const moduleId = newId();
    await owner.query(
      `INSERT INTO lms.content_modules (id, tenant_id, offering_id, title, position) VALUES ($1, $2, $3, 'M', 'a1')`,
      [moduleId, f.tenantId, offeringId],
    );
    return moduleId;
  }
  const insertItem = (
    c: { query: pg.Pool['query'] },
    f: AuthFixture,
    offeringId: string,
    moduleId: string,
    kind: string,
    videoId: string | null,
  ) =>
    c.query(
      `INSERT INTO lms.content_items (id, tenant_id, offering_id, module_id, kind, title, position, video_asset_id)
       VALUES ($1, $2, $3, $4, $5, 't', 'a1', $6)`,
      [newId(), f.tenantId, offeringId, moduleId, kind, videoId],
    );

  it('a video item needs a video, and other kinds must not have one', async () => {
    const a = await offeringAndVideo(A);
    const m = await itemFor(A, a.offeringId);
    await expectPgError(insertItem(owner, A, a.offeringId, m, 'video', null), '23514');
    await expectPgError(insertItem(owner, A, a.offeringId, m, 'link', a.videoId), '23514');
    await insertItem(owner, A, a.offeringId, m, 'video', a.videoId);
  });

  it('an item cannot reference a video of another college (composite foreign key)', async () => {
    const a = await offeringAndVideo(A);
    const b = await offeringAndVideo(B);
    const m = await itemFor(B, b.offeringId);
    await expectPgError(insertItem(owner, B, b.offeringId, m, 'video', a.videoId), '23503');
  });

  it('a video that an item uses cannot be deleted (RESTRICT)', async () => {
    const a = await offeringAndVideo(A);
    const m = await itemFor(A, a.offeringId);
    await insertItem(owner, A, a.offeringId, m, 'video', a.videoId);
    await expectPgError(
      asTenant(A.tenantId, (c) =>
        c.query('DELETE FROM lms.video_assets WHERE id = $1', [a.videoId]),
      ),
      '23503',
    );
  });

  it('video_purge keeps referenced and recent videos, deletes old unreferenced ones, and works across colleges', async () => {
    const used = await offeringAndVideo(A);
    const old = await offeringAndVideo(A);
    const oldB = await offeringAndVideo(B);
    const fresh = await offeringAndVideo(B);
    const m = await itemFor(A, used.offeringId);
    await insertItem(owner, A, used.offeringId, m, 'video', used.videoId);
    await owner.query(
      "UPDATE lms.video_assets SET created_at = now() - interval '3 days', last_activity_at = now() - interval '3 days' WHERE id = ANY($1)",
      [[used.videoId, old.videoId, oldB.videoId]],
    );
    const { rows } = await app.query<{ id: string }>(
      "SELECT id FROM lms.video_purge(interval '24 hours', 1000)",
    );
    const gone = new Set(rows.map((r) => r.id));
    expect(gone.has(old.videoId)).toBe(true);
    expect(gone.has(oldB.videoId)).toBe(true);
    expect(gone.has(used.videoId)).toBe(false);
    expect(gone.has(fresh.videoId)).toBe(false);
    const left = await owner.query('SELECT id FROM lms.video_assets WHERE id = ANY($1)', [
      [used.videoId, old.videoId, oldB.videoId, fresh.videoId],
    ]);
    expect(left.rows.map((r) => r.id).sort()).toEqual([used.videoId, fresh.videoId].sort());
  });

  it('video_sources_expire marks only what is due, once', async () => {
    const due = await offeringAndVideo(A);
    const later = await offeringAndVideo(A);
    await owner.query(
      "UPDATE lms.video_assets SET source_key = 'k', source_expires_at = now() - interval '1 hour' WHERE id = $1",
      [due.videoId],
    );
    await owner.query(
      "UPDATE lms.video_assets SET source_key = 'k', source_expires_at = now() + interval '5 days' WHERE id = $1",
      [later.videoId],
    );
    const first = await app.query<{ id: string }>('SELECT id FROM lms.video_sources_expire(1000)');
    expect(first.rows.map((r) => r.id)).toContain(due.videoId);
    expect(first.rows.map((r) => r.id)).not.toContain(later.videoId);
    const second = await app.query<{ id: string }>('SELECT id FROM lms.video_sources_expire(1000)');
    expect(second.rows.map((r) => r.id)).not.toContain(due.videoId);
    const row = await owner.query(
      'SELECT source_key, source_deleted_at FROM lms.video_assets WHERE id = $1',
      [due.videoId],
    );
    expect(row.rows[0]).toMatchObject({ source_key: null });
    expect(row.rows[0]?.source_deleted_at).not.toBeNull();
  });
});

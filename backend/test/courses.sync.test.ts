import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoursesRepository } from '../src/modules/courses';
import { makeApp, type TestApp } from './app';
import type { TestClient } from './client';
import {
  loginAs,
  newCourse,
  newOffering,
  ok,
  person,
  runSync,
  type Structure,
  structure,
  student,
} from './courses-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// The enrolment sync: triggers record WHICH members changed (deduplicated), a job is queued only when none
// is waiting, and the job takes the changed members in bounded batches and deletes them in the same
// transaction as it applies them.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let S: Structure;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp();
  A = await createAuthFixture(owner, 'sy-a');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  S = await structure(admin);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const pending = async () =>
  Number(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM lms.course_sync_pending WHERE tenant_id = $1',
        [A.tenantId],
      )
    ).rows[0].n,
  );
const jobs = async (status: string) =>
  Number(
    (
      await owner.query(
        "SELECT count(*)::int AS n FROM lms.jobs WHERE tenant_id = $1 AND queue = 'courses.sync' AND status = $2::lms.job_status",
        [A.tenantId, status],
      )
    ).rows[0].n,
  );
const reset = async () => {
  await runSync(t, A.tenantId);
  await owner.query("DELETE FROM lms.jobs WHERE tenant_id = $1 AND queue = 'courses.sync'", [
    A.tenantId,
  ]);
};

async function enrolled(offeringId: string): Promise<string[]> {
  const r = ok(
    await admin.get(`/offerings/${offeringId}/participants`, {
      query: 'participation=learner&limit=100',
    }),
  );
  return r.items.map((x: { userId: string }) => x.userId);
}

describe('what the triggers record', () => {
  it('a section change marks the member once; unrelated profile changes mark nobody', async () => {
    await reset();
    const s1 = await student(owner, t, A, admin, S, S.sectionA, 'T1');
    await reset();
    expect(await pending()).toBe(0);
    ok(await admin.patch(`/members/${s1.userId}/profile`, { phone: '+91 98765 43210' }));
    expect(await pending()).toBe(0);
    ok(await admin.post(`/members/${s1.userId}/profile/section`, { sectionId: S.sectionB }));
    ok(await admin.post(`/members/${s1.userId}/profile/section`, { sectionId: S.sectionA }));
    expect(await pending()).toBe(1); // twice changed, recorded once
  });

  it('a bulk move marks every moved student in ONE statement; suspending marks the member', async () => {
    await reset();
    const many = [];
    for (let n = 0; n < 5; n++)
      many.push(await student(owner, t, A, admin, S, S.sectionA, `B${n}`));
    await reset();
    ok(
      await admin.post('/sections/move', {
        userIds: many.map((m) => m.userId),
        sectionId: S.sectionB,
      }),
    );
    expect(await pending()).toBe(5);
    await reset();
    ok(await admin.post(`/members/${many[0]?.userId}/suspend`));
    expect(await pending()).toBe(1);
  });

  it('only ONE job is queued per college while one is waiting, however many changes happen', async () => {
    await reset();
    const a = await student(owner, t, A, admin, S, S.sectionA, 'Q1');
    const b = await student(owner, t, A, admin, S, S.sectionA, 'Q2');
    ok(await admin.post(`/members/${a.userId}/profile/section`, { sectionId: S.sectionB }));
    ok(await admin.post(`/members/${b.userId}/profile/section`, { sectionId: S.sectionB }));
    expect(await jobs('queued')).toBe(1);
  });

  it('a job that is RUNNING does not suppress the next one (the change made during a run is not lost)', async () => {
    await reset();
    const a = await student(owner, t, A, admin, S, S.sectionA, 'R1');
    await reset();
    ok(await admin.post(`/members/${a.userId}/profile/section`, { sectionId: S.sectionB }));
    expect(await jobs('queued')).toBe(1);
    // the worker claims it: it is running now
    await owner.query(
      "UPDATE lms.jobs SET status = 'running', locked_by = 'w', locked_until = now() + interval '1 minute' WHERE tenant_id = $1 AND queue = 'courses.sync'",
      [A.tenantId],
    );
    expect(await jobs('queued')).toBe(0);
    ok(await admin.post(`/members/${a.userId}/profile/section`, { sectionId: S.sectionA }));
    expect(await jobs('queued')).toBe(1); // a new one was queued although one is running
    expect(await jobs('running')).toBe(1);
  });
});

describe('running the sync', () => {
  it('a change made WHILE a batch is being applied is not lost: the final state is right', async () => {
    await reset();
    const c = await newCourse(admin);
    const o = await newOffering(admin, c.id, S.termId);
    const s1 = await student(owner, t, A, admin, S, S.sectionA, 'Mid');
    ok(await admin.post(`/offerings/${o.id}/sections`, { sectionId: S.sectionA }));
    ok(await admin.post(`/offerings/${o.id}/sections`, { sectionId: S.sectionB }));
    await runSync(t, A.tenantId);
    expect(await enrolled(o.id)).toContain(s1.userId);
    // an administrator moves the student to B: pending again
    ok(await admin.post(`/members/${s1.userId}/profile/section`, { sectionId: S.sectionB }));

    // The sync takes its batch inside a transaction that is still OPEN while the student is moved AGAIN
    // (to A). That second change cannot finish before the sync's transaction does: it waits for the claimed
    // pending row, then records itself and queues the next job.
    let secondMove: Promise<unknown> | undefined;
    await t.db.withTenant(A.tenantId, async (tx) => {
      const n = await createCoursesRepository().syncBatch(tx, A.tenantId, 200);
      expect(n).toBe(1);
      secondMove = admin.post(`/members/${s1.userId}/profile/section`, { sectionId: S.sectionA });
      await new Promise((r) => setTimeout(r, 400)); // the second move is now waiting on the claimed row
    });
    await secondMove;
    // the second change survived the first batch's delete: it is pending, with a job queued
    expect(await pending()).toBe(1);
    expect(await jobs('queued')).toBeGreaterThanOrEqual(1);
    await runSync(t, A.tenantId);
    expect(await pending()).toBe(0);
    expect(await enrolled(o.id)).toContain(s1.userId); // back in A: enrolled through section A
    const row = (
      await owner.query(
        `SELECT cp.source_section_id, cp.status FROM lms.course_participants cp
           JOIN lms.tenant_memberships m ON m.id = cp.membership_id
          WHERE cp.offering_id = $1 AND m.user_id = $2`,
        [o.id, s1.userId],
      )
    ).rows[0];
    expect(row).toMatchObject({ source_section_id: S.sectionA, status: 'active' });
  });

  it('the cost follows the number of changes: one student moving takes exactly one member, whatever the college size', async () => {
    await reset();
    const c = await newCourse(admin);
    const o = await newOffering(admin, c.id, S.termId);
    ok(await admin.post(`/offerings/${o.id}/sections`, { sectionId: S.sectionA }));
    const lots = await student(owner, t, A, admin, S, S.sectionA, 'Lots');
    // 400 more students already in section A (inserted straight into the tables: the point is the size)
    await owner.query(
      `WITH u AS (
         INSERT INTO lms.users (id, email, display_name)
         SELECT gen_random_uuid(), 'bulk' || g || '@sy-a.test', 'Bulk ' || g FROM generate_series(1, 400) g RETURNING id),
       m AS (
         INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status)
         SELECT gen_random_uuid(), $1, u.id, 'member', 'active' FROM u RETURNING id)
       INSERT INTO lms.member_profiles (id, tenant_id, membership_id, profile_type, register_number, batch_id, section_id)
       SELECT gen_random_uuid(), $1, m.id, 'student', 'BULK' || row_number() OVER (), $2, $3 FROM m`,
      [A.tenantId, S.batchId, S.sectionA],
    );
    const everyone = await runSync(t, A.tenantId);
    expect(everyone.members).toBeGreaterThanOrEqual(401);
    const active = async () =>
      Number(
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM lms.course_participants WHERE offering_id = $1 AND status = 'active'",
            [o.id],
          )
        ).rows[0].n,
      );
    const before = await active();
    expect(before).toBeGreaterThanOrEqual(401);

    ok(await admin.post(`/members/${lots.userId}/profile/section`, { sectionId: S.sectionB }));
    expect(await pending()).toBe(1);
    const again = await runSync(t, A.tenantId);
    expect(again).toEqual({ members: 1, batches: 1 });
    expect(await enrolled(o.id)).not.toContain(lots.userId);
    // nothing else changed hands
    expect(await active()).toBe(before - 1);
  });

  it('large changes go in bounded batches and an interrupted run resumes where it stopped', async () => {
    await reset();
    const c = await newCourse(admin);
    const o = await newOffering(admin, c.id, S.termId);
    ok(await admin.post(`/offerings/${o.id}/sections`, { sectionId: S.sectionB }));
    const people = [];
    for (let n = 0; n < 7; n++)
      people.push(await student(owner, t, A, admin, S, S.sectionA, `Bt${n}`));
    await reset();
    ok(
      await admin.post('/sections/move', {
        userIds: people.map((p) => p.userId),
        sectionId: S.sectionB,
      }),
    );
    expect(await pending()).toBe(7);
    const first = await t.app.modules.courses.service.syncEnrolments(A.tenantId, {
      batchSize: 3,
      maxBatches: 1,
    });
    expect(first).toEqual({ members: 3, batches: 1 });
    expect(await pending()).toBe(4); // the other four are still recorded
    const rest = await t.app.modules.courses.service.syncEnrolments(A.tenantId, {
      batchSize: 3,
      maxBatches: 10,
    });
    expect(rest.members).toBe(4);
    expect(await pending()).toBe(0);
    const learners = await enrolled(o.id);
    for (const p of people) expect(learners).toContain(p.userId);
  });

  it('the job handler runs the same code, needs its tenant, and a second run changes nothing', async () => {
    await reset();
    const handler = t.app.modules.handlers['courses.sync'];
    expect(handler).toBeDefined();
    const ctx = (tenantId: string | null) => ({
      jobId: 'j',
      queue: 'courses.sync',
      tenantId,
      attempt: 1,
      maxAttempts: 5,
      signal: new AbortController().signal,
    });
    await expect(handler?.run({}, ctx(null))).rejects.toThrow(/tenant/);
    const p = await person(owner, t, A, 'Handler');
    void p;
    expect(await handler?.run({}, ctx(A.tenantId))).toEqual({ members: 0, batches: 0 });
  });

  it('a college change never touches another college', async () => {
    const B = await createAuthFixture(owner, 'sy-b');
    await reset();
    await owner.query(
      'INSERT INTO lms.course_sync_pending (tenant_id, membership_id) VALUES ($1, $2)',
      [B.tenantId, B.memberMembershipId],
    );
    await runSync(t, A.tenantId);
    const left = (
      await owner.query(
        'SELECT count(*)::int AS n FROM lms.course_sync_pending WHERE tenant_id = $1',
        [B.tenantId],
      )
    ).rows[0].n;
    expect(left).toBe(1);
  });
});

/** A section of its own: the tests above leave hundreds of students in A and B, which would slow these down. */
async function ownSection(code: string): Promise<string> {
  return ok(await admin.post('/sections', { batchId: S.batchId, code })).id;
}

describe('ids created inside statements', () => {
  it('rows made by the sync and the jobs queued by the triggers have UUIDv7 ids', async () => {
    await reset();
    const c = await newCourse(admin);
    const o = await newOffering(admin, c.id, S.termId);
    const own = await ownSection('V7');
    await student(owner, t, A, admin, S, own, 'V7');
    ok(await admin.post(`/offerings/${o.id}/sections`, { sectionId: own }));
    const job = await owner.query(
      "SELECT id::text FROM lms.jobs WHERE tenant_id = $1 AND queue = 'courses.sync'",
      [A.tenantId],
    );
    await runSync(t, A.tenantId);
    const rows = await owner.query(
      "SELECT id::text FROM lms.course_participants WHERE offering_id = $1 AND source = 'section'",
      [o.id],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of [...rows.rows, ...job.rows])
      expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('parallel lanes', () => {
  it('several batches at once take different members and reach the same final state', async () => {
    await reset();
    const c = await newCourse(admin);
    const o = await newOffering(admin, c.id, S.termId);
    const own = await ownSection('PAR');
    for (let n = 0; n < 9; n++) await student(owner, t, A, admin, S, own, `Par${n}`);
    ok(await admin.post(`/offerings/${o.id}/sections`, { sectionId: own }));
    const r = await t.app.modules.courses.service.syncEnrolments(A.tenantId, {
      batchSize: 2,
      maxBatches: 100,
      concurrency: 3,
    });
    expect(r.members).toBeGreaterThanOrEqual(9);
    expect(await pending()).toBe(0);
    const count = await owner.query(
      "SELECT count(*)::int AS n FROM lms.course_participants WHERE offering_id = $1 AND status = 'active'",
      [o.id],
    );
    expect(count.rows[0].n).toBeGreaterThanOrEqual(9);
    const dup = await owner.query(
      'SELECT count(*)::int AS n FROM (SELECT membership_id FROM lms.course_participants WHERE offering_id = $1 GROUP BY 1 HAVING count(*) > 1) d',
      [o.id],
    );
    expect(dup.rows[0].n).toBe(0);
  });
});

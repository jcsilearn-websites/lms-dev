// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { accessCte } from '../src/modules/courses';
import { makeApp, type TestApp } from './app';
import { addAssignment, inHours, minutesAgo, setDates } from './assignments-helpers';
import type { TestClient } from './client';
import { doc, type Json, loginAs, ok, type Structure, structure } from './courses-helpers';
import { assignment, type Class, gradebookClass, participantIds, quiz } from './gradebook-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Step 12: the rollups. Every rollup table is compared with a direct computation from the SOURCE tables (written here, in
// TypeScript, independently of the SQL), on a class with generated data, after random mutations and refreshes with random batch
// sizes in random order. Then: a refresh twice changes nothing; the clock alone (a deadline passing) changes a row.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let st: Structure;
let e: Class;
let pids: string[];
const textItems: Json[] = [];
const asgItems: Json[] = [];
const TZ = 'Asia/Kolkata';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const day = (d: Date | string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(d));
const q = async (sql: string, p: unknown[] = []) => (await owner.query(sql, p)).rows;
const round2 = (x: number) => Math.round(x * 100) / 100;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({});
  A = await createAuthFixture(owner, 'roll-a');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
  e = await gradebookClass(owner, t, A, admin, st, ['Asha', 'Bala', 'Chitra', 'Dev']);
  pids = await participantIds(owner, e.offeringId, e.learners);
  const ic = e.instructor.client;
  for (let i = 0; i < 4; i++)
    textItems.push(
      ok(
        await ic.post(`/offerings/${e.offeringId}/modules/${e.moduleId}/items`, {
          kind: 'text',
          title: `Notes ${i}`,
          body: doc('x'),
          published: true,
        }),
      ),
    );
  // generated work: two graded + released assignments, one quiz, one assignment nobody handed in
  asgItems.push(
    await assignment(owner, e, 'Essay 1', [80, 40, null, 95], { release: true, dueInPast: true }),
  );
  asgItems.push(await assignment(owner, e, 'Essay 2', [60, null, null, 70], { dueInPast: true }));
  await quiz(e, 'Quiz 1', [true, false, null, true]);
  const open = await addAssignment(e, { title: 'Open work' });
  await setDates(owner, open.id, { opensAt: null, dueAt: inHours(48), cutoffAt: null });
  asgItems.push(open);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

// ------------------------------------------------------------------------------------------ the reference
async function reference(now: Date) {
  const tenant = A.tenantId;
  const off = (
    await q('SELECT status, behind_after_days FROM lms.course_offerings WHERE id = $1', [
      e.offeringId,
    ])
  )[0];
  const parts = await q(
    `SELECT p.id, tm.user_id, p.created_at FROM lms.course_participants p
       JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
      WHERE p.tenant_id = $1 AND p.offering_id = $2 AND p.participation = 'learner' AND p.status = 'active'`,
    [tenant, e.offeringId],
  );
  const items = await q(
    `SELECT i.id, i.required, i.created_at, i.available_from, m.available_from AS m_from
       FROM lms.content_items i JOIN lms.content_modules m ON m.tenant_id = i.tenant_id AND m.id = i.module_id
      WHERE i.tenant_id = $1 AND i.offering_id = $2 AND i.deleted_at IS NULL AND m.deleted_at IS NULL AND i.published AND m.published`,
    [tenant, e.offeringId],
  );
  const effOpen = (i: Json) => {
    const from = [i.available_from, i.m_from]
      .filter(Boolean)
      .map((d: string) => new Date(d).getTime());
    return Math.max(from.length ? Math.max(...from) : -Infinity, new Date(i.created_at).getTime());
  };
  const cutoff = now.getTime() - off.behind_after_days * 86_400_000;
  const vis =
    off.status === 'published'
      ? items.filter(
          (i) =>
            i.required &&
            new Date(i.available_from ?? 0).getTime() <= now.getTime() &&
            effOpen(i) <= now.getTime() &&
            (!i.m_from || new Date(i.m_from).getTime() <= now.getTime()),
        )
      : [];
  const visIds = new Set(vis.map((i) => i.id));
  const publishedItem = new Set(items.map((i) => i.id));
  const progress = await q(
    'SELECT * FROM lms.item_progress WHERE tenant_id = $1 AND offering_id = $2',
    [tenant, e.offeringId],
  );
  const subs = await q('SELECT * FROM lms.submissions WHERE tenant_id = $1 AND offering_id = $2', [
    tenant,
    e.offeringId,
  ]);
  const atts = await q('SELECT * FROM lms.attempts WHERE tenant_id = $1 AND offering_id = $2', [
    tenant,
    e.offeringId,
  ]);
  const watch = await q('SELECT * FROM lms.video_watch_days WHERE tenant_id = $1', [tenant]);
  const asg = await q('SELECT * FROM lms.assignments WHERE tenant_id = $1 AND offering_id = $2', [
    tenant,
    e.offeringId,
  ]);
  const exts = await q('SELECT * FROM lms.assignment_extensions WHERE tenant_id = $1', [tenant]);
  const asm = await q('SELECT * FROM lms.assessments WHERE tenant_id = $1 AND offering_id = $2', [
    tenant,
    e.offeringId,
  ]);
  const accs = await q('SELECT * FROM lms.assessment_accommodations WHERE tenant_id = $1', [
    tenant,
  ]);
  const grades = await q('SELECT * FROM lms.assignment_grades WHERE tenant_id = $1', [tenant]);

  return parts
    .map((p) => {
      const mine = progress.filter((r) => r.participant_id === p.id);
      const done = mine.filter((r) => r.status === 'completed' && visIds.has(r.item_id));
      const doneDue = done.filter((r) => effOpen(vis.find((v) => v.id === r.item_id)!) <= cutoff);
      const due = vis.filter((v) => effOpen(v) <= cutoff).length;
      let missed = 0;
      if (off.status === 'published') {
        for (const a of asg) {
          if (!a.due_at || !publishedItem.has(a.item_id)) continue;
          const ext = exts.find(
            (x) => x.assignment_item_id === a.item_id && x.participant_id === p.id,
          );
          const dueAt = new Date(ext?.extended_due_at ?? a.due_at).getTime();
          if (
            dueAt < now.getTime() &&
            !subs.some((s) => s.assignment_item_id === a.item_id && s.participant_id === p.id)
          )
            missed++;
        }
        for (const s of asm) {
          if (!s.closes_at || !publishedItem.has(s.item_id)) continue;
          const ac = accs.find(
            (x) => x.assessment_item_id === s.item_id && x.participant_id === p.id,
          );
          const close = Math.max(
            new Date(s.closes_at).getTime(),
            ac?.extended_close_at ? new Date(ac.extended_close_at).getTime() : 0,
          );
          if (
            close < now.getTime() &&
            !atts.some((x) => x.assessment_item_id === s.item_id && x.participant_id === p.id)
          )
            missed++;
        }
      }
      const pcts: number[] = [];
      for (const g of grades.filter((x) => x.participant_id === p.id)) {
        const a = asg.find((x) => x.item_id === g.assignment_item_id);
        if (!a || !(g.released_at || a.release_mode === 'immediate')) continue;
        pcts.push(round2((Number(g.raw_score) * 100) / Number(a.max_points)));
      }
      for (const s of asm) {
        const g = atts.filter(
          (x) =>
            x.assessment_item_id === s.item_id &&
            x.participant_id === p.id &&
            x.status === 'graded',
        );
        if (!g.length) continue;
        pcts.push(Math.max(...g.map((x) => round2((Number(x.score) * 100) / Number(x.max_score)))));
      }
      const times = [
        ...mine.map((r) => new Date(r.last_activity_at).getTime()),
        ...subs
          .filter((s) => s.participant_id === p.id)
          .map((s) => new Date(s.submitted_at).getTime()),
        ...atts
          .filter((x) => x.participant_id === p.id)
          .flatMap((x) =>
            [x.started_at, x.submitted_at]
              .filter(Boolean)
              .map((d: string) => new Date(d).getTime()),
          ),
      ];
      return {
        participant_id: p.id,
        total_required: vis.length,
        completed_required: done.length,
        behind_items: Math.max(0, due - doneDue.length),
        missed_deadlines: missed,
        avg_score: pcts.length ? round2(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
        scored_items: pcts.length,
        last_activity_ms: times.length ? Math.max(...times) : null,
        video_seconds: watch
          .filter((w) => w.participant_id === p.id)
          .reduce((a, w) => a + w.seconds, 0),
      };
    })
    .sort((a, b) => a.participant_id.localeCompare(b.participant_id));
}

async function actualLearners() {
  const rows = await q(
    'SELECT * FROM lms.rollup_learner_offering WHERE tenant_id = $1 AND offering_id = $2 ORDER BY participant_id',
    [A.tenantId, e.offeringId],
  );
  return rows.map((r) => ({
    participant_id: r.participant_id,
    total_required: r.total_required,
    completed_required: r.completed_required,
    behind_items: r.behind_items,
    missed_deadlines: r.missed_deadlines,
    avg_score: r.avg_score === null ? null : Number(r.avg_score),
    scored_items: r.scored_items,
    last_activity_ms: r.last_activity_at ? new Date(r.last_activity_at).getTime() : null,
    video_seconds: r.video_seconds,
  }));
}

async function offeringDayReference() {
  const tenant = A.tenantId;
  const lp = new Set(
    (
      await q(
        `SELECT id FROM lms.course_participants WHERE tenant_id=$1 AND offering_id=$2 AND participation='learner'`,
        [tenant, e.offeringId],
      )
    ).map((r) => r.id),
  );
  const days = new Map<
    string,
    { who: Set<string>; done: number; sub: number; att: number; vs: number }
  >();
  const slot = (d: string) => {
    if (!days.has(d)) days.set(d, { who: new Set(), done: 0, sub: 0, att: 0, vs: 0 });
    return days.get(d)!;
  };
  for (const r of await q(
    `SELECT * FROM lms.item_progress WHERE tenant_id=$1 AND offering_id=$2 AND status='completed'`,
    [tenant, e.offeringId],
  ))
    if (lp.has(r.participant_id)) {
      const s = slot(day(r.completed_at));
      s.who.add(r.participant_id);
      s.done++;
    }
  for (const r of await q('SELECT * FROM lms.submissions WHERE tenant_id=$1 AND offering_id=$2', [
    tenant,
    e.offeringId,
  ]))
    if (lp.has(r.participant_id)) {
      const s = slot(day(r.submitted_at));
      s.who.add(r.participant_id);
      s.sub++;
    }
  for (const r of await q('SELECT * FROM lms.attempts WHERE tenant_id=$1 AND offering_id=$2', [
    tenant,
    e.offeringId,
  ]))
    if (lp.has(r.participant_id)) {
      const s = slot(day(r.started_at));
      s.who.add(r.participant_id);
      s.att++;
    }
  for (const r of await q(
    'SELECT participant_id, day::text AS d, seconds FROM lms.video_watch_days WHERE tenant_id=$1',
    [tenant],
  ))
    if (lp.has(r.participant_id)) {
      const s = slot(r.d);
      s.who.add(r.participant_id);
      s.vs += r.seconds;
    }
  return [...days.entries()]
    .map(([d, s]) => ({
      day: d,
      active_learners: s.who.size,
      items_completed: s.done,
      submissions: s.sub,
      attempts: s.att,
      video_seconds: s.vs,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}
async function offeringDayActual() {
  const rows = await q(
    'SELECT *, day::text AS d FROM lms.rollup_offering_day WHERE tenant_id=$1 AND offering_id=$2 ORDER BY day',
    [A.tenantId, e.offeringId],
  );
  return rows.map((r) => ({
    day: r.d as string,
    active_learners: r.active_learners,
    items_completed: r.items_completed,
    submissions: r.submissions,
    attempts: r.attempts,
    video_seconds: r.video_seconds,
  }));
}

async function tenantDayReference() {
  const tenant = A.tenantId;
  const learnerUsers = new Set(
    (
      await q(
        `SELECT DISTINCT tm.user_id FROM lms.course_participants p JOIN lms.tenant_memberships tm ON tm.tenant_id=p.tenant_id AND tm.id=p.membership_id WHERE p.tenant_id=$1 AND p.participation='learner'`,
        [tenant],
      )
    ).map((r) => r.user_id),
  );
  const map = new Map<string, { users: Set<string>; vs: number }>();
  const slot = (d: string) => {
    if (!map.has(d)) map.set(d, { users: new Set(), vs: 0 });
    return map.get(d)!;
  };
  for (const r of await q(
    'SELECT user_id, day::text AS d FROM lms.member_activity_days WHERE tenant_id=$1',
    [tenant],
  ))
    slot(r.d).users.add(r.user_id);
  for (const r of await q(
    'SELECT day::text AS d, seconds FROM lms.video_watch_days WHERE tenant_id=$1',
    [tenant],
  ))
    slot(r.d).vs += r.seconds;
  return [...map.entries()]
    .map(([d, s]) => ({
      day: d,
      active_users: s.users.size,
      active_learners: [...s.users].filter((u) => learnerUsers.has(u)).length,
      video_seconds: s.vs,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}
async function tenantDayActual() {
  const rows = await q(
    'SELECT *, day::text AS d FROM lms.rollup_tenant_day WHERE tenant_id=$1 ORDER BY day',
    [A.tenantId],
  );
  return rows.map((r) => ({
    day: r.d as string,
    active_users: r.active_users,
    active_learners: r.active_learners,
    video_seconds: Number(r.video_seconds),
  }));
}

// ------------------------------------------------------------------------------------------ mutations (owner SQL)
async function mutate(rand: () => number) {
  const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)]!;
  const ops = [
    async () => {
      const [p, it] = [pick(pids), pick(textItems)];
      await owner.query(
        `INSERT INTO lms.item_progress (tenant_id, participant_id, item_id, offering_id, status, completed_at, completed_how, last_activity_at)
         VALUES ($1,$2,$3,$4,'completed', now() - ($5 || ' hours')::interval, 'manual', now() - ($5 || ' hours')::interval)
         ON CONFLICT (tenant_id, participant_id, item_id) DO UPDATE SET status='completed', completed_at=EXCLUDED.completed_at, completed_how='manual', last_activity_at=EXCLUDED.last_activity_at`,
        [A.tenantId, p, it.id, e.offeringId, String(Math.floor(rand() * 400))],
      );
    },
    async () => {
      await owner.query(
        `UPDATE lms.item_progress SET status='in_progress', completed_at=NULL, completed_how=NULL WHERE participant_id=$1 AND item_id=$2`,
        [pick(pids), pick(textItems).id],
      );
    },
    async () => {
      await owner.query(
        `UPDATE lms.content_items SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`,
        [pick(textItems).id, String(Math.floor(rand() * 20))],
      );
    },
    async () => {
      const a = pick(asgItems);
      await owner.query(
        `UPDATE lms.assignments SET due_at = now() + ($2 || ' hours')::interval WHERE item_id = $1 AND opens_at IS NULL`,
        [a.id, String(Math.floor(rand() * 200) - 100)],
      );
    },
    async () => {
      await owner.query(
        `INSERT INTO lms.assignment_extensions (tenant_id, assignment_item_id, participant_id, extended_due_at, set_by)
         VALUES ($1,$2,$3, now() + ($4 || ' hours')::interval, $5)
         ON CONFLICT (tenant_id, assignment_item_id, participant_id) DO UPDATE SET extended_due_at = EXCLUDED.extended_due_at`,
        [
          A.tenantId,
          pick(asgItems).id,
          pick(pids),
          String(Math.floor(rand() * 200) - 100),
          e.instructor.userId,
        ],
      );
    },
    async () => {
      const a = pick(asgItems);
      const p = pick(pids);
      await owner.query(
        `INSERT INTO lms.submissions (id, tenant_id, assignment_item_id, offering_id, participant_id, version_no, text_body, request_key)
         VALUES ($1,$2,$3,$4,$5, 50 + $6::int, 'generated', $7) ON CONFLICT DO NOTHING`,
        [newId(), A.tenantId, a.id, e.offeringId, p, Math.floor(rand() * 40), newId()],
      );
    },
    // Source rows carry the COLLEGE-LOCAL day (what the product writes: lms.local_day) and not the database session's date: between
    // 18:30 and 24:00 UTC the IST date is one ahead of the UTC date, and a row dated by the session fell outside the rollup's day window
    // (the CI run at 00:08 IST failed all three seeds). The reference below still counts every source row; nothing about it changed.
    async () => {
      await owner.query(
        `INSERT INTO lms.video_watch_days (tenant_id, participant_id, item_id, asset_id, day, seconds)
         VALUES ($1,$2,$3,$4, lms.local_day(now(), $7) - $5::int, $6)
         ON CONFLICT (tenant_id, participant_id, item_id, asset_id, day) DO UPDATE SET seconds = EXCLUDED.seconds`,
        [
          A.tenantId,
          pick(pids),
          pick(textItems).id,
          '00000000-0000-7000-8000-000000000001',
          Math.floor(rand() * 2),
          1 + Math.floor(rand() * 600),
          TZ,
        ],
      );
    },
    async () => {
      const u = pick(e.learners).userId;
      await owner.query(
        `INSERT INTO lms.member_activity_days (tenant_id, user_id, day) VALUES ($1,$2, lms.local_day(now(), $4) - $3::int) ON CONFLICT DO NOTHING`,
        [A.tenantId, u, Math.floor(rand() * 2), TZ],
      );
    },
  ];
  await pick(ops)();
}

async function drain(now = new Date()) {
  await t.app.modules.analytics.service.refreshTenant(A.tenantId, now);
}

describe('rollups equal a direct computation from the source tables', () => {
  it('after the first refresh', async () => {
    const now = new Date();
    await drain(now);
    expect(await actualLearners()).toEqual(await reference(now));
    expect(await offeringDayActual()).toEqual(await offeringDayReference());
    // nothing is marked any more
    const left = await q(
      'SELECT count(*)::int AS n FROM lms.rollup_dirty_participants WHERE tenant_id = $1',
      [A.tenantId],
    );
    expect(left[0].n).toBe(0);
  });

  for (const seed of [1, 2, 3]) {
    it(`after random mutations and partial refreshes in random order (seed ${seed})`, async () => {
      const rand = rng(seed);
      for (let round = 0; round < 6; round++) {
        for (let k = 0; k < 1 + Math.floor(rand() * 5); k++) await mutate(rand);
        // a refresh with a tiny random batch size: only some of the marked learners are recomputed
        const batch = 1 + Math.floor(rand() * 3);
        await owner.query('SELECT lms.rollup_run_tenant($1, now(), $2)', [A.tenantId, batch]);
      }
      const now = new Date();
      await drain(now);
      expect(await actualLearners()).toEqual(await reference(now));
      expect(await offeringDayActual()).toEqual(await offeringDayReference());
      expect(await tenantDayActual()).toEqual(await tenantDayReference());
    });
  }

  it('a second refresh changes nothing (idempotent), and recomputing a learner twice gives the same row', async () => {
    const before = await q(
      'SELECT * FROM lms.rollup_learner_offering WHERE tenant_id=$1 ORDER BY participant_id',
      [A.tenantId],
    );
    const dayBefore = await q(
      'SELECT * FROM lms.rollup_offering_day WHERE tenant_id=$1 ORDER BY offering_id, day',
      [A.tenantId],
    );
    const now = new Date();
    await drain(now);
    await drain(now);
    const strip = (rows: Json[]) => rows.map(({ computed_at: _c, ...r }) => r);
    expect(
      strip(
        await q(
          'SELECT * FROM lms.rollup_learner_offering WHERE tenant_id=$1 ORDER BY participant_id',
          [A.tenantId],
        ),
      ),
    ).toEqual(strip(before));
    expect(
      await q(
        'SELECT * FROM lms.rollup_offering_day WHERE tenant_id=$1 ORDER BY offering_id, day',
        [A.tenantId],
      ),
    ).toEqual(dayBefore);
  });

  it('the clock alone moves a row: a deadline that passes counts as missed at the next refresh', async () => {
    const item = await addAssignment(e, { title: 'Soon due' });
    await setDates(owner, item.id, {
      opensAt: null,
      dueAt: new Date(Date.now() + 60_000).toISOString(),
      cutoffAt: null,
    });
    const now = new Date();
    await drain(now);
    const missed = async () => (await actualLearners()).map((r) => r.missed_deadlines);
    const before = await missed();
    // two minutes later: no row of the source changed, only the time
    await drain(new Date(now.getTime() + 120_000));
    const after = await missed();
    expect(after.map((v, i) => v - before[i]!)).toEqual(before.map(() => 1));
  });

  it('a learner who leaves the offering loses the rollup row', async () => {
    const [id] = pids.slice(-1);
    await owner.query(
      `UPDATE lms.course_participants SET status='removed', removed_reason='manual' WHERE id=$1`,
      [id],
    );
    await drain();
    expect((await actualLearners()).map((r) => r.participant_id)).not.toContain(id);
    await owner.query(
      `UPDATE lms.course_participants SET status='active', removed_reason=NULL WHERE id=$1`,
      [id],
    );
    await drain();
    expect((await actualLearners()).map((r) => r.participant_id)).toContain(id);
  });

  it('"data as of" is the run time when nothing is waiting, and the oldest waiting change when something is', async () => {
    await drain();
    const s1 = (
      await q(
        `SELECT as_of, watermark FROM lms.rollup_state WHERE tenant_id=$1 AND kind='learner'`,
        [A.tenantId],
      )
    )[0];
    expect(new Date(s1.as_of).getTime()).toBe(new Date(s1.watermark).getTime());
    await owner.query('UPDATE lms.course_participants SET updated_at = now() WHERE id = $1', [
      pids[0],
    ]);
    // marks exist now; a run with batch 0 recomputes nobody, so as_of must stay before the run time
    // (a few ms later: both are compared in whole milliseconds, and a fast machine can land in the same one)
    await new Promise((r) => setTimeout(r, 15));
    await owner.query('SELECT lms.rollup_run_tenant($1, now(), 0)', [A.tenantId]);
    const s2 = (
      await q(
        `SELECT as_of, watermark FROM lms.rollup_state WHERE tenant_id=$1 AND kind='learner'`,
        [A.tenantId],
      )
    )[0];
    expect(new Date(s2.as_of).getTime()).toBeLessThan(new Date(s2.watermark).getTime());
    await drain();
  });
});

describe('the refresh and a content edit of the same offering do not wait on each other', () => {
  it('a refresh finishes while an edit holds the offering lock; a second edit still waits (no deadlock cycle)', async () => {
    const dialect = new PgDialect();
    const lockQuery = dialect.sqlToQuery(
      sql`WITH ${accessCte({
        tenantId: A.tenantId,
        userId: newId(),
        offeringId: e.offeringId,
        viewAll: true,
        accountAllowed: true,
        allowedBy: [],
        lock: true,
      })} SELECT id FROM acc`,
    );
    // a change of one of this offering's learners, so the refresh writes its rollup rows (FK to the offering)
    await owner.query(
      `INSERT INTO lms.rollup_dirty_participants (tenant_id, participant_id) VALUES ($1, $2)
       ON CONFLICT (tenant_id, participant_id) DO UPDATE SET marked_at = clock_timestamp()`,
      [A.tenantId, pids[0]],
    );
    const edit = await owner.connect();
    const other = await owner.connect();
    try {
      await edit.query('BEGIN');
      expect((await edit.query(lockQuery.sql, lockQuery.params)).rows).toHaveLength(1);
      await other.query(`SET lock_timeout = '1500ms'`);
      // the refresh: it used to wait here for FOR UPDATE (its FK check takes FOR KEY SHARE on the offering)
      await other.query('SELECT lms.rollup_run_tenant($1, now(), 500)', [A.tenantId]);
      const left = await other.query(
        'SELECT count(*)::int AS n FROM lms.rollup_dirty_participants WHERE tenant_id = $1 AND participant_id = $2',
        [A.tenantId, pids[0]],
      );
      expect(left.rows[0].n).toBe(0);
      // two mutations of the same offering are still serialised
      await expect(other.query(lockQuery.sql, lockQuery.params)).rejects.toMatchObject({
        code: '55P03',
      });
    } finally {
      await edit.query('ROLLBACK');
      await other.query('RESET lock_timeout').catch(() => undefined);
      edit.release();
      other.release();
    }
  });
});

describe('minutesAgo helper is available for the other suites', () => {
  it('works', () => expect(new Date(minutesAgo(5)).getTime()).toBeLessThan(Date.now()));
});

// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import type { TestClient } from './client';
import {
  errorCode,
  type Json,
  loginAs,
  ok,
  type Person,
  person,
  type Structure,
  structure,
} from './courses-helpers';
import {
  base,
  type Class,
  gradebookClass,
  participantIds,
  quiz,
  releaseQuiz,
} from './gradebook-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';
import { readZip } from './zip-read';

// Step 11: the approval workflow (draft -> submitted -> returned / locked), what a submission needs, the lock and its immutable
// snapshot, unlock and versions, self-approval, who is left out of a snapshot, export (CSV / XLSX), the approval queue.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let admin2: Person;
let st: Structure;
let e: Class;
let pids: string[];
let ic: TestClient;
let ac: TestClient;
let b: string;
let cats: Record<string, string> = {};
let items: Record<string, string> = {};
let q2: Json;

const SCALE = {
  name: 'Standard',
  bands: [
    { minPercent: 0, label: 'RA', isPass: false },
    { minPercent: 50, label: 'C', isPass: true },
    { minPercent: 70, label: 'B+', isPass: true },
    { minPercent: 80, label: 'A', isPass: true },
  ],
};

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({});
  A = await createAuthFixture(owner, 'gbwf-a');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  admin2 = await person(owner, t, A, 'Admin Two', { role: 'institution_admin' });
  st = await structure(admin);
  e = await gradebookClass(owner, t, A, admin, st, ['Asha', 'Bala', 'Chitra']);
  pids = await participantIds(owner, e.offeringId, e.learners);
  ic = e.instructor.client;
  ac = e.assistant.client;
  b = base(e.offeringId);

  // structure: Tests 60 % (one manual item), Quizzes 40 % (two auto items); out of 40
  const cfg = ok(
    await ic.put(`${b}/categories`, {
      categories: [
        { name: 'Tests', weight: 60, dropLowest: 0, missingPolicy: 'exclude' },
        { name: 'Quizzes', weight: 40, dropLowest: 0, missingPolicy: 'exclude' },
      ],
    }),
  );
  cats = Object.fromEntries(cfg.categories.map((c: Json) => [c.name, c.id]));
  const q1 = await quiz(e, 'Quiz 1', [true, false, null]); // immediate results: visible (and so "released") at once
  q2 = await quiz(e, 'Quiz 2', [true, null, null], { resultsVisibility: 'manual' });
  const g = ok(
    await ic.put(`${b}/items`, {
      items: [
        {
          source: 'manual',
          title: 'Test 1',
          categoryId: cats.Tests,
          points: 50,
          extraCredit: false,
          released: true,
        },
        {
          source: 'assessment',
          contentItemId: q1.id,
          categoryId: cats.Quizzes,
          points: 10,
          extraCredit: false,
        },
        {
          source: 'assessment',
          contentItemId: q2.id,
          categoryId: cats.Quizzes,
          points: 10,
          extraCredit: false,
        },
      ],
    }),
  );
  items = Object.fromEntries(g.items.map((i: Json) => [i.title, i.id]));
  ok(
    await ic.patch(`${b}/settings`, {
      weighted: true,
      outOf: 40,
      roundMode: 'half_up',
      roundDecimals: 0,
    }),
  );
  ok(
    await ic.put(`${b}/marks`, {
      cells: [
        { itemId: items['Test 1'], participantId: pids[0], points: '40' },
        { itemId: items['Test 1'], participantId: pids[1], points: '25' },
      ],
    }),
  );
}, 180_000);
afterAll(async () => {
  await t.close();
  await owner.end();
});

const status = async () => (ok(await ic.get(b)) as Json).status as string;

describe('submitting', () => {
  it('is refused with every problem: no grade scale, and a quiz whose results learners cannot see yet', async () => {
    const r = await ic.post(`${b}/submit`);
    expect(r.statusCode).toBe(409);
    expect(errorCode(r)).toBe('gradebook_not_ready');
    expect(r.json().error.message).toMatch(/grade scale/i);
    expect(r.json().error.message).toMatch(/cannot see/i);
    const review = ok(await ic.get(`${b}/review`));
    expect(review.problems.map((p: Json) => p.code).sort()).toEqual(['no_scale', 'unreleased']);
    expect(review.problems.find((p: Json) => p.code === 'unreleased').items).toEqual(['Quiz 2']);
    expect(await status()).toBe('draft');
  });

  it('weights that do not add up to 100 are a problem in a weighted gradebook', async () => {
    ok(
      await ic.put(`${b}/categories`, {
        categories: [
          { id: cats.Tests, name: 'Tests', weight: 60, dropLowest: 0, missingPolicy: 'exclude' },
          {
            id: cats.Quizzes,
            name: 'Quizzes',
            weight: 30,
            dropLowest: 0,
            missingPolicy: 'exclude',
          },
        ],
      }),
    );
    expect(ok(await ic.get(`${b}/review`)).problems.map((p: Json) => p.code)).toContain('weights');
    ok(
      await ic.put(`${b}/categories`, {
        categories: [
          { id: cats.Tests, name: 'Tests', weight: 60, dropLowest: 0, missingPolicy: 'exclude' },
          {
            id: cats.Quizzes,
            name: 'Quizzes',
            weight: 40,
            dropLowest: 0,
            missingPolicy: 'exclude',
          },
        ],
      }),
    );
  });

  it('succeeds once the problems are fixed; then nothing can change until it is approved or returned', async () => {
    const scale = ok(await admin.post('/grade-scales', SCALE));
    ok(await ic.patch(`${b}/settings`, { scaleId: scale.id }));
    await releaseQuiz(e, q2.id);
    expect(ok(await ic.get(`${b}/review`)).problems).toEqual([]);
    expect((await ac.post(`${b}/submit`)).statusCode).toBe(403);
    ok(await ic.post(`${b}/submit`));
    expect(await status()).toBe('submitted');
    const locked = async (res: { statusCode: number; json(): Json }) => {
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe('gradebook_locked');
    };
    await locked(
      await ic.put(`${b}/marks`, {
        cells: [{ itemId: items['Test 1'], participantId: pids[2], points: '1' }],
      }),
    );
    await locked(await ic.patch(`${b}/settings`, { outOf: 50 }));
    await locked(
      await ic.put(`${b}/categories`, {
        categories: [{ name: 'X', weight: 1, dropLowest: 0, missingPolicy: 'exclude' }],
      }),
    );
    await locked(await ic.put(`${b}/items`, { items: [] }));
    await locked(
      await ic.put(`${b}/learners/${pids[2]}/override`, {
        itemId: null,
        points: '5',
        reason: 'because',
      }),
    );
    await locked(
      await ic
        .post(`${b}/submit`)
        .then((r) => ({ statusCode: r.statusCode, json: () => r.json() })),
    );
  });
});

describe('approval', () => {
  it('only an institution admin approves or returns; the instructor and an assistant cannot', async () => {
    for (const c of [ic, ac, e.learners[0]!.client]) {
      expect((await c.post(`${b}/approve`, {})).statusCode).toBe(403);
      expect((await c.post(`${b}/return`, { comment: 'no way' })).statusCode).toBe(403);
    }
    expect((await admin.post(`${b}/return`, {})).statusCode).toBe(400); // a comment is required
  });

  it('a returned gradebook comes back to the instructor with the comment, can be edited and submitted again', async () => {
    const r = ok(await admin.post(`${b}/return`, { comment: 'Please moderate the quiz marks' }));
    expect(r.status).toBe('returned');
    const g = ok(await ic.get(b));
    expect(g).toMatchObject({
      status: 'returned',
      reviewComment: 'Please moderate the quiz marks',
    });
    expect(g.events[0]).toMatchObject({
      action: 'returned',
      comment: 'Please moderate the quiz marks',
    });
    ok(
      await ic.put(`${b}/marks`, {
        cells: [{ itemId: items['Test 1'], participantId: pids[1], points: '30' }],
      }),
    );
    ok(await ic.post(`${b}/submit`));
    expect((await ic.get(b)).json().reviewComment).toBeNull();
  });

  it('approving locks the gradebook and freezes one snapshot row per active learner, with the explanation', async () => {
    // a learner is removed from the offering and another from the college: both are left out, with reasons
    const extra1 = await person(owner, t, A, 'Gone From Class');
    const extra2 = await person(owner, t, A, 'Gone From College');
    for (const [p, reason] of [
      [extra1, 'manual'],
      [extra2, 'membership'],
    ] as const) {
      ok(
        await admin.post(`/offerings/${e.offeringId}/participants`, {
          userId: p.userId,
          participation: 'learner',
        }),
      );
      await owner.query(
        `UPDATE lms.course_participants SET status = 'removed', removed_reason = $3
          WHERE offering_id = $1 AND membership_id = $2`,
        [e.offeringId, p.membershipId, reason],
      );
    }
    await owner.query(`UPDATE lms.tenant_memberships SET status = 'removed' WHERE id = $1`, [
      extra2.membershipId,
    ]);
    const review = ok(await admin.get(`${b}/review`));
    expect(review.excluded.map((x: Json) => [x.name, x.reason]).sort()).toEqual(
      [
        ['Gone From Class', 'removed_from_offering'],
        ['Gone From College', 'removed_from_college'],
      ].sort(),
    );
    expect(review.stats).toMatchObject({ learners: 3, withFinal: 2 });
    expect(review.submittedBy).toBe('Instructor');

    const live = ok(await ic.get(`${b}/grid`));
    const r = ok(await admin.post(`${b}/approve`, { comment: 'Looks right' }));
    expect(r).toEqual({ status: 'locked', versionNo: 1 });
    const g = ok(await admin.get(b));
    expect(g.status).toBe('locked');
    expect(g.lockedVersions).toHaveLength(1);
    expect(g.lockedVersions[0]).toMatchObject({
      versionNo: 1,
      learnerCount: 3,
      selfApproved: false,
    });
    // the snapshot metadata lists everybody who is not in it
    expect(g.lockedVersions[0].excluded.map((x: Json) => x.reason).sort()).toEqual([
      'removed_from_college',
      'removed_from_offering',
    ]);
    const { rows } = await owner.query(
      `SELECT s.display_name, s.final_marks, s.grade, s.explanation FROM lms.gradebook_snapshot_rows s
         JOIN lms.gradebook_versions v ON v.id = s.version_id JOIN lms.gradebooks g ON g.id = v.gradebook_id
        WHERE g.offering_id = $1 ORDER BY s.sort_key`,
      [e.offeringId],
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((x) => x.display_name)).not.toContain('Gone From College');
    // frozen = what the grid showed at the lock
    const byName = new Map(live.rows.map((x: Json) => [x.name, x]));
    for (const row of rows) {
      const l = byName.get(row.display_name) as Json;
      expect(row.final_marks === null ? null : Number(row.final_marks)).toBe(l.finalMarks);
      expect(row.explanation).toHaveProperty('categories');
    }
    // 0.6 * (40/50) + 0.4 * 100 -> 88 % of 40 = 35.2 -> 35 ; Chitra has nothing to count
    expect(rows.find((x) => x.display_name === 'Asha')).toMatchObject({ grade: 'A' });
    expect(Number(rows.find((x) => x.display_name === 'Asha')!.final_marks)).toBe(35);
    expect(rows.find((x) => x.display_name === 'Chitra')!.final_marks).toBeNull();
    const audit = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE action = 'gradebook.approved'`,
    );
    expect(audit.rows[0].metadata).toMatchObject({ selfApproved: false, learners: 3, excluded: 2 });
  });
});

describe('the lock is immutable', () => {
  let before: Json[];
  const snapshot = async () =>
    (
      await owner.query(
        `SELECT s.participant_id, s.final_marks, s.grade, s.cells, s.cats, s.explanation
           FROM lms.gradebook_snapshot_rows s JOIN lms.gradebook_versions v ON v.id = s.version_id
          JOIN lms.gradebooks g ON g.id = v.gradebook_id WHERE g.offering_id = $1 AND v.version_no = 1
          ORDER BY s.participant_id`,
        [e.offeringId],
      )
    ).rows;

  it('a score changed after the lock (a regrade, a late correction) never alters the snapshot; the live grid follows', async () => {
    before = await snapshot();
    await owner.query(
      `UPDATE lms.manual_marks SET points = 5 WHERE item_id = $1 AND participant_id = $2`,
      [items['Test 1'], pids[0]],
    );
    await owner.query(`UPDATE lms.attempts SET score = 0 WHERE participant_id = $1`, [pids[0]]);
    const live = ok(await ic.get(`${b}/grid`)).rows.find((r: Json) => r.participantId === pids[0]);
    expect(live.finalMarks).toBeLessThan(35);
    expect(await snapshot()).toEqual(before);
  });

  it('the structure cannot change either (409), and the learner sees the frozen record', async () => {
    expect((await ic.patch(`${b}/settings`, { outOf: 100 })).statusCode).toBe(409);
    const mine = ok(await e.learners[0]!.client.get(`/offerings/${e.offeringId}/me/grades`));
    expect(mine).toMatchObject({
      status: 'locked',
      provisional: false,
      underRevision: false,
      versionNo: 1,
    });
    expect(mine.final).toMatchObject({ marks: 35, grade: 'A', isPass: true });
  });

  it('lms_app cannot update or delete a snapshot, a version or an event, not even through SQL', async () => {
    const { testAppPool } = await import('./support');
    const app = testAppPool();
    try {
      const c = await app.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [A.tenantId]);
        for (const sql of [
          `UPDATE lms.gradebook_snapshot_rows SET final_marks = 40`,
          `DELETE FROM lms.gradebook_snapshot_rows`,
          `UPDATE lms.gradebook_versions SET learner_count = 0`,
          `DELETE FROM lms.gradebook_events`,
        ]) {
          await c.query('SAVEPOINT s');
          await expect(c.query(sql), sql).rejects.toThrow();
          await c.query('ROLLBACK TO SAVEPOINT s');
        }
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    } finally {
      await app.end();
    }
    // the owner is stopped by the trigger as well
    await expect(
      owner.query(`UPDATE lms.gradebook_snapshot_rows SET final_marks = 40`),
    ).rejects.toThrow(/append-only/);
    await expect(owner.query(`DELETE FROM lms.gradebook_versions`)).rejects.toThrow(/append-only/);
    expect(await snapshot()).toEqual(before);
  });
});

describe('unlock and versions', () => {
  it('needs an admin and a reason; starts version 2 as a draft; the old snapshot and its history stay', async () => {
    expect((await ic.post(`${b}/unlock`, { reason: 'I want to change it' })).statusCode).toBe(403);
    expect((await admin.post(`${b}/unlock`, { reason: 'x' })).statusCode).toBe(400);
    const r = ok(await admin.post(`${b}/unlock`, { reason: 'A mark was entered wrongly' }));
    expect(r).toEqual({ status: 'draft', versionNo: 2 });
    const g = ok(await ic.get(b));
    expect(g).toMatchObject({ status: 'draft', versionNo: 2 });
    expect(g.lockedVersions.map((v: Json) => v.versionNo)).toEqual([1]);
    expect(g.events.map((x: Json) => x.action)).toEqual([
      'unlocked',
      'approved',
      'submitted',
      'returned',
      'submitted',
    ]);
    const audit = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE action = 'gradebook.unlocked'`,
    );
    expect(audit.rows[0].metadata).toMatchObject({
      reason: 'A mark was entered wrongly',
      lockedVersionNo: 1,
      newVersionNo: 2,
    });
    // not locked any more: unlocking again is refused
    expect(errorCode(await admin.post(`${b}/unlock`, { reason: 'again please' }))).toBe(
      'gradebook_not_locked',
    );
  });

  it('while it is a draft again the learner sees provisional figures with an "under revision" notice, not the old final', async () => {
    const mine = ok(await e.learners[0]!.client.get(`/offerings/${e.offeringId}/me/grades`));
    expect(mine).toMatchObject({ provisional: true, underRevision: true, versionNo: 2 });
    expect(mine.final.grade).toBeNull();
  });

  it('a corrected gradebook is submitted, approved (version 2) and both snapshots can be exported', async () => {
    ok(
      await ic.put(`${b}/marks`, {
        cells: [{ itemId: items['Test 1'], participantId: pids[0], points: '45' }],
      }),
    );
    ok(await ic.post(`${b}/submit`));
    expect(ok(await admin2.client.post(`${b}/approve`, {})).versionNo).toBe(2);
    const csv = (v: number) => admin.get(`${b}/export.csv?version=${v}`).then((r) => r.body);
    const v1 = await csv(1);
    const v2 = await csv(2);
    expect(v1).not.toEqual(v2);
    expect(v1.split('\r\n')[0]).toBe(
      'Register number,Name,Test 1,Quiz 1,Quiz 2,Tests (%),Quizzes (%),Final marks,Final percent,Grade',
    );
    const asha1 = v1.split('\r\n').find((l) => l.includes(',Asha,'))!;
    const asha2 = v2.split('\r\n').find((l) => l.includes(',Asha,'))!;
    expect(asha1).toContain(',40,10,10,80,100,35,');
    // version 2 carries the correction made after the first lock: the quiz scores were set to 0 and Test 1 raised to 45
    expect(asha2).toContain(',45,0,0,90,0,');
    expect((await admin.get(`${b}/export.csv?version=9`)).statusCode).toBe(404);
  });
});

describe('export', () => {
  it('follows the configured column layout; CSV neutralises formulas; the XLSX has numeric cells, inline strings and no formula element', async () => {
    // a learner whose name would run as a formula in a spreadsheet
    await owner.query(
      `UPDATE lms.users SET display_name = '=HYPERLINK("http://evil.example","x")' WHERE id = $1`,
      [e.learners[2]!.userId],
    );
    ok(await admin.post(`${b}/unlock`, { reason: 'Layout and name correction' }));
    ok(
      await ic.patch(`${b}/settings`, {
        exportLayout: [
          { key: 'register', header: 'Reg No' },
          { key: 'name', header: 'Student' },
          { key: `item:${items['Test 1']}`, header: 'Internal 1' },
          { key: 'final', header: 'Total (40)' },
          { key: 'grade', header: 'Grade' },
          { key: `item:00000000-0000-4000-8000-000000000000`, header: 'Unknown column is skipped' },
        ],
      }),
    );
    ok(await ic.post(`${b}/submit`));
    ok(await admin2.client.post(`${b}/approve`, {}));
    const csv = (await admin.get(`${b}/export.csv`)).body.split('\r\n');
    expect(csv[0]).toBe('Reg No,Student,Internal 1,Total (40),Grade');
    const evil = csv.find((l) => l.includes('HYPERLINK'))!;
    expect(evil).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    // XLSX
    const x = await admin.get(`${b}/export.xlsx`);
    expect(x.statusCode).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml.sheet');
    const files = readZip(x.rawPayload);
    expect(Object.keys(files).sort()).toEqual(
      [
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/_rels/workbook.xml.rels',
        'xl/styles.xml',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml',
      ].sort(),
    );
    const sheet = files['xl/worksheets/sheet1.xml']!.toString('utf8');
    expect(sheet).not.toMatch(/<f[ >/]/); // never a formula element
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).toMatch(/<c r="C\d+"[^>]*><v>45<\/v><\/c>/); // a mark is a NUMBER
    expect(sheet).toMatch(/<c r="D\d+"[^>]*><v>\d+(\.\d+)?<\/v><\/c>/); // the final too
    expect(sheet).toContain('=HYPERLINK(&quot;http://evil.example&quot;,&quot;x&quot;)'); // inert text
    expect(sheet).toContain('Internal 1');
  });

  it('assistants may export (read access), learners may not, and an unapproved gradebook has nothing to export', async () => {
    expect((await ac.get(`${b}/export.csv`)).statusCode).toBe(200);
    expect((await e.learners[0]!.client.get(`${b}/export.csv`)).statusCode).toBe(403);
    const other = await gradebookClass(owner, t, A, admin, st, ['Zed']);
    const r = await other.instructor.client.get(`${base(other.offeringId)}/export.xlsx`);
    expect(r.statusCode).toBe(404);
    expect(errorCode(r)).toBe('no_locked_version');
  });
});

describe('self-approval', () => {
  it('is refused by default for the person who submitted (403, audited); allowed when the college says so (audited)', async () => {
    // the admin is also an instructor of this offering and submits it themselves
    const o = await gradebookClass(owner, t, A, admin, st, ['Self']);
    ok(
      await admin.post(`/offerings/${o.offeringId}/participants`, {
        userId: A.adminUserId,
        participation: 'instructor',
      }),
    );
    const ob = base(o.offeringId);
    const scale = ok(await admin.post('/grade-scales', { ...SCALE, name: 'Self scale' }));
    ok(await admin.patch(`${ob}/settings`, { scaleId: scale.id }));
    const cat = ok(await admin.get(ob)).categories[0].id;
    ok(
      await admin.put(`${ob}/items`, {
        items: [
          {
            source: 'manual',
            title: 'Viva',
            categoryId: cat,
            points: 10,
            extraCredit: false,
            released: true,
          },
        ],
      }),
    );
    ok(await admin.post(`${ob}/submit`));
    const refused = await admin.post(`${ob}/approve`, {});
    expect(refused.statusCode).toBe(403);
    expect(errorCode(refused)).toBe('self_approval_not_allowed');
    expect(refused.json().error.message).toMatch(/submitted this gradebook/);
    expect((await admin.post(`${ob}/return`, { comment: 'my own work' })).statusCode).toBe(403);
    expect(ok(await admin.get(ob)).status).toBe('submitted');
    let a = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE action = 'gradebook.self_approval_refused' ORDER BY created_at`,
    );
    expect(a.rows.map((r) => r.metadata.attempted)).toEqual(['approve', 'return']);
    // another admin may
    expect(ok(await admin2.client.get(`${ob}/review`)).status).toBe('submitted');
    // the college allows self-approval (only an admin with tenant.manage changes it)
    expect((await ic.patch('/gradebook/settings', { allowSelfApproval: true })).statusCode).toBe(
      403,
    );
    expect(ok(await admin.get('/gradebook/settings'))).toEqual({ allowSelfApproval: false });
    expect(ok(await admin.patch('/gradebook/settings', { allowSelfApproval: true }))).toEqual({
      allowSelfApproval: true,
    });
    ok(await admin.post(`${ob}/approve`, {}));
    const g = ok(await admin.get(ob));
    expect(g.lockedVersions[0].selfApproved).toBe(true);
    expect(g.events[0]).toMatchObject({ action: 'approved', selfApproved: true });
    a = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE action = 'gradebook.approved' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(a.rows[0].metadata).toMatchObject({ selfApproved: true });
    const s = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE action = 'gradebook.settings_changed'`,
    );
    expect(s.rows[0].metadata).toEqual({
      before: { allowSelfApproval: false },
      after: { allowSelfApproval: true },
    });
    ok(await admin.patch('/gradebook/settings', { allowSelfApproval: false }));
  });
});

describe('the approval queue', () => {
  it("lists the college's gradebooks by status (keyset), for institution admins only", async () => {
    const o = await gradebookClass(owner, t, A, admin, st, ['Queue']);
    const ob = base(o.offeringId);
    const scale = ok(await admin.get('/grade-scales')).items[0];
    ok(await o.instructor.client.patch(`${ob}/settings`, { scaleId: scale.id }));
    const cat = ok(await o.instructor.client.get(ob)).categories[0].id;
    ok(
      await o.instructor.client.put(`${ob}/items`, {
        items: [
          {
            source: 'manual',
            title: 'M',
            categoryId: cat,
            points: 10,
            extraCredit: false,
            released: true,
          },
        ],
      }),
    );
    ok(await o.instructor.client.post(`${ob}/submit`));
    const q = ok(await admin.get('/gradebook/queue'));
    expect(
      q.items.some(
        (x: Json) =>
          x.offeringId === o.offeringId &&
          x.status === 'submitted' &&
          x.submittedBy === 'Instructor',
      ),
    ).toBe(true);
    expect(q.items.every((x: Json) => x.status === 'submitted')).toBe(true);
    expect(
      ok(await admin.get('/gradebook/queue?status=locked')).items.every(
        (x: Json) => x.status === 'locked',
      ),
    ).toBe(true);
    const p1 = ok(await admin.get('/gradebook/queue?status=locked&limit=1'));
    expect(p1.items).toHaveLength(1);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = ok(
      await admin.get(
        `/gradebook/queue?status=locked&limit=1&after=${encodeURIComponent(p1.nextCursor)}`,
      ),
    );
    expect(p2.items[0].gradebookId).not.toBe(p1.items[0].gradebookId);
    expect((await o.instructor.client.get('/gradebook/queue')).statusCode).toBe(403);
    expect((await o.learners[0]!.client.get('/gradebook/queue')).statusCode).toBe(403);
  });
});

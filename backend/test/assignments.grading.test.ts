// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import {
  addAssignment,
  base,
  classOf,
  handIn,
  inHours,
  keyFromDb,
  me,
  minutesAgo,
  pickLevels,
  queue,
  rubricInput,
  setDates,
} from './assignments-helpers';
import type { TestClient } from './client';
import { errorCode, type Json, loginAs, ok, type Structure, structure } from './courses-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Step 10: rubrics (versions), the grading queue and its statuses, grading with and without a rubric, overrides, the
// late penalty (shown separately, waivable), release (per assignment and per learner), what the learner sees.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let st: Structure;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'asg-g');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

describe('rubrics', () => {
  let course: string;
  let c: TestClient;
  let assistant: TestClient;
  let learner: TestClient;
  beforeAll(async () => {
    const e = await classOf(owner, t, A, admin, st, ['Rita']);
    course = e.courseId;
    c = e.instructor.client;
    assistant = e.assistant.client;
    learner = e.learners[0]!.client;
  });

  it('creates a rubric (criteria x levels x points), ids are made, the maximum is the sum of the best levels', async () => {
    const r = ok(await c.post(`/courses/${course}/rubrics`, rubricInput()));
    expect(r).toMatchObject({ versionNo: 1, maxPoints: 15, archived: false, usedBy: 0 });
    expect(r.criteria).toHaveLength(2);
    expect(r.criteria[0].id).toMatch(/^[0-9a-f]{12}$/);
    expect(r.criteria[0].levels[2].id).toMatch(/^[0-9a-f]{12}$/);
  });

  it('an edit adds a VERSION and keeps the ids of what survives; the old version stays in the database', async () => {
    const r1 = ok(await c.post(`/courses/${course}/rubrics`, rubricInput('v')));
    const edited = rubricInput('v2');
    edited.criteria[0].id = r1.criteria[0].id;
    edited.criteria[0].levels[0].id = r1.criteria[0].levels[0].id;
    edited.criteria[0].levels.push({ title: 'Outstanding', points: 12 });
    const r2 = ok(await c.put(`/courses/${course}/rubrics/${r1.id}`, edited));
    expect(r2.versionNo).toBe(2);
    expect(r2.title).toBe('v2');
    expect(r2.maxPoints).toBe(17);
    expect(r2.criteria[0].id).toBe(r1.criteria[0].id);
    expect(r2.criteria[0].levels[0].id).toBe(r1.criteria[0].levels[0].id);
    const { rows } = await owner.query(
      'SELECT version_no FROM lms.rubric_versions WHERE rubric_id = $1 ORDER BY 1',
      [r1.id],
    );
    expect(rows.map((x) => x.version_no)).toEqual([1, 2]);
  });

  it('refuses a rubric with no points, duplicate level names or a repeated id', async () => {
    const zero = await c.post(`/courses/${course}/rubrics`, {
      title: 'z',
      criteria: [
        {
          title: 'c',
          levels: [
            { title: 'a', points: 0 },
            { title: 'b', points: 0 },
          ],
        },
      ],
    });
    expect(zero.statusCode).toBe(400);
    expect(errorCode(zero)).toBe('invalid_rubric');
    const dup = await c.post(`/courses/${course}/rubrics`, {
      title: 'd',
      criteria: [
        {
          title: 'c',
          levels: [
            { title: 'a', points: 1 },
            { title: 'A', points: 2 },
          ],
        },
      ],
    });
    expect(dup.statusCode).toBe(400);
    const one = await c.post(`/courses/${course}/rubrics`, {
      title: 'one',
      criteria: [{ title: 'c', levels: [{ title: 'a', points: 1 }] }],
    });
    expect(one.statusCode).toBe(400);
  });

  it('lists with keyset, archives and restores; an assistant reads but cannot change; a learner sees nothing', async () => {
    const made = [];
    for (let i = 0; i < 3; i++)
      made.push(ok(await c.post(`/courses/${course}/rubrics`, rubricInput(`list ${i}`))));
    const page1 = ok(await c.get(`/courses/${course}/rubrics?limit=2`));
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = ok(await c.get(`/courses/${course}/rubrics?limit=2&after=${page1.nextCursor}`));
    expect(page2.items.length).toBeGreaterThan(0);
    const arch = ok(await c.patch(`/courses/${course}/rubrics/${made[0].id}`, { archived: true }));
    expect(arch.archived).toBe(true);
    const visible = ok(await c.get(`/courses/${course}/rubrics?limit=100`)).items.map(
      (x: Json) => x.id,
    );
    expect(visible).not.toContain(made[0].id);
    const all = ok(
      await c.get(`/courses/${course}/rubrics?limit=100&includeArchived=true`),
    ).items.map((x: Json) => x.id);
    expect(all).toContain(made[0].id);
    ok(await c.patch(`/courses/${course}/rubrics/${made[0].id}`, { archived: false }));
    expect((await assistant.get(`/courses/${course}/rubrics`)).statusCode).toBe(200);
    expect((await assistant.post(`/courses/${course}/rubrics`, rubricInput())).statusCode).toBe(
      403,
    );
    expect((await learner.get(`/courses/${course}/rubrics`)).statusCode).toBe(404);
  });

  it('a rubric of another course cannot be attached; an archived one cannot either', async () => {
    const e = await classOf(owner, t, A, admin, st, ['Ann']);
    const other = ok(
      await e.instructor.client.post(`/courses/${e.courseId}/rubrics`, rubricInput('other course')),
    );
    const e2 = await classOf(owner, t, A, admin, st, ['Bob']);
    const item = await addAssignment(e2);
    const wrong = await e2.instructor.client.put(`${base(e2, item.id)}/rubric`, {
      rubricId: other.id,
    });
    expect(wrong.statusCode).toBe(404);
    expect(errorCode(wrong)).toBe('rubric_not_found');
    const mine = ok(
      await e2.instructor.client.post(`/courses/${e2.courseId}/rubrics`, rubricInput('mine')),
    );
    ok(
      await e2.instructor.client.patch(`/courses/${e2.courseId}/rubrics/${mine.id}`, {
        archived: true,
      }),
    );
    const arch = await e2.instructor.client.put(`${base(e2, item.id)}/rubric`, {
      rubricId: mine.id,
    });
    expect(arch.statusCode).toBe(409);
    expect(errorCode(arch)).toBe('rubric_archived');
  });
});

describe('grading', () => {
  let e: Awaited<ReturnType<typeof classOf>>;
  let item: Json;
  let rubric: Json;
  let ic: TestClient;

  beforeAll(async () => {
    e = await classOf(owner, t, A, admin, st, ['Mona Lisa', 'Carl Gauss', 'Zed Zebra']);
    ic = e.instructor.client;
    rubric = ok(await ic.post(`/courses/${e.courseId}/rubrics`, rubricInput()));
    item = await addAssignment(e, {
      settings: { dueAt: inHours(24), maxPoints: 15, passingScore: 40 },
    });
    ok(await ic.put(`${base(e, item.id)}/rubric`, { rubricId: rubric.id }));
  });

  it('the queue lists every learner with a status; filters and the summary count them', async () => {
    const first = await queue(e, e.instructor, item.id);
    expect(first.items).toHaveLength(3);
    expect(first.items.every((r: Json) => r.status === 'not_submitted')).toBe(true);
    expect(first.blind).toBe(false);
    expect(first.maxPoints).toBe(15);
    // identity is visible when not blind, with the register number and section
    expect(first.items.map((r: Json) => r.name).sort()).toEqual([
      'Carl Gauss',
      'Mona Lisa',
      'Zed Zebra',
    ]);
    expect(first.items[0].registerNumber).toBeTruthy();
    ok(await handIn(e, e.learners[0]!, item.id));
    ok(await handIn(e, e.learners[1]!, item.id));
    const sum = ok(await ic.get(`${base(e, item.id)}/grading/summary`));
    expect(sum).toMatchObject({
      learners: 3,
      notSubmitted: 1,
      submitted: 2,
      late: 0,
      graded: 0,
      released: 0,
    });
    const only = await queue(e, e.instructor, item.id, '?status=submitted');
    expect(only.items).toHaveLength(2);
    const none = await queue(e, e.instructor, item.id, '?status=graded');
    expect(none.items).toHaveLength(0);
    // an assistant grades too
    expect((await queue(e, e.assistant, item.id)).items).toHaveLength(3);
  });

  it('keyset paging gives every learner exactly once, in each order', async () => {
    for (const sort of ['name', 'code', 'time']) {
      const seen: string[] = [];
      let after = '';
      for (let i = 0; i < 5; i++) {
        const r = await queue(e, e.instructor, item.id, `?sort=${sort}&limit=2${after}`);
        seen.push(...r.items.map((x: Json) => x.learnerKey));
        if (!r.nextCursor) break;
        after = `&after=${r.nextCursor}`;
      }
      expect(new Set(seen).size, sort).toBe(3);
      expect(seen.length, sort).toBe(3);
    }
    const bad = await ic.get(`${base(e, item.id)}/grading/queue?after=not-a-cursor`);
    expect(bad.statusCode).toBe(400);
  });

  it('grades with the rubric: the selection fills the score, comments are kept, the status becomes graded', async () => {
    const l = e.learners[0]!;
    const { key } = await keyFromDb(owner, item.id, l);
    const detail = ok(await ic.get(`${base(e, item.id)}/grading/learners/${key}`));
    expect(detail.name).toBe('Mona Lisa');
    expect(detail.submissions).toHaveLength(1);
    expect(detail.rubric.criteria).toHaveLength(2);
    const sel = pickLevels(rubric, ['Excellent', 'Good']);
    const saved = ok(
      await ic.put(`${base(e, item.id)}/grading/learners/${key}/grade`, {
        submissionId: detail.submissions[0].id,
        rubricSelection: {
          ...sel,
          [rubric.criteria[0].id]: { ...sel[rubric.criteria[0].id], comment: 'strong argument' },
        },
        feedback: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Well done' }] }],
        },
      }),
    );
    expect(saved).toMatchObject({
      rawScore: 15,
      penaltyPercent: 0,
      finalScore: 15,
      penaltyWaived: false,
    });
    const after = ok(await ic.get(`${base(e, item.id)}/grading/learners/${key}`));
    expect(after.grade.rubricScore).toBe(15);
    expect(after.grade.rubricSelection[rubric.criteria[0].id].comment).toBe('strong argument');
    expect((await queue(e, e.instructor, item.id, '?status=graded')).items).toHaveLength(1);
    // the learner does NOT see it until it is released (manual)
    expect((await me(e, l, item.id)).grade).toBeNull();
  });

  it('refuses an incomplete rubric selection, a wrong level, a score out of range, an override without a reason', async () => {
    const l = e.learners[1]!;
    const { key } = await keyFromDb(owner, item.id, l);
    const sid = ok(await ic.get(`${base(e, item.id)}/grading/learners/${key}`)).submissions[0].id;
    const put = (b: Json) =>
      ic.put(`${base(e, item.id)}/grading/learners/${key}/grade`, { submissionId: sid, ...b });
    const sel = pickLevels(rubric, ['Adequate', 'Good']);
    const half = await put({
      rubricSelection: { [rubric.criteria[0].id]: sel[rubric.criteria[0].id] },
    });
    expect(half.statusCode).toBe(400);
    expect(errorCode(half)).toBe('invalid_grade');
    const wrong = await put({
      rubricSelection: { ...sel, [rubric.criteria[0].id]: { levelId: 'ffffffffffff' } },
    });
    expect(wrong.statusCode).toBe(400);
    const none = await put({});
    expect(none.statusCode).toBe(400);
    const high = await put({ rubricSelection: sel, rawScore: 99 });
    expect(high.statusCode).toBe(400);
    const noReason = await put({ rubricSelection: sel, rawScore: 12 });
    expect(noReason.statusCode).toBe(400);
    expect(errorCode(noReason)).toBe('invalid_grade');
    // nothing was saved
    expect(
      (await queue(e, e.instructor, item.id, '?status=graded')).items.map(
        (r: Json) => r.learnerKey,
      ),
    ).not.toContain(key);
    // with a reason it is an override: the rubric score and the given score are both kept
    const okRes = ok(
      await put({
        rubricSelection: sel,
        rawScore: 12,
        overrideReason: 'extra credit for the appendix',
      }),
    );
    expect(okRes.rawScore).toBe(12);
    const d = ok(await ic.get(`${base(e, item.id)}/grading/learners/${key}`));
    expect(d.grade).toMatchObject({
      rubricScore: 10,
      rawScore: 12,
      overrideReason: 'extra credit for the appendix',
    });
  });

  it('a grade for a version that is no longer the latest is refused (409)', async () => {
    const l = e.learners[1]!;
    const { key } = await keyFromDb(owner, item.id, l);
    const old = ok(await ic.get(`${base(e, item.id)}/grading/learners/${key}`)).submissions[0].id;
    ok(
      await handIn(e, l, item.id, [
        { name: 'v2.pdf', bytes: Buffer.from('%PDF-1.4\n%v2\n%%EOF\n') },
      ]),
    );
    const r = await ic.put(`${base(e, item.id)}/grading/learners/${key}/grade`, {
      submissionId: old,
      rubricSelection: pickLevels(rubric, ['Adequate', 'Good']),
    });
    expect(r.statusCode).toBe(409);
    expect(errorCode(r)).toBe('submission_changed');
    // the earlier grade is now OUTDATED: the learner shows as submitted again
    const row = (await queue(e, e.instructor, item.id)).items.find(
      (x: Json) => x.learnerKey === key,
    );
    expect(row.status).toBe('submitted');
    expect(row.gradeOutdated).toBe(true);
  });

  it('a score without a rubric: needs the score, within 0 and the maximum', async () => {
    const plain = await addAssignment(e, { settings: { maxPoints: 20 } });
    const l = e.learners[2]!;
    ok(await handIn(e, l, plain.id));
    const { key } = await keyFromDb(owner, plain.id, l).catch(async () => {
      await queue(e, e.instructor, plain.id);
      return keyFromDb(owner, plain.id, l);
    });
    const sid = ok(await ic.get(`${base(e, plain.id)}/grading/learners/${key}`)).submissions[0].id;
    const put = (b: Json) =>
      ic.put(`${base(e, plain.id)}/grading/learners/${key}/grade`, { submissionId: sid, ...b });
    expect((await put({})).statusCode).toBe(400);
    expect((await put({ rawScore: 21 })).statusCode).toBe(400);
    expect((await put({ rawScore: -1 })).statusCode).toBe(400);
    expect(ok(await put({ rawScore: 17.5 })).finalScore).toBe(17.5);
  });

  it('LATE PENALTY is applied automatically and shown separately (raw, penalty, final); a waiver removes it, audited', async () => {
    const late = await addAssignment(e, {
      settings: {
        dueAt: inHours(1),
        latePolicy: 'allowed',
        lateCutoffAt: inHours(24 * 20),
        penaltyKind: 'per_day',
        penaltyValue: 10,
        penaltyCap: 50,
        maxPoints: 50,
      },
    });
    await setDates(owner, late.id, { dueAt: minutesAgo(60 * 30), cutoffAt: inHours(24 * 20) });
    const l = e.learners[2]!;
    ok(await handIn(e, l, late.id));
    await queue(e, e.instructor, late.id);
    const { key } = await keyFromDb(owner, late.id, l);
    const row = (await queue(e, e.instructor, late.id, '?status=late')).items[0];
    expect(row.lateSeconds).toBeGreaterThan(0);
    const sid = ok(await ic.get(`${base(e, late.id)}/grading/learners/${key}`)).submissions[0].id;
    const g = ok(
      await ic.put(`${base(e, late.id)}/grading/learners/${key}/grade`, {
        submissionId: sid,
        rawScore: 40,
      }),
    );
    // 30 hours = 2 started days = 20 % of 50 = 10 points
    expect(g).toMatchObject({
      rawScore: 40,
      penaltyPercent: 20,
      penaltyPoints: 10,
      finalScore: 30,
      penaltyWaived: false,
    });
    const row2 = (await queue(e, e.instructor, late.id)).items.find(
      (x: Json) => x.learnerKey === key,
    );
    expect(row2).toMatchObject({ rawScore: 40, finalScore: 30, status: 'graded' });
    // an assistant cannot waive (grade.finalize)
    const asst = await e.assistant.client.put(
      `${base(e, late.id)}/grading/learners/${key}/penalty-waiver`,
      { reason: 'server was down' },
    );
    expect(asst.statusCode).toBe(403);
    // the instructor waives it with a reason
    ok(
      await ic.put(`${base(e, late.id)}/grading/learners/${key}/penalty-waiver`, {
        reason: 'portal outage on the due date',
      }),
    );
    const d = ok(await ic.get(`${base(e, late.id)}/grading/learners/${key}`));
    expect(d.grade).toMatchObject({
      penaltyPercent: 0,
      penaltyWaived: true,
      finalScore: 40,
      waiveReason: 'portal outage on the due date',
    });
    const { rows } = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE action = 'assignment.penalty_waiver' AND target_id = $1`,
      [late.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({
      waived: true,
      reason: 'portal outage on the due date',
    });
    // and charged again
    ok(await ic.delete(`${base(e, late.id)}/grading/learners/${key}/penalty-waiver`));
    expect(
      ok(await ic.get(`${base(e, late.id)}/grading/learners/${key}`)).grade.penaltyPercent,
    ).toBe(20);
    // a waiver on a learner without a grade is refused
    const other = await keyFromDb(owner, late.id, e.learners[0]!);
    const nograde = await ic.put(
      `${base(e, late.id)}/grading/learners/${other.key}/penalty-waiver`,
      { reason: 'no grade here' },
    );
    expect(nograde.statusCode).toBe(409);
  });

  it('RELEASE: the learner sees the grade only after it is released; per learner and for everybody; the penalty is frozen', async () => {
    const rel = await addAssignment(e, {
      settings: {
        dueAt: inHours(1),
        latePolicy: 'allowed',
        lateCutoffAt: inHours(24 * 20),
        penaltyKind: 'flat',
        penaltyValue: 10,
        penaltyCap: 50,
        maxPoints: 100,
      },
    });
    await setDates(owner, rel.id, { dueAt: minutesAgo(60), cutoffAt: inHours(24 * 20) });
    const [a, b, c] = e.learners as [Json, Json, Json];
    for (const l of [a, b, c]) ok(await handIn(e, l, rel.id));
    await queue(e, e.instructor, rel.id);
    const keys = [] as string[];
    for (const l of [a, b, c]) {
      const { key } = await keyFromDb(owner, rel.id, l);
      keys.push(key);
      const sid = ok(await ic.get(`${base(e, rel.id)}/grading/learners/${key}`)).submissions[0].id;
      ok(
        await ic.put(`${base(e, rel.id)}/grading/learners/${key}/grade`, {
          submissionId: sid,
          rawScore: 80,
          feedback: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ok' }] }],
          },
        }),
      );
    }
    expect((await me(e, a, rel.id)).grade).toBeNull();
    // release ONE learner
    expect(
      ok(await ic.post(`${base(e, rel.id)}/release`, { learnerKeys: [keys[0]] })).released,
    ).toBe(1);
    const mine = (await me(e, a, rel.id)).grade;
    expect(mine).toMatchObject({
      rawScore: 80,
      penaltyPercent: 10,
      penaltyPoints: 10,
      finalScore: 70,
      maxPoints: 100,
    });
    expect((await me(e, b, rel.id)).grade).toBeNull();
    // the policy changes after the release: the released score does NOT move (frozen), the unreleased one follows the policy
    ok(await ic.put(base(e, rel.id), { penaltyValue: 40 }));
    expect((await me(e, a, rel.id)).grade.penaltyPercent).toBe(10);
    // release everybody who is still waiting
    expect(ok(await ic.post(`${base(e, rel.id)}/release`, {})).released).toBe(2);
    expect((await me(e, b, rel.id)).grade).toMatchObject({ penaltyPercent: 40, finalScore: 40 });
    expect(ok(await ic.post(`${base(e, rel.id)}/release`, {})).released).toBe(0);
    const sum = ok(await ic.get(`${base(e, rel.id)}/grading/summary`));
    expect(sum.released).toBe(3);
    // an assistant cannot release
    expect((await e.assistant.client.post(`${base(e, rel.id)}/release`, {})).statusCode).toBe(403);
    // the audit entries carry counts, not learner names
    const { rows } = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE action = 'assignment.released' AND target_id = $1 ORDER BY created_at`,
      [rel.id],
    );
    expect(rows.map((r) => r.metadata.count)).toEqual([1, 2]);
  });

  it('immediate release mode: the learner sees the grade as soon as it is saved', async () => {
    const imm = await addAssignment(e, { settings: { releaseMode: 'immediate', maxPoints: 10 } });
    const l = e.learners[0]!;
    ok(await handIn(e, l, imm.id));
    await queue(e, e.instructor, imm.id);
    const { key } = await keyFromDb(owner, imm.id, l);
    const sid = ok(await ic.get(`${base(e, imm.id)}/grading/learners/${key}`)).submissions[0].id;
    ok(
      await ic.put(`${base(e, imm.id)}/grading/learners/${key}/grade`, {
        submissionId: sid,
        rawScore: 9,
      }),
    );
    expect((await me(e, l, imm.id)).grade).toMatchObject({ rawScore: 9, finalScore: 9 });
  });

  it('feedback files: the learner can download them once the grade is visible, not before', async () => {
    const fb = await addAssignment(e, { settings: { maxPoints: 10 } });
    const l = e.learners[0]!;
    ok(await handIn(e, l, fb.id));
    await queue(e, e.instructor, fb.id);
    const { key } = await keyFromDb(owner, fb.id, l);
    const sid = ok(await ic.get(`${base(e, fb.id)}/grading/learners/${key}`)).submissions[0].id;
    // the instructor uploads the feedback file through the offering's file upload
    const bytes = Buffer.from('%PDF-1.4\n%feedback\n%%EOF\n');
    const req = ok(
      await ic.post(`/offerings/${e.offeringId}/files`, { name: 'marked.pdf', size: bytes.length }),
    );
    expect(
      (
        await ic.request('PUT', req.upload.url, {
          body: bytes,
          headers: { ...req.upload.headers, 'content-length': String(bytes.length) },
        })
      ).statusCode,
    ).toBe(204);
    const file = ok(await ic.post(`/files/${req.file.id}/confirm`));
    ok(
      await ic.put(`${base(e, fb.id)}/grading/learners/${key}/grade`, {
        submissionId: sid,
        rawScore: 7,
        feedbackFileIds: [file.id],
      }),
    );
    const before = await l.client.get(`${base(e, fb.id)}/files/${file.id}`);
    expect(before.statusCode).toBe(404);
    ok(await ic.post(`${base(e, fb.id)}/release`, {}));
    const page = await me(e, l, fb.id);
    expect(page.grade.files).toHaveLength(1);
    const dl = ok(await l.client.get(`${base(e, fb.id)}/files/${file.id}`));
    expect(dl.fileName).toBe('marked.pdf');
    // another learner never gets it
    expect((await e.learners[1]!.client.get(`${base(e, fb.id)}/files/${file.id}`)).statusCode).toBe(
      404,
    );
  });

  it("files: a learner downloads their own versions and the attachments, never another learner's", async () => {
    const f = await addAssignment(e);
    const [a, b] = e.learners as [Json, Json];
    ok(
      await handIn(e, a, f.id, [
        { name: 'a-private.pdf', bytes: Buffer.from('%PDF-1.4\n%a\n%%EOF\n') },
      ]),
    );
    const aFile = (await me(e, a, f.id)).submissions[0].files[0].fileId;
    expect(ok(await a.client.get(`${base(e, f.id)}/files/${aFile}`)).fileName).toBe(
      'a-private.pdf',
    );
    expect((await b.client.get(`${base(e, f.id)}/files/${aFile}`)).statusCode).toBe(404);
    // a grader downloads it through the grading route (not the learner route)
    expect(ok(await ic.get(`${base(e, f.id)}/grading/files/${aFile}`)).fileName).toBe(
      'a-private.pdf',
    );
    expect((await a.client.get(`${base(e, f.id)}/grading/files/${aFile}`)).statusCode).toBe(403);
    // a file of ANOTHER assignment is not served through this one
    const g = await addAssignment(e);
    expect((await ic.get(`${base(e, g.id)}/grading/files/${aFile}`)).statusCode).toBe(404);
  });

  it('a rubric with grades cannot be swapped for another; the same rubric can pick up a newer version', async () => {
    const other = ok(await ic.post(`/courses/${e.courseId}/rubrics`, rubricInput('another')));
    const swap = await ic.put(`${base(e, item.id)}/rubric`, { rubricId: other.id });
    expect(swap.statusCode).toBe(409);
    expect(errorCode(swap)).toBe('grading_started');
    const remove = await ic.put(`${base(e, item.id)}/rubric`, { rubricId: null });
    expect(remove.statusCode).toBe(409);
    const edited = rubricInput(rubric.title);
    edited.criteria[0].id = rubric.criteria[0].id;
    ok(await ic.put(`/courses/${e.courseId}/rubrics/${rubric.id}`, edited));
    const cfg1 = ok(await ic.get(base(e, item.id)));
    expect(cfg1.rubric.newerVersionAvailable).toBe(true);
    ok(await ic.put(`${base(e, item.id)}/rubric`, { rubricId: rubric.id }));
    expect(ok(await ic.get(base(e, item.id))).rubric.newerVersionAvailable).toBe(false);
  });

  it('final scores for the gradebook: the score after the penalty, released or not', async () => {
    const rows = await t.app.modules.assignments.service.finalScores(A.tenantId, e.offeringId);
    expect(rows.length).toBeGreaterThan(0);
    const lateRow = rows.find((r) => r.penaltyPercent > 0);
    expect(lateRow).toBeTruthy();
    expect(lateRow!.score).toBeCloseTo(
      lateRow!.rawScore - (lateRow!.maxScore * lateRow!.penaltyPercent) / 100,
      2,
    );
    for (const r of rows) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(r.maxScore);
    }
  });

  it('a learner of ANOTHER offering and a plain member cannot reach the grading routes', async () => {
    const e2 = await classOf(owner, t, A, admin, st, ['Zoe']);
    expect((await e2.instructor.client.get(`${base(e, item.id)}/grading/queue`)).statusCode).toBe(
      404,
    );
    expect((await e.learners[0]!.client.get(`${base(e, item.id)}/grading/queue`)).statusCode).toBe(
      403,
    );
    // the learner key of one assignment is nothing in another
    const { key } = await keyFromDb(owner, item.id, e.learners[0]!);
    const other = await addAssignment(e);
    expect((await ic.get(`${base(e, other.id)}/grading/learners/${key}`)).statusCode).toBe(404);
    void randomUUID;
  });
});

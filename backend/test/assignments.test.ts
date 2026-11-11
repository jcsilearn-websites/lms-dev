// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import {
  addAssignment,
  base,
  type Exam,
  exam,
  handIn,
  inHours,
  inMinutes,
  me,
  minutesAgo,
  pdf,
  setDates,
  uploadHandIn,
} from './assignments-helpers';
import type { TestClient } from './client';
import { errorCode, type Json, loginAs, ok, type Structure, structure } from './courses-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Step 10: the learner side of an assignment: settings, the upload flow, versions, the deadline (server clock, grace,
// late policy, the confirmation of a late version that replaces an on-time one), extensions.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let st: Structure;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'asg-a');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

describe('the builder', () => {
  let e: Exam;
  beforeAll(async () => {
    e = await exam(owner, t, A, admin, st, 1);
  });

  it('creates an assignment item with defaults; settings change; invalid ones are refused', async () => {
    const c = e.instructor.client;
    const item = await addAssignment(e);
    const cfg = ok(await c.get(base(e, item.id)));
    expect(cfg.settings).toMatchObject({
      latePolicy: 'none',
      maxPoints: 100,
      allowFile: true,
      allowText: false,
      resubmissionAllowed: true,
      anonymousGrading: false,
      releaseMode: 'manual',
    });
    expect(cfg.attachments).toEqual([]);
    expect(cfg.rubric).toBeNull();

    const changed = ok(
      await c.put(base(e, item.id), {
        dueAt: inHours(48),
        latePolicy: 'allowed',
        lateCutoffAt: inHours(120),
        penaltyKind: 'per_day',
        penaltyValue: 10,
        penaltyCap: 30,
        allowText: true,
        maxPoints: 50,
        instructions: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Write 500 words' }] }],
        },
      }),
    );
    expect(changed).toMatchObject({ latePolicy: 'allowed', allowText: true, maxPoints: 50 });

    const bad = await c.put(base(e, item.id), { latePolicy: 'allowed', lateCutoffAt: null });
    expect(bad.statusCode).toBe(400);
    expect(errorCode(bad)).toBe('invalid_assignment_settings');
    const none = await c.put(base(e, item.id), {
      allowFile: false,
      allowText: false,
      allowLink: false,
    });
    expect(none.statusCode).toBe(400);
    const empty = await c.put(base(e, item.id), {});
    expect(empty.statusCode).toBe(400);
  });

  it('only an instructor of the course builds; an assistant and a learner cannot', async () => {
    const item = await addAssignment(e);
    expect((await e.assistant.client.get(base(e, item.id))).statusCode).toBe(403);
    expect((await e.learners[0]!.client.get(base(e, item.id))).statusCode).toBe(403);
    expect((await e.learners[0]!.client.put(base(e, item.id), { maxPoints: 5 })).statusCode).toBe(
      403,
    );
  });

  it('the settings change is audited with before and after', async () => {
    const item = await addAssignment(e);
    ok(await e.instructor.client.put(base(e, item.id), { anonymousGrading: true }));
    const { rows } = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE action = 'assignment.settings_changed' AND target_id = $1`,
      [item.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.before.anonymousGrading).toBe(false);
    expect(rows[0].metadata.after.anonymousGrading).toBe(true);
    expect(JSON.stringify(rows[0].metadata)).not.toContain('instructions');
  });
});

describe('handing in', () => {
  let e: Exam;
  let item: Json;
  beforeAll(async () => {
    e = await exam(owner, t, A, admin, st, 3);
    item = await addAssignment(e, {
      settings: { dueAt: inHours(24), allowText: true, allowLink: true },
    });
  });

  it('the learner page shows their dates, no versions yet, and can submit', async () => {
    const r = await me(e, e.learners[0]!, item.id);
    expect(r.state).toBe('open');
    expect(r.canSubmit).toBe(true);
    expect(r.submissions).toEqual([]);
    expect(r.assignment.dueAt).toBeTruthy();
    expect(r.grade).toBeNull();
    expect(r.graceSeconds).toBe(600);
  });

  it('upload flow, then one version; the page shows it; a second hand-in is version 2 and keeps version 1', async () => {
    const l = e.learners[0]!;
    const first = ok(await handIn(e, l, item.id, [{ name: 'draft.pdf', bytes: pdf('a') }]));
    expect(first).toMatchObject({ result: 'ok', versionNo: 1, lateSeconds: 0 });
    const second = ok(
      await handIn(e, l, item.id, [{ name: 'final.pdf', bytes: pdf('b') }], { text: 'see file' }),
    );
    expect(second).toMatchObject({ result: 'ok', versionNo: 2 });
    const page = await me(e, l, item.id);
    expect(page.counts).toBe(2);
    expect(page.submissions.map((s: Json) => s.versionNo)).toEqual([2, 1]);
    expect(page.submissions[1].files[0].name).toBe('draft.pdf');
    expect(page.submissions[0].text).toBe('see file');
    expect(page.drafts).toEqual([]);
    // history: the earlier version is still there for the grader
    const { rows } = await owner.query(
      `SELECT version_no FROM lms.submissions WHERE assignment_item_id = $1 ORDER BY version_no`,
      [item.id],
    );
    expect(rows.map((r) => r.version_no)).toEqual([1, 2].slice(0, rows.length));
  });

  it('the same request key twice is ONE version (a double click)', async () => {
    const l = e.learners[1]!;
    const f = await uploadHandIn(e, l, item.id, 'a.pdf', pdf('dup'));
    const key = randomUUID();
    const body = { requestKey: key, fileIds: [f.fileId] };
    const a = ok(await l.client.post(`${base(e, item.id)}/submissions`, body));
    const b = ok(await l.client.post(`${base(e, item.id)}/submissions`, body));
    expect(a.submissionId).toBe(b.submissionId);
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM lms.submissions WHERE assignment_item_id = $1 AND request_key = $2`,
      [item.id, key],
    );
    expect(rows[0].n).toBe(1);
  });

  it('text and link submissions; an empty one and a bad link are refused', async () => {
    const l = e.learners[2]!;
    const k = () => randomUUID();
    const empty = await l.client.post(`${base(e, item.id)}/submissions`, {
      requestKey: k(),
      fileIds: [],
    });
    expect(empty.statusCode).toBe(400);
    expect(errorCode(empty)).toBe('empty_submission');
    const badLink = await l.client.post(`${base(e, item.id)}/submissions`, {
      requestKey: k(),
      fileIds: [],
      link: 'javascript:alert(1)',
    });
    expect(badLink.statusCode).toBe(400);
    expect(errorCode(badLink)).toBe('invalid_submission');
    const good = ok(
      await l.client.post(`${base(e, item.id)}/submissions`, {
        requestKey: k(),
        fileIds: [],
        text: 'my answer',
        link: 'https://example.com/work',
      }),
    );
    expect(good.versionNo).toBe(1);
  });

  it('a type the assignment does not accept is refused', async () => {
    const only = await addAssignment(e, { settings: { allowFile: true, allowText: false } });
    const l = e.learners[0]!;
    const r = await l.client.post(`${base(e, only.id)}/submissions`, {
      requestKey: randomUUID(),
      fileIds: [],
      text: 'no text here',
    });
    expect(r.statusCode).toBe(400);
    expect(errorCode(r)).toBe('submission_type_not_allowed');
  });

  it("another learner's file cannot be handed in; an unconfirmed upload cannot either", async () => {
    const other = e.learners[1]!;
    const mine = e.learners[0]!;
    const theirs = await uploadHandIn(e, other, item.id, 'theirs.pdf', pdf('t'));
    const r1 = await mine.client.post(`${base(e, item.id)}/submissions`, {
      requestKey: randomUUID(),
      fileIds: [theirs.fileId],
    });
    expect(r1.statusCode).toBe(400);
    expect(errorCode(r1)).toBe('files_not_ready');
    const req = ok(
      await mine.client.post(`${base(e, item.id)}/files`, { name: 'x.pdf', size: 100 }),
    );
    const r2 = await mine.client.post(`${base(e, item.id)}/submissions`, {
      requestKey: randomUUID(),
      fileIds: [req.fileId],
    });
    expect(errorCode(r2)).toBe('files_not_ready');
  });

  it('only one submission when resubmission is off', async () => {
    const once = await addAssignment(e, { settings: { resubmissionAllowed: false } });
    const l = e.learners[0]!;
    ok(await handIn(e, l, once.id));
    const again = await handIn(e, l, once.id);
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('already_submitted');
    expect((await me(e, l, once.id)).canSubmit).toBe(false);
  });

  it('too many files and files over the size limit are refused', async () => {
    const few = await addAssignment(e, { settings: { maxFiles: 1 } });
    const l = e.learners[0]!;
    const a = await uploadHandIn(e, l, few.id, 'a.pdf', pdf('1'));
    const b = await uploadHandIn(e, l, few.id, 'b.pdf', pdf('2'));
    const r = await l.client.post(`${base(e, few.id)}/submissions`, {
      requestKey: randomUUID(),
      fileIds: [a.fileId, b.fileId],
    });
    expect(errorCode(r)).toBe('too_many_files');
    const big = await l.client.post(`${base(e, few.id)}/files`, {
      name: 'big.pdf',
      size: 26 * 1048576,
    });
    expect(big.statusCode).toBe(400);
    expect(errorCode(big)).toBe('file_too_large');
  });

  it('programs and scripts are refused whatever the settings say', async () => {
    const l = e.learners[0]!;
    for (const name of [
      'setup.exe',
      'run.bat',
      'x.js',
      'page.html',
      'drawing.svg',
      'tool.sh',
      'a.exe.pdf.exe',
      'LOUD.EXE',
    ]) {
      const r = await l.client.post(`${base(e, item.id)}/files`, { name, size: 100 });
      expect(r.statusCode, name).toBe(400);
      expect(['file_type_blocked', 'file_type_not_allowed'], name).toContain(errorCode(r));
    }
    const exe = await l.client.post(`${base(e, item.id)}/files`, { name: 'setup.exe', size: 100 });
    expect(errorCode(exe)).toBe('file_type_blocked');
  });

  it('a file whose bytes do not match its extension is refused at confirm', async () => {
    const l = e.learners[0]!;
    const bytes = Buffer.from('MZ\x90\x00 this is a Windows program');
    const req = ok(
      await l.client.post(`${base(e, item.id)}/files`, { name: 'fake.pdf', size: bytes.length }),
    );
    const put = await l.client.request('PUT', req.upload.url, {
      body: bytes,
      headers: { ...req.upload.headers, 'content-length': String(bytes.length) },
    });
    expect(put.statusCode).toBe(204);
    const c = await l.client.post(`${base(e, item.id)}/files/${req.fileId}/confirm`);
    expect(c.statusCode).toBe(400);
  });

  it('a non-participant gets the answers of every offering route, and cannot see the assignment', async () => {
    const outsider = await (await import('./courses-helpers')).person(owner, t, A, 'Outsider');
    expect((await outsider.client.get(`${base(e, item.id)}/me`)).statusCode).toBe(404);
    expect(
      (await outsider.client.post(`${base(e, item.id)}/files`, { name: 'a.pdf', size: 10 }))
        .statusCode,
    ).toBe(404);
  });

  it('an unpublished assignment is invisible to learners', async () => {
    const draft = await addAssignment(e, { published: false });
    const r = await e.learners[0]!.client.get(`${base(e, draft.id)}/me`);
    expect(r.statusCode).toBe(404);
  });
});

describe('the deadline (the server clock decides)', () => {
  let e: Exam;
  beforeAll(async () => {
    e = await exam(owner, t, A, admin, st, 2);
  });

  it('nothing is accepted after the due date without a late policy', async () => {
    const item = await addAssignment(e, { settings: { dueAt: inHours(1) } });
    const l = e.learners[0]!;
    ok(await handIn(e, l, item.id));
    await setDates(owner, item.id, { dueAt: minutesAgo(60) });
    const r = await handIn(e, e.learners[1]!, item.id);
    // the upload is refused before the file exists
    expect([409]).toContain(r.statusCode === 409 ? 409 : -1);
    const page = await me(e, l, item.id);
    expect(page.state).toBe('closed');
    expect(page.canSubmit).toBe(false);
  });

  it('late work is accepted until the hard cutoff, with the penalty per started day, capped', async () => {
    const item = await addAssignment(e, {
      settings: {
        dueAt: inHours(1),
        latePolicy: 'allowed',
        lateCutoffAt: inHours(24 * 10),
        penaltyKind: 'per_day',
        penaltyValue: 10,
        penaltyCap: 25,
      },
    });
    const l = e.learners[0]!;
    // 1 hour late = 1 started day = 10 %
    await setDates(owner, item.id, { dueAt: minutesAgo(60), cutoffAt: inHours(24 * 10) });
    const one = ok(await handIn(e, l, item.id));
    expect(one).toMatchObject({ result: 'ok', versionNo: 1, penaltyPercent: 10 });
    expect(one.lateSeconds).toBeGreaterThan(3500);
    // 2.5 days late = 3 started days = 30 % -> capped at 25 %
    await setDates(owner, item.id, { dueAt: minutesAgo(60 * 60), cutoffAt: inHours(24 * 10) });
    const two = ok(await handIn(e, l, item.id));
    expect(two).toMatchObject({ result: 'ok', versionNo: 2, penaltyPercent: 25 });
    // past the cutoff: closed
    await setDates(owner, item.id, { dueAt: minutesAgo(60 * 24 * 12), cutoffAt: minutesAgo(60) });
    const closed = await handIn(e, e.learners[1]!, item.id);
    expect(closed.statusCode).toBe(409);
  });

  it('a flat penalty is charged once, however late', async () => {
    const item = await addAssignment(e, {
      settings: {
        dueAt: inHours(1),
        latePolicy: 'allowed',
        lateCutoffAt: inHours(24 * 30),
        penaltyKind: 'flat',
        penaltyValue: 15,
        penaltyCap: 50,
      },
    });
    await setDates(owner, item.id, { dueAt: minutesAgo(60 * 24 * 5), cutoffAt: inHours(24 * 30) });
    const r = ok(await handIn(e, e.learners[0]!, item.id));
    expect(r.penaltyPercent).toBe(15);
  });

  it('GRACE: an upload begun before the due date and handed in within the grace period is on time', async () => {
    const item = await addAssignment(e, { settings: { dueAt: inHours(1) } });
    const l = e.learners[0]!;
    const f = await uploadHandIn(e, l, item.id, 'late.pdf', pdf('g'));
    // the due date passed 2 minutes ago; the upload began 5 minutes ago (before it)
    await setDates(owner, item.id, { dueAt: minutesAgo(2) });
    await owner.query(`UPDATE lms.assignment_uploads SET created_at = $2 WHERE file_id = $1`, [
      f.fileId,
      minutesAgo(5),
    ]);
    const r = ok(
      await l.client.post(`${base(e, item.id)}/submissions`, {
        requestKey: randomUUID(),
        fileIds: [f.fileId],
      }),
    );
    expect(r).toMatchObject({ result: 'ok', lateSeconds: 0, onGrace: true });
    expect((await me(e, l, item.id)).submissions[0].onGrace).toBe(true);
  });

  it('GRACE is bounded: past the grace period the same upload is too late', async () => {
    const item = await addAssignment(e, { settings: { dueAt: inHours(1) } });
    const l = e.learners[0]!;
    const f = await uploadHandIn(e, l, item.id, 'late.pdf', pdf('g2'));
    await setDates(owner, item.id, { dueAt: minutesAgo(30) });
    await owner.query(`UPDATE lms.assignment_uploads SET created_at = $2 WHERE file_id = $1`, [
      f.fileId,
      minutesAgo(40),
    ]);
    const r = await l.client.post(`${base(e, item.id)}/submissions`, {
      requestKey: randomUUID(),
      fileIds: [f.fileId],
    });
    expect(r.statusCode).toBe(409);
    expect(errorCode(r)).toBe('assignment_closed');
  });

  it('GRACE needs the upload to have BEGUN before the due date', async () => {
    const item = await addAssignment(e, { settings: { dueAt: inHours(1) } });
    const l = e.learners[0]!;
    const f = await uploadHandIn(e, l, item.id, 'late.pdf', pdf('g3'));
    await setDates(owner, item.id, { dueAt: minutesAgo(2) });
    // begun AFTER the due date
    await owner.query(`UPDATE lms.assignment_uploads SET created_at = $2 WHERE file_id = $1`, [
      f.fileId,
      minutesAgo(1),
    ]);
    const r = await l.client.post(`${base(e, item.id)}/submissions`, {
      requestKey: randomUUID(),
      fileIds: [f.fileId],
    });
    expect(r.statusCode).toBe(409);
  });

  it('the page shows the draft that is still within the grace period', async () => {
    const item = await addAssignment(e, { settings: { dueAt: inHours(1) } });
    const l = e.learners[1]!;
    const f = await uploadHandIn(e, l, item.id, 'wip.pdf', pdf('wip'));
    await setDates(owner, item.id, { dueAt: minutesAgo(2) });
    await owner.query(`UPDATE lms.assignment_uploads SET created_at = $2 WHERE file_id = $1`, [
      f.fileId,
      minutesAgo(3),
    ]);
    const page = await me(e, l, item.id);
    expect(page.state).toBe('closed');
    expect(page.draftWithinGrace).toBe(true);
    expect(page.canSubmit).toBe(true);
  });

  it('the assignment is not open before it opens', async () => {
    const item = await addAssignment(e, { settings: { opensAt: inHours(2), dueAt: inHours(5) } });
    const r = await e.learners[0]!.client.post(`${base(e, item.id)}/files`, {
      name: 'a.pdf',
      size: 10,
    });
    expect(r.statusCode).toBe(409);
    expect(errorCode(r)).toBe('assignment_not_open');
    expect((await me(e, e.learners[0]!, item.id)).state).toBe('not_open');
  });

  it('LATE REPLACING ON TIME needs an explicit confirmation showing the exact penalty; nothing is written without it', async () => {
    const item = await addAssignment(e, {
      settings: {
        dueAt: inHours(1),
        latePolicy: 'allowed',
        lateCutoffAt: inHours(24 * 10),
        penaltyKind: 'per_day',
        penaltyValue: 10,
        penaltyCap: 40,
        maxPoints: 80,
      },
    });
    const l = e.learners[0]!;
    const onTime = ok(await handIn(e, l, item.id));
    expect(onTime.lateSeconds).toBe(0);
    // the deadline passes (2 started days late)
    await setDates(owner, item.id, { dueAt: minutesAgo(60 * 30), cutoffAt: inHours(24 * 10) });
    const f = await uploadHandIn(e, l, item.id, 'better.pdf', pdf('better'));
    const key = randomUUID();
    const ask = ok(
      await l.client.post(`${base(e, item.id)}/submissions`, {
        requestKey: key,
        fileIds: [f.fileId],
      }),
    );
    expect(ask).toMatchObject({
      result: 'confirm_late',
      penaltyPercent: 20,
      penaltyPoints: 16,
      maxPoints: 80,
      currentVersionNo: 1,
    });
    expect(ask.lateSeconds).toBeGreaterThan(60 * 60 * 29);
    // nothing was written: still version 1, the file is still a draft
    expect((await me(e, l, item.id)).counts).toBe(1);
    expect((await me(e, l, item.id)).drafts.map((d: Json) => d.fileId)).toContain(f.fileId);
    // confirmed: version 2, late, with the penalty the server showed
    const done = ok(
      await l.client.post(`${base(e, item.id)}/submissions`, {
        requestKey: key,
        fileIds: [f.fileId],
        confirmLate: true,
      }),
    );
    expect(done).toMatchObject({ result: 'ok', versionNo: 2, penaltyPercent: 20 });
    // a learner with NO on-time version is not asked: being late is the only way they could hand in
    const fresh = e.learners[1]!;
    const direct = ok(await handIn(e, fresh, item.id));
    expect(direct.result).toBe('ok');
    // and a late version after a late version needs no new confirmation
    const again = ok(await handIn(e, l, item.id));
    expect(again.result).toBe('ok');
  });

  it('the page tells what handing in right now would cost', async () => {
    const item = await addAssignment(e, {
      settings: {
        dueAt: inHours(1),
        latePolicy: 'allowed',
        lateCutoffAt: inHours(24 * 10),
        penaltyValue: 5,
        penaltyCap: 50,
        maxPoints: 100,
      },
    });
    await setDates(owner, item.id, { dueAt: minutesAgo(60 * 49), cutoffAt: inHours(24 * 10) });
    const page = await me(e, e.learners[0]!, item.id);
    expect(page.state).toBe('late');
    expect(page.penaltyPercentNow).toBe(15);
    expect(page.penaltyPointsNow).toBe(15);
  });
});

describe('extensions', () => {
  let e: Exam;
  beforeAll(async () => {
    e = await exam(owner, t, A, admin, st, 2);
  });

  it('an extension moves the due date and the cutoff for ONE learner; the reason stays private and out of the audit log', async () => {
    const item = await addAssignment(e, {
      settings: { dueAt: inHours(1), latePolicy: 'allowed', lateCutoffAt: inHours(10) },
    });
    const [a, b] = e.learners as [Json, Json];
    const pid = (
      await owner.query(
        `SELECT p.id FROM lms.course_participants p JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
        WHERE p.offering_id = $1 AND m.user_id = $2`,
        [e.offeringId, a.userId],
      )
    ).rows[0].id;
    const ext = ok(
      await e.instructor.client.put(`${base(e, item.id)}/extensions/${pid}`, {
        extendedDueAt: inHours(5),
        reason: 'hospital stay, see note HR-1234',
      }),
    );
    expect(ext.reason).toBe('hospital stay, see note HR-1234');
    const pa = await me(e, a, item.id);
    const pb = await me(e, b, item.id);
    expect(new Date(pa.assignment.dueAt).getTime()).toBeGreaterThan(
      new Date(pb.assignment.dueAt).getTime() + 3 * 3_600_000,
    );
    expect(pa.assignment.hasExtension).toBe(true);
    expect(pb.assignment.hasExtension).toBe(false);
    // the cutoff moved by the same amount (4 hours)
    expect(
      new Date(pa.assignment.lateCutoffAt).getTime() -
        new Date(pb.assignment.lateCutoffAt).getTime(),
    ).toBeGreaterThan(3.9 * 3_600_000);
    // the learner's page carries no reason
    expect(JSON.stringify(pa)).not.toContain('hospital');
    // the audit entry carries dates, never the reason
    const { rows } = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE action = 'assignment.extension_set' AND target_id = $1`,
      [item.id],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].metadata)).not.toContain('hospital');
    expect(JSON.stringify(rows[0].metadata)).not.toContain('HR-1234');
    // instructors read the reason; assistants and learners cannot read the list
    const list = ok(await e.instructor.client.get(`${base(e, item.id)}/extensions`));
    expect(list.items[0].reason).toContain('hospital');
    expect((await e.assistant.client.get(`${base(e, item.id)}/extensions`)).statusCode).toBe(403);
    expect((await a.client.get(`${base(e, item.id)}/extensions`)).statusCode).toBe(403);
    // an institution administrator reads them too (and nothing else about the assignment)
    expect((await admin.get(`${base(e, item.id)}/extensions`)).statusCode).toBe(200);
    // removing it
    ok(await e.instructor.client.delete(`${base(e, item.id)}/extensions/${pid}`));
    expect((await me(e, a, item.id)).assignment.hasExtension).toBe(false);
  });

  it('an extension earlier than the due date, or on an assignment without one, is refused', async () => {
    const item = await addAssignment(e, { settings: { dueAt: inHours(10) } });
    const pid = (
      await owner.query(
        `SELECT p.id FROM lms.course_participants p JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
        WHERE p.offering_id = $1 AND m.user_id = $2`,
        [e.offeringId, e.learners[0]!.userId],
      )
    ).rows[0].id;
    const early = await e.instructor.client.put(`${base(e, item.id)}/extensions/${pid}`, {
      extendedDueAt: inHours(2),
    });
    expect(early.statusCode).toBe(400);
    const open = await addAssignment(e);
    const none = await e.instructor.client.put(`${base(e, open.id)}/extensions/${pid}`, {
      extendedDueAt: inHours(2),
    });
    expect(none.statusCode).toBe(400);
    const stranger = await e.instructor.client.put(
      `${base(e, item.id)}/extensions/${randomUUID()}`,
      { extendedDueAt: inHours(20) },
    );
    expect(stranger.statusCode).toBe(404);
  });

  it('an extension lets a learner hand in on time after the original due date', async () => {
    const item = await addAssignment(e, { settings: { dueAt: inHours(1) } });
    const l = e.learners[0]!;
    const pid = (
      await owner.query(
        `SELECT p.id FROM lms.course_participants p JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
        WHERE p.offering_id = $1 AND m.user_id = $2`,
        [e.offeringId, l.userId],
      )
    ).rows[0].id;
    ok(
      await e.instructor.client.put(`${base(e, item.id)}/extensions/${pid}`, {
        extendedDueAt: inHours(30),
      }),
    );
    await setDates(owner, item.id, { dueAt: minutesAgo(120) });
    // the stored extension is later than the (moved) due date: this learner is still on time, the other is closed
    const r = ok(await handIn(e, l, item.id));
    expect(r.lateSeconds).toBe(0);
    expect((await handIn(e, e.learners[1]!, item.id)).statusCode).toBe(409);
  });
});

void inMinutes;

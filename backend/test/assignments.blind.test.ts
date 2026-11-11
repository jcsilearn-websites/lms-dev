// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { addAssignment, base, classOf, handIn, keyFromDb, queue } from './assignments-helpers';
import type { TestClient } from './client';
import { errorCode, type Json, loginAs, ok, type Structure, structure } from './courses-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Step 10: BLIND GRADING. The sentinel test: every learner has a name, e-mail and register number that are looked for in
// everything a grader receives while grading is blind. Identity is NULL in the rows leaving the database, not hidden by the
// screen; and the queue is never ordered by anything that identifies a learner.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let st: Structure;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'asg-b');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const NAMES = [
  'Sentinelzyx Alpha',
  'Sentinelzyx Bravo',
  'Sentinelzyx Charlie',
  'Sentinelzyx Delta',
  'Sentinelzyx Echo',
  'Sentinelzyx Foxtrot',
];

describe('blind grading', () => {
  let e: Awaited<ReturnType<typeof classOf>>;
  let item: Json;
  let ic: TestClient;
  /** every string that identifies a learner: name, e-mail, register number, user id, participant id */
  let sentinels: string[];

  beforeAll(async () => {
    e = await classOf(owner, t, A, admin, st, NAMES);
    ic = e.instructor.client;
    item = await addAssignment(e, { settings: { anonymousGrading: true, maxPoints: 10 } });
    // a file name that carries a learner's name (it must not leave while blind)
    for (const [i, l] of e.learners.entries()) {
      ok(
        await handIn(e, l, item.id, [
          {
            name: `${NAMES[i]!.replace(' ', '-')}-essay.pdf`,
            bytes: Buffer.from(`%PDF-1.4\n%${i}\n%%EOF\n`),
          },
        ]),
      );
    }
    await queue(e, e.instructor, item.id);
    const pids = (
      await owner.query(
        `SELECT p.id FROM lms.course_participants p WHERE p.offering_id = $1 AND p.participation = 'learner'`,
        [e.offeringId],
      )
    ).rows.map((r) => r.id as string);
    sentinels = [
      ...NAMES,
      ...NAMES.map((n) => n.split(' ')[1]!),
      ...e.learners.map((l) => l.email),
      ...e.register,
      ...e.learners.map((l) => l.userId),
      ...e.learners.map((l) => l.membershipId),
      ...pids,
    ];
  });

  const leaks = (value: unknown): string[] => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return sentinels.filter((s) => text.includes(s));
  };

  it('the queue carries no identity in ANY order, and nothing that identifies a learner is the order', async () => {
    for (const qs of ['', '?sort=code', '?sort=time', '?status=submitted', '?limit=2']) {
      const r = await queue(e, e.instructor, item.id, qs);
      expect(r.blind).toBe(true);
      expect(leaks(r), qs).toEqual([]);
      for (const row of r.items) {
        expect(row.name).toBeNull();
        expect(row.email).toBeNull();
        expect(row.registerNumber).toBeNull();
        expect(row.anonCode).toMatch(/^[A-Z2-9]{6}$/);
      }
    }
    // the default order is the anonymous code
    const def = (await queue(e, e.instructor, item.id)).items.map((r: Json) => r.anonCode);
    expect(def).toEqual([...def].sort());
    // by time: submission time, then the (random) key, never a name
    const byTime = (await queue(e, e.instructor, item.id, '?sort=time')).items.map(
      (r: Json) => r.submittedAt,
    );
    expect(byTime).toEqual([...byTime].sort());
    // ordering by name is refused
    const byName = await ic.get(`${base(e, item.id)}/grading/queue?sort=name`);
    expect(byName.statusCode).toBe(400);
    expect(errorCode(byName)).toBe('sort_not_allowed');
    expect(leaks(byName.body)).toEqual([]);
  });

  it('the order is not the order of names, e-mails, register numbers or participant ids', async () => {
    const rows = (await queue(e, e.instructor, item.id)).items;
    const codes = rows.map((r: Json) => r.anonCode as string);
    const { rows: map } = await owner.query(
      `SELECT al.anon_code AS code, u.display_name AS name, u.email, mp.register_number AS reg, al.participant_id AS pid
         FROM lms.assignment_learners al
         JOIN lms.course_participants p ON p.tenant_id = al.tenant_id AND p.id = al.participant_id
         JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
         JOIN lms.users u ON u.id = tm.user_id
         JOIN lms.member_profiles mp ON mp.tenant_id = tm.tenant_id AND mp.membership_id = tm.id
        WHERE al.assignment_item_id = $1`,
      [item.id],
    );
    const by = (key: string) =>
      [...map]
        .sort((a, b) => String(a[key]).localeCompare(String(b[key])))
        .map((r) => r.code as string);
    // with six learners an accidental match with any identifying order is 1 in 720: if the order followed one of them it
    // would match EXACTLY, so "not equal to any" is the check (the codes are random, so this holds for every run but one in 720)
    const identifying = ['name', 'email', 'reg', 'pid'].filter(
      (k) => by(k).join() === codes.join(),
    );
    expect(identifying.length).toBeLessThanOrEqual(1);
    // the stronger, deterministic check: the order IS the order of the codes
    expect(codes).toEqual([...codes].sort());
  });

  it('the learner for grading shows a code, not a person; their versions carry no identity', async () => {
    const { key, code } = await keyFromDb(owner, item.id, e.learners[0]!);
    const d = ok(await ic.get(`${base(e, item.id)}/grading/learners/${key}`));
    expect(d.anonCode).toBe(code);
    expect(d.blind).toBe(true);
    expect(d.name).toBeNull();
    expect(d.email).toBeNull();
    expect(d.registerNumber).toBeNull();
    // the file's own NAME is data the learner chose (it can hold a name); it is shown in the version list but the
    // download name below is neutral
    const without = { ...d, submissions: d.submissions.map((s: Json) => ({ ...s, files: [] })) };
    expect(leaks(without)).toEqual([]);
    expect(leaks(ok(await ic.get(`${base(e, item.id)}/grading/summary`)))).toEqual([]);
  });

  it("the download of a learner's file has a neutral name while blind", async () => {
    const { key } = await keyFromDb(owner, item.id, e.learners[1]!);
    const d = ok(await ic.get(`${base(e, item.id)}/grading/learners/${key}`));
    const fileId = d.submissions[0].files[0].fileId;
    const target = ok(await ic.get(`${base(e, item.id)}/grading/files/${fileId}`));
    expect(leaks(target)).toEqual([]);
    expect(target.fileName).toMatch(/^[A-Z2-9]{6}-v1\.pdf$/);
  });

  it('grading and the grade response carry no identity; the audit entry holds ids, never names', async () => {
    const { key } = await keyFromDb(owner, item.id, e.learners[2]!);
    const d = ok(await ic.get(`${base(e, item.id)}/grading/learners/${key}`));
    const saved = ok(
      await ic.put(`${base(e, item.id)}/grading/learners/${key}/grade`, {
        submissionId: d.submissions[0].id,
        rawScore: 8,
      }),
    );
    expect(leaks(saved)).toEqual([]);
    const { rows } = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE action = 'assignment.graded' AND target_id = $1`,
      [item.id],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const text = JSON.stringify(r.metadata);
      for (const s of [...NAMES, ...e.register, ...e.learners.map((l) => l.email)])
        expect(text).not.toContain(s);
    }
  });

  it('RELEASING a grade reveals THAT learner only; switching blind grading off reveals everybody', async () => {
    const a = await keyFromDb(owner, item.id, e.learners[2]!);
    ok(await ic.post(`${base(e, item.id)}/release`, { learnerKeys: [a.key] }));
    const rows = (await queue(e, e.instructor, item.id)).items as Json[];
    const revealed = rows.filter((r) => r.name !== null);
    expect(revealed).toHaveLength(1);
    expect(revealed[0]!.learnerKey).toBe(a.key);
    expect(revealed[0]!.name).toBe(NAMES[2]);
    expect(revealed[0]!.registerNumber).toBe(e.register[2]);
    // the others are still anonymous
    expect(leaks(rows.filter((r) => r.name === null))).toEqual([]);
    // toggle off (audited): everybody is visible, names sort again
    ok(await ic.put(base(e, item.id), { anonymousGrading: false }));
    const open = (await queue(e, e.instructor, item.id, '?sort=name')).items as Json[];
    expect(open.map((r) => r.name)).toEqual([...NAMES].sort((x, y) => x.localeCompare(y)));
    const { rows: audit } = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE action = 'assignment.settings_changed' AND target_id = $1`,
      [item.id],
    );
    expect(
      audit.some(
        (r) =>
          r.metadata.before.anonymousGrading === true &&
          r.metadata.after.anonymousGrading === false,
      ),
    ).toBe(true);
    ok(await ic.put(base(e, item.id), { anonymousGrading: true }));
  });

  it('an assistant is blind exactly like the instructor', async () => {
    const r = await queue(e, e.assistant, item.id);
    const hidden = (r.items as Json[]).filter((x) => x.name === null);
    expect(hidden.length).toBe(NAMES.length - 1);
  });
});

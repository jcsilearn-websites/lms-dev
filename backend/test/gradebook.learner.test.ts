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
  person,
  type Structure,
  structure,
} from './courses-helpers';
import {
  assignment,
  base,
  type Class,
  compute,
  gradebookClass,
  participantIds,
  quiz,
  releaseQuiz,
} from './gradebook-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Step 11: what a LEARNER sees. The sentinel test (like steps 9 and 10): every source of a mark is planted with an unreleased
// value that carries a recognisable name, and nothing of it may appear in anything a learner receives. Then: the gradebook
// pulls released quiz and assignment scores, the figures are "provisional" until the lock, and the lock shows the record.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let st: Structure;
let e: Class;
let pids: string[];
let ic: TestClient;
let b: string;
let items: Json = {};
let quizB: Json;
let secretEssay: Json;

const SECRETS = ['SECRET-QUIZ-B', 'SECRET-ESSAY', 'SECRET-VIVA', 'SECRETREASON'];

const mine = async (who: number) =>
  e.learners[who]!.client.get(`/offerings/${e.offeringId}/me/grades`);

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({});
  A = await createAuthFixture(owner, 'gblr-a');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
  e = await gradebookClass(owner, t, A, admin, st, ['Asha', 'Bala', 'Chitra']);
  pids = await participantIds(owner, e.offeringId, e.learners);
  ic = e.instructor.client;
  b = base(e.offeringId);

  const cfg = ok(
    await ic.put(`${b}/categories`, {
      categories: [
        { name: 'Exams', weight: 50, dropLowest: 0, missingPolicy: 'exclude' },
        { name: 'Assignments', weight: 30, dropLowest: 0, missingPolicy: 'exclude' },
        { name: 'Practical', weight: 20, dropLowest: 0, missingPolicy: 'exclude' },
      ],
    }),
  );
  const cats = Object.fromEntries(cfg.categories.map((c: Json) => [c.name, c.id]));
  const quizA = await quiz(e, 'Quiz A', [true, false, true]); // immediate results: visible
  quizB = await quiz(e, 'SECRET-QUIZ-B', [true, true, true], { resultsVisibility: 'manual' }); // graded, NOT released
  const essay = await assignment(owner, e, 'Released Essay', [80, 60, null], {
    release: true,
    dueInPast: true,
  });
  secretEssay = await assignment(owner, e, 'SECRET-ESSAY', [100, 100, 100], { release: false });
  const g = ok(
    await ic.put(`${b}/items`, {
      items: [
        {
          source: 'assessment',
          contentItemId: quizA.id,
          categoryId: cats.Exams,
          points: 10,
          extraCredit: false,
        },
        {
          source: 'assessment',
          contentItemId: quizB.id,
          categoryId: cats.Exams,
          points: 10,
          extraCredit: false,
        },
        {
          source: 'assignment',
          contentItemId: essay.id,
          categoryId: cats.Assignments,
          points: 100,
          extraCredit: false,
        },
        {
          source: 'assignment',
          contentItemId: secretEssay.id,
          categoryId: cats.Assignments,
          points: 100,
          extraCredit: false,
        },
        {
          source: 'manual',
          title: 'Lab',
          categoryId: cats.Practical,
          points: 20,
          extraCredit: false,
          released: true,
        },
        {
          source: 'manual',
          title: 'SECRET-VIVA',
          categoryId: cats.Practical,
          points: 10,
          extraCredit: false,
          released: false,
        },
      ],
    }),
  );
  items = Object.fromEntries(g.items.map((i: Json) => [i.title, i.id]));
  ok(await ic.patch(`${b}/settings`, { weighted: true, outOf: 100 }));
  ok(
    await ic.put(`${b}/marks`, {
      cells: [
        { itemId: items.Lab, participantId: pids[0], points: '15' },
        { itemId: items.Lab, participantId: pids[1], points: '10' },
        { itemId: items['SECRET-VIVA'], participantId: pids[0], points: '10' },
        { itemId: items['SECRET-VIVA'], participantId: pids[1], points: '10' },
        { itemId: items['SECRET-VIVA'], participantId: pids[2], points: '10' },
      ],
    }),
  );
  // overrides that must stay invisible: one on the unreleased item, a final one (it applies at the lock)
  ok(
    await ic.put(`${b}/learners/${pids[1]}/override`, {
      itemId: items['SECRET-VIVA'],
      points: '1',
      reason: 'SECRETREASON viva moderation',
    }),
  );
  ok(
    await ic.put(`${b}/learners/${pids[0]}/override`, {
      itemId: null,
      points: '99',
      reason: 'SECRETREASON moderation',
    }),
  );
}, 240_000);
afterAll(async () => {
  await t.close();
  await owner.end();
});

describe('the gradebook pulls released scores of quizzes and assignments', () => {
  it('a quiz with immediate results and a released assignment count; staff see everything that is graded', async () => {
    const grid = ok(await ic.get(`${b}/grid`));
    const asha = grid.rows.find((r: Json) => r.participantId === pids[0]);
    expect(asha.cells[items['Quiz A']]).toEqual(['s', '10', 0]);
    expect(asha.cells[items['Released Essay']][0]).toBe('s');
    expect(asha.cells[items['Released Essay']][1]).toBe('80');
    // staff also see the unreleased ones
    expect(asha.cells[items['SECRET-QUIZ-B']][0]).toBe('s');
    expect(asha.cells[items['SECRET-ESSAY']][0]).toBe('s');
    // a learner who handed nothing in has no score; a submitted-but-ungraded item is "pending", not a zero
    const chitra = grid.rows.find((r: Json) => r.participantId === pids[2]);
    expect(chitra.cells[items['Released Essay']][0]).toBe('x');
  });

  it('the marks of a quiz are scaled to the points of its gradebook item (score / max x points)', async () => {
    // Quiz A is worth 10 in the gradebook and 10 in the question: change the item to 20 points
    const g = ok(await ic.get(b));
    const next = g.items.map((i: Json) => (i.title === 'Quiz A' ? { ...i, points: 20 } : i));
    ok(await ic.put(`${b}/items`, { items: next }));
    const asha = ok(await ic.get(`${b}/grid`)).rows.find((r: Json) => r.participantId === pids[0]);
    expect(asha.cells[items['Quiz A'] as string]).toEqual(['s', '20', 0]);
    ok(await ic.put(`${b}/items`, { items: g.items }));
  });
});

describe('the two read paths of the calculation agree', () => {
  it('a few learners (unique-key probes) and a whole class (bulk reads) give identical cells, totals, finals and explanations', async () => {
    for (const mode of ['staff', 'learner'] as const) {
      const few = await compute(owner, A.tenantId, e.offeringId, mode, pids, true);
      // more than 25 ids (repeats are harmless) take the bulk path
      const many = await compute(
        owner,
        A.tenantId,
        e.offeringId,
        mode,
        [...pids, ...Array(30).fill(pids[0]!)],
        true,
      );
      const all = await compute(owner, A.tenantId, e.offeringId, mode, null, true);
      const key = (r: Awaited<ReturnType<typeof compute>>) =>
        [...r].sort((a, b) => a.participant_id.localeCompare(b.participant_id));
      expect(key(many), mode).toEqual(key(few));
      expect(key(all), mode).toEqual(key(few));
    }
  });
});

describe('release visibility: nothing unreleased ever reaches a learner (sentinel)', () => {
  it('shows provisional figures from released items only, never a trace of the unreleased ones', async () => {
    const expected = [89, 28, 100]; // see the file comment: hand-calculated from the RELEASED items
    for (let who = 0; who < 3; who++) {
      const res = await mine(who);
      const body = res.body;
      for (const secret of SECRETS)
        expect(body, `${secret} in learner ${who}`).not.toContain(secret);
      for (const id of [
        items['SECRET-QUIZ-B'],
        items['SECRET-ESSAY'],
        items['SECRET-VIVA'],
        quizB.id,
        secretEssay.id,
      ])
        expect(body, 'a secret id').not.toContain(id!);
      const m = res.json();
      expect(m).toMatchObject({ status: 'draft', provisional: true, underRevision: false });
      expect(m.final.grade).toBeNull();
      expect(m.final.isPass).toBeNull();
      expect(m.final.marks).toBe(expected[who]);
      // the explanation lists released items only, with the same numbers the learner can see
      const titles = m.explanation.categories
        .flatMap((c: Json) => c.items.map((i: Json) => i.title))
        .sort();
      expect(titles).toEqual(['Lab', 'Quiz A', 'Released Essay']);
    }
  });

  it('the final override of the instructor is not visible before approval (and its reason never)', async () => {
    const staff = ok(await ic.get(`${b}/grid`)).rows.find((r: Json) => r.participantId === pids[0]);
    expect(staff.finalMarks).toBe(99);
    expect(
      ok(
        await mine(0).then((r) => ({
          statusCode: r.statusCode,
          body: r.body,
          json: () => r.json(),
        })),
      ).final.marks,
    ).toBe(89);
  });

  it('every learner call is free of other learners: a learner reads only their own record', async () => {
    const a = (await mine(0)).json();
    const bb = (await mine(1)).json();
    expect(a.final.marks).not.toBe(bb.final.marks);
    const body = (await mine(0)).body;
    for (const name of ['Bala', 'Chitra']) expect(body).not.toContain(name);
  });

  it('a learner cannot use any staff endpoint, an assistant has no learner record, a stranger does not know the offering', async () => {
    const lc = e.learners[0]!.client;
    for (const url of [
      b,
      `${b}/grid`,
      `${b}/review`,
      `${b}/learners/${pids[1]}`,
      `${b}/export.csv`,
    ]) {
      expect((await lc.get(url)).statusCode, url).toBe(403);
    }
    const asst = await e.assistant.client.get(`/offerings/${e.offeringId}/me/grades`);
    expect(asst.statusCode).toBe(403);
    const stranger = await person(owner, t, A, 'Stranger');
    const s = await stranger.client.get(`/offerings/${e.offeringId}/me/grades`);
    expect(s.statusCode).toBe(404);
    expect(errorCode(s)).toBe('offering_not_found');
  });

  it('releasing an item makes it appear; a draft offering is invisible to its learners', async () => {
    ok(
      await e.instructor.client.post(
        `/offerings/${e.offeringId}/items/${secretEssay.id}/assignment/release`,
        {},
      ),
    );
    const m = (await mine(0)).json();
    const titles = m.explanation.categories.flatMap((c: Json) => c.items.map((i: Json) => i.title));
    expect(titles).toContain('SECRET-ESSAY');
    expect(titles).not.toContain('SECRET-QUIZ-B');
    // assignment 100/100 and released: Assignments = (80 + 100) / 200 = 90 % -> final changes
    expect(m.final.marks).toBe(Math.round(0.5 * 100 + 0.3 * 90 + 0.2 * 75));
    await owner.query(`UPDATE lms.course_offerings SET status = 'draft' WHERE id = $1`, [
      e.offeringId,
    ]);
    const hidden = await mine(0);
    expect(hidden.statusCode).toBe(404);
    await owner.query(`UPDATE lms.course_offerings SET status = 'published' WHERE id = $1`, [
      e.offeringId,
    ]);
  });
});

describe('provisional until locked, then the approved record', () => {
  it('after everything is released and approved the learner sees the frozen final, its grade and the explanation', async () => {
    await releaseQuiz(e, quizB.id);
    const g = ok(await ic.get(b));
    const next = g.items.map((i: Json) =>
      i.title === 'SECRET-VIVA' ? { ...i, released: true } : i,
    );
    ok(await ic.put(`${b}/items`, { items: next }));
    // the final override is for Asha only; a revoked override leaves the calculation
    ok(await ic.delete(`${b}/learners/${pids[0]}/override`));
    const scale = ok(
      await admin.post('/grade-scales', {
        name: 'Learner scale',
        bands: [
          { minPercent: 0, label: 'RA', isPass: false },
          { minPercent: 50, label: 'C', isPass: true },
          { minPercent: 85, label: 'A', isPass: true },
        ],
      }),
    );
    ok(await ic.patch(`${b}/settings`, { scaleId: scale.id }));
    const before = (await mine(0)).json();
    expect(before).toMatchObject({ provisional: true, status: 'draft' });
    ok(await ic.post(`${b}/submit`));
    // while it waits for approval it is still provisional
    expect((await mine(0)).json()).toMatchObject({ provisional: true, status: 'submitted' });
    ok(await admin.post(`${b}/approve`, {}));
    const locked = (await mine(0)).json();
    expect(locked).toMatchObject({ status: 'locked', provisional: false, underRevision: false });
    expect(locked.final.grade).toBe('A');
    expect(locked.final.marks).toBe(before.final.marks);
    expect(locked.explanation.final).toBe(locked.final.marks);
    // the record has no override reasons and no other learner
    for (const secret of ['SECRETREASON', 'Bala', 'Chitra'])
      expect((await mine(0)).body).not.toContain(secret);
  });
});

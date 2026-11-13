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
import { base, type Class, gradebookClass, participantIds } from './gradebook-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Step 11: structure (scales, settings, categories, items), manual marks (grid batch, conflicts, who may enter), the CSV
// import of marks (dry run, errors, formula safety, skip), overrides with a mandatory reason, the explanation of a number.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let st: Structure;
let e: Class;
let pids: string[];
let ic: TestClient;
let ac: TestClient;
let lc: TestClient;
let b: string;
let scaleId: string;
let cats: Record<string, string> = {};
let items: Record<string, string> = {};

const SCALE = {
  name: 'Anna University',
  bands: [
    { minPercent: 0, label: 'RA', isPass: false },
    { minPercent: 50, label: 'C', isPass: true },
    { minPercent: 60, label: 'B', isPass: true },
    { minPercent: 70, label: 'B+', isPass: true },
    { minPercent: 80, label: 'A', isPass: true },
    { minPercent: 90, label: 'A+', isPass: true },
    { minPercent: 95, label: 'O', isPass: true },
  ],
};

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({});
  A = await createAuthFixture(owner, 'gbcfg-a');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
  e = await gradebookClass(owner, t, A, admin, st, ['Asha', 'Bala', 'Chitra']);
  pids = await participantIds(owner, e.offeringId, e.learners);
  ic = e.instructor.client;
  ac = e.assistant.client;
  lc = e.learners[0]!.client;
  b = base(e.offeringId);
}, 120_000);
afterAll(async () => {
  await t.close();
  await owner.end();
});

describe('grade scales (college templates)', () => {
  it('an institution admin manages them; everybody signed in reads them; the lowest band must start at 0', async () => {
    expect((await ic.post('/grade-scales', SCALE)).statusCode).toBe(403);
    const made = ok(await admin.post('/grade-scales', SCALE));
    scaleId = made.id;
    expect(made.bands.map((x: Json) => x.label)).toEqual(['O', 'A+', 'A', 'B+', 'B', 'C', 'RA']);
    expect(made.bands.at(-1)).toMatchObject({ minPercent: 0, isPass: false });
    expect(ok(await ic.get('/grade-scales')).items.map((x: Json) => x.name)).toContain(SCALE.name);
    expect(ok(await lc.get('/grade-scales')).items).toHaveLength(1);
    const noZero = await admin.post('/grade-scales', {
      name: 'Broken',
      bands: [{ minPercent: 40, label: 'P', isPass: true }],
    });
    expect(noZero.statusCode).toBe(400);
    expect(errorCode(noZero)).toBe('invalid_gradebook');
    const same = await admin.post('/grade-scales', { ...SCALE, name: SCALE.name });
    expect(same.statusCode).toBe(409);
    expect(errorCode(same)).toBe('grade_scale_name_taken');
    const dup = await admin.post('/grade-scales', {
      name: 'Dup labels',
      bands: [
        { minPercent: 0, label: 'A', isPass: true },
        { minPercent: 50, label: 'A', isPass: true },
      ],
    });
    expect(dup.statusCode).toBe(400);
  });

  it('edits replace the bands; archiving hides the scale from the default list', async () => {
    const upd = ok(
      await admin.put(`/grade-scales/${scaleId}`, {
        ...SCALE,
        bands: [...SCALE.bands, { minPercent: 99, label: 'S', isPass: true }],
      }),
    );
    expect(upd.bands).toHaveLength(8);
    const other = ok(
      await admin.post('/grade-scales', {
        name: 'Pass / fail',
        bands: [
          { minPercent: 0, label: 'F', isPass: false },
          { minPercent: 40, label: 'P', isPass: true },
        ],
      }),
    );
    ok(await admin.patch(`/grade-scales/${other.id}`, { archived: true }));
    expect(ok(await admin.get('/grade-scales')).items.map((x: Json) => x.name)).not.toContain(
      'Pass / fail',
    );
    expect(ok(await admin.get('/grade-scales?includeArchived=true')).items).toHaveLength(2);
  });
});

describe('structure', () => {
  it('a new offering has a gradebook with one default category, in draft', async () => {
    const g = ok(await ic.get(b));
    expect(g).toMatchObject({
      status: 'draft',
      versionNo: 1,
      weighted: false,
      outOf: 100,
      roundMode: 'half_up',
      roundDecimals: 0,
      scale: null,
      items: [],
      selfApprovalAllowed: false,
    });
    expect(g.categories).toMatchObject([
      { name: 'General', weight: 100, dropLowest: 0, missingPolicy: 'exclude' },
    ]);
    // the assistant may look, a learner (a participant without the permission) may not, a stranger does not know it exists
    expect((await ac.get(b)).statusCode).toBe(200);
    expect((await lc.get(b)).statusCode).toBe(403);
    const stranger = await person(owner, t, A, 'Stranger');
    expect((await stranger.client.get(b)).statusCode).toBe(404);
  });

  it('only the instructor changes settings; weights, out-of, rounding and the scale are saved', async () => {
    const patch = { weighted: true, outOf: 40, roundMode: 'half_even', roundDecimals: 1, scaleId };
    expect((await ac.patch(`${b}/settings`, patch)).statusCode).toBe(403);
    const g = ok(await ic.patch(`${b}/settings`, patch));
    expect(g).toMatchObject({
      weighted: true,
      outOf: 40,
      roundMode: 'half_even',
      roundDecimals: 1,
    });
    expect(g.scale.name).toBe(SCALE.name);
    const bad = await ic.patch(`${b}/settings`, {
      scaleId: '00000000-0000-4000-8000-000000000000',
    });
    expect(bad.statusCode).toBe(400);
    expect((await ic.patch(`${b}/settings`, { outOf: 0 })).statusCode).toBe(400);
    expect((await ic.patch(`${b}/settings`, { roundDecimals: 3 })).statusCode).toBe(400);
  });

  it('categories: names are unique, an emptied category can go, a used one cannot', async () => {
    const dup = await ic.put(`${b}/categories`, {
      categories: [
        { name: 'Tests', weight: 50, dropLowest: 0, missingPolicy: 'exclude' },
        { name: 'tests', weight: 50, dropLowest: 0, missingPolicy: 'exclude' },
      ],
    });
    expect(dup.statusCode).toBe(400);
    const g = ok(
      await ic.put(`${b}/categories`, {
        categories: [
          { name: 'Internal tests', weight: 50, dropLowest: 1, missingPolicy: 'zero_after_due' },
          { name: 'Assignments', weight: 30, dropLowest: 0, missingPolicy: 'exclude' },
          { name: 'Quizzes', weight: 20, dropLowest: 0, missingPolicy: 'exclude' },
        ],
      }),
    );
    expect(g.categories.map((c: Json) => c.name)).toEqual([
      'Internal tests',
      'Assignments',
      'Quizzes',
    ]);
    cats = Object.fromEntries(g.categories.map((c: Json) => [c.name, c.id]));
    expect(
      (
        await ac.put(`${b}/categories`, {
          categories: [{ name: 'x', weight: 1, dropLowest: 0, missingPolicy: 'exclude' }],
        })
      ).statusCode,
    ).toBe(403);
    expect((await ic.put(`${b}/categories`, { categories: [] })).statusCode).toBe(400);
  });

  it('items: manual columns and the assessments / assignments of the offering; the rest is offered as candidates', async () => {
    const { quiz: mkQuiz, assignment } = await import('./gradebook-helpers');
    const qz = await mkQuiz(e, 'Quiz 1', [true, false, null], { resultsVisibility: 'manual' });
    const asg = await assignment(owner, e, 'Essay', [40, 30, null], { max: 50 });
    const g0 = ok(await ic.get(b));
    expect(g0.candidates.map((c: Json) => [c.title, c.kind, c.defaultPoints]).sort()).toEqual(
      [
        ['Essay', 'assignment', 50],
        ['Quiz 1', 'assessment', 10],
      ].sort(),
    );
    const g = ok(
      await ic.put(`${b}/items`, {
        items: [
          {
            source: 'manual',
            title: 'Test 1',
            categoryId: cats['Internal tests'],
            points: 50,
            extraCredit: false,
            released: true,
            assistantsMayEnter: false,
          },
          {
            source: 'manual',
            title: 'Test 2',
            categoryId: cats['Internal tests'],
            points: 50,
            extraCredit: false,
            released: true,
            assistantsMayEnter: true,
          },
          {
            source: 'assignment',
            contentItemId: asg.id,
            categoryId: cats.Assignments,
            points: 30,
            extraCredit: false,
          },
          {
            source: 'assessment',
            contentItemId: qz.id,
            categoryId: cats.Quizzes,
            points: 10,
            extraCredit: false,
          },
        ],
      }),
    );
    expect(g.items).toHaveLength(4);
    expect(g.items.find((i: Json) => i.title === 'Essay')).toMatchObject({
      source: 'assignment',
      points: 30,
      categoryId: cats.Assignments,
    });
    expect(g.candidates).toEqual([]);
    items = Object.fromEntries(g.items.map((i: Json) => [i.title, i.id]));
    // a content item that is not in this offering is refused, nothing of the call is kept
    const bad = await ic.put(`${b}/items`, {
      items: [
        ...g.items.map((i: Json) => ({ ...i })),
        {
          source: 'assessment',
          contentItemId: '00000000-0000-4000-8000-000000000000',
          categoryId: cats.Quizzes,
          points: 5,
          extraCredit: false,
        },
      ],
    });
    expect(bad.statusCode).toBe(400);
    expect(ok(await ic.get(b)).items).toHaveLength(4);
    // two manual columns with one name
    expect(
      (
        await ic.put(`${b}/items`, {
          items: [
            {
              source: 'manual',
              title: 'X',
              categoryId: cats.Quizzes,
              points: 5,
              extraCredit: false,
            },
            {
              source: 'manual',
              title: 'x',
              categoryId: cats.Quizzes,
              points: 5,
              extraCredit: false,
            },
          ],
        })
      ).statusCode,
    ).toBe(400);
  });

  it('an item left out of a save is archived, not deleted: its marks stay', async () => {
    const g = ok(await ic.get(b));
    const keep = g.items.filter((i: Json) => i.title !== 'Test 1');
    const after = ok(await ic.put(`${b}/items`, { items: keep }));
    expect(after.items).toHaveLength(3);
    const { rows } = await owner.query(
      `SELECT archived_at IS NOT NULL AS archived FROM lms.gradebook_items WHERE id = $1`,
      [items['Test 1']],
    );
    expect(rows[0].archived).toBe(true);
    // put it back (the same row comes back)
    const back = ok(
      await ic.put(`${b}/items`, {
        items: [
          {
            id: items['Test 1'],
            source: 'manual',
            title: 'Test 1',
            categoryId: cats['Internal tests'],
            points: 50,
            extraCredit: false,
            released: true,
            assistantsMayEnter: false,
          },
          ...after.items,
        ],
      }),
    );
    expect(back.items).toHaveLength(4);
    expect(back.items.find((i: Json) => i.title === 'Test 1').id).toBe(items['Test 1']);
  });
});

describe('manual marks (the grid)', () => {
  const cell = (item: string, who: number, points: string | null, extra: Json = {}) => ({
    itemId: items[item],
    participantId: pids[who],
    points,
    ...extra,
  });

  it('a batch saves, returns the recomputed rows of the learners it touched, and writes history + one audit entry', async () => {
    const r = ok(
      await ic.put(`${b}/marks`, {
        cells: [
          cell('Test 1', 0, '40'),
          cell('Test 1', 1, '30.5'),
          cell('Test 2', 0, '45'),
          cell('Test 2', 1, '50'),
        ],
      }),
    );
    expect(r).toMatchObject({ saved: 4, unchanged: 0, conflicts: [], invalid: [] });
    expect(Object.keys(r.rows).sort()).toEqual([pids[0], pids[1]].sort());
    expect(r.rows[pids[0]!].cells[items['Test 1']!]).toEqual(['s', '40', 1]); // the lower of two tests is dropped
    // Internal tests: drop 1 of 2 -> only the better one counts: Test 2 45/50 = 90 %
    expect(r.rows[pids[0]!].cats[cats['Internal tests']!]).toMatchObject({ p: 90 });
    const { rows: hist } = await owner.query(
      `SELECT count(*)::int AS n FROM lms.manual_mark_history WHERE item_id = $1`,
      [items['Test 1']],
    );
    expect(hist[0].n).toBe(2);
    const { rows: au } = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE action = 'gradebook.marks_saved' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(au[0].metadata).toMatchObject({ cells: 4, learners: 2, source: 'grid' });
    // the same values again change nothing
    const again = ok(
      await ic.put(`${b}/marks`, { cells: [cell('Test 1', 0, '40', { expected: '40' })] }),
    );
    expect(again).toMatchObject({ saved: 0, unchanged: 1 });
  });

  it('a cell with a stale expected value is reported, not overwritten; an empty value clears a cell', async () => {
    const stale = ok(
      await ic.put(`${b}/marks`, { cells: [cell('Test 1', 0, '10', { expected: '35' })] }),
    );
    expect(stale.saved).toBe(0);
    expect(stale.conflicts).toEqual([
      { itemId: items['Test 1'], participantId: pids[0], current: 40 },
    ]);
    const { rows } = await owner.query(
      'SELECT points FROM lms.manual_marks WHERE item_id = $1 AND participant_id = $2',
      [items['Test 1'], pids[0]],
    );
    expect(Number(rows[0].points)).toBe(40);
    const cleared = ok(
      await ic.put(`${b}/marks`, { cells: [cell('Test 1', 1, null, { expected: '30.5' })] }),
    );
    expect(cleared.saved).toBe(1);
    expect(cleared.rows[pids[1]!].cells[items['Test 1']!][0]).toBe('z'); // released + "zero after due": a missing mark counts as 0
  });

  it('invalid cells are reported and nothing else is lost: above the maximum, more than two decimals, unknown learner / item, auto items', async () => {
    const r = ok(
      await ic.put(`${b}/marks`, {
        cells: [
          cell('Test 2', 2, '51'),
          {
            itemId: items['Test 2'],
            participantId: '00000000-0000-4000-8000-000000000000',
            points: '5',
          },
          { itemId: items.Essay, participantId: pids[2], points: '5' },
          cell('Test 2', 2, '33'),
        ],
      }),
    );
    // 51 and 33 are the same cell (the LAST one of a cell wins): only 33 is applied; the invalid ones are reported
    expect(r.saved).toBe(1);
    expect(r.invalid.map((x: Json) => x.reason).sort()).toEqual(['bad_item', 'bad_participant']);
    const bad = await ic.put(`${b}/marks`, { cells: [cell('Test 2', 2, '1.234')] });
    expect(bad.statusCode).toBe(400); // fails the TypeBox pattern (at most two decimals)
    const over = ok(await ic.put(`${b}/marks`, { cells: [cell('Test 2', 1, '50.01')] }));
    expect(over.invalid).toEqual([
      { itemId: items['Test 2'], participantId: pids[1], reason: 'bad_value' },
    ]);
  });

  it('an assistant enters marks only in items that allow it; a learner cannot at all', async () => {
    const forbidden = await ac.put(`${b}/marks`, { cells: [cell('Test 1', 2, '20')] });
    expect(forbidden.statusCode).toBe(403);
    const allowed = ok(await ac.put(`${b}/marks`, { cells: [cell('Test 2', 2, '44')] }));
    expect(allowed.saved).toBe(1);
    expect((await lc.put(`${b}/marks`, { cells: [cell('Test 2', 0, '1')] })).statusCode).toBe(403);
    // a mixed batch is refused as a whole
    const mixed = await ac.put(`${b}/marks`, {
      cells: [cell('Test 2', 2, '43'), cell('Test 1', 2, '20')],
    });
    expect(mixed.statusCode).toBe(403);
    const { rows } = await owner.query(
      'SELECT points FROM lms.manual_marks WHERE item_id = $1 AND participant_id = $2',
      [items['Test 2'], pids[2]],
    );
    expect(Number(rows[0].points)).toBe(44);
    // only the instructor changes whether assistants may enter
    expect((await ac.put(`${b}/items`, { items: [] })).statusCode).toBe(403);
  });

  it('the grid is keyset-paged by register number, filters by section and carries totals, not explanations', async () => {
    const all = ok(await ic.get(`${b}/grid?limit=500`));
    expect(all.rows).toHaveLength(3);
    expect(all.total).toBe(3);
    expect(all.nextCursor).toBeNull();
    const regs = all.rows.map((r: Json) => r.registerNumber);
    expect([...regs].sort()).toEqual(regs);
    const p1 = ok(await ic.get(`${b}/grid?limit=2`));
    expect(p1.rows).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = ok(await ic.get(`${b}/grid?limit=2&after=${encodeURIComponent(p1.nextCursor)}`));
    expect(p2.rows).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect([...p1.rows, ...p2.rows].map((r: Json) => r.participantId)).toEqual(
      all.rows.map((r: Json) => r.participantId),
    );
    expect(ok(await ic.get(`${b}/grid?section=${st.sectionB}`)).rows).toHaveLength(0);
    expect(ok(await ic.get(`${b}/grid?section=${st.sectionA}`)).rows).toHaveLength(3);
    expect(all.rows[0]).not.toHaveProperty('explanation');
    expect((await ic.get(`${b}/grid?limit=501`)).statusCode).toBe(400);
    expect((await ic.get(`${b}/grid?after=nonsense`)).statusCode).toBe(400);
  });
});

describe('CSV import of marks', () => {
  const stage = (csv: string, c = ic) => c.post(`${b}/mark-imports`, { csv });
  let regs: string[];
  beforeAll(async () => {
    regs = e.register;
  });

  it('a dry run writes nothing and lists every error with its row, column and value', async () => {
    const csv = [
      'register_number,Test 1,Test 2,Nope',
      `${regs[0]},41,,7`,
      `${regs[1]},abc,12.5,`,
      `NOSUCH,10,10,`,
      `${regs[2]},999,,`,
    ].join('\n');
    const s = ok(await stage(csv));
    expect(s).toMatchObject({ rows: 4, status: 'staged', unknownColumns: ['Nope'] });
    const msgs = s.errors.map((x: Json) => `${x.row}:${x.column}:${x.error.split(' ')[0]}`).sort();
    expect(msgs).toEqual(
      ['2:Nope:unknown', '3:Test 1:not', '4:Test 1:no', '4:Test 2:no', '5:Test 1:more'].sort(),
    );
    const { rows } = await owner.query(
      `SELECT points FROM lms.manual_marks WHERE item_id = $1 AND participant_id = $2`,
      [items['Test 1'], pids[0]],
    );
    expect(Number(rows[0].points)).toBe(40); // untouched by the dry run
    // applying without skipInvalid is refused
    const refused = await ic.post(`${b}/mark-imports/${s.importId}/apply`, {});
    expect(refused.statusCode).toBe(409);
    expect(errorCode(refused)).toBe('mark_import_has_errors');
    // the staged import can be read again
    expect(ok(await ic.get(`${b}/mark-imports/${s.importId}`)).errorCells).toBe(s.errorCells);
  });

  it('apply with skipInvalid applies the rows without errors and skips the others as a whole', async () => {
    const csv = [
      'register number,Test 1,Test 2',
      `${regs[0]},41,12`,
      `${regs[1]},abc,12.5`,
      `${regs[2]},20,`,
    ].join('\n');
    const s = ok(await stage(csv));
    expect(s.errorRows).toBe(1);
    const done = ok(await ic.post(`${b}/mark-imports/${s.importId}/apply`, { skipInvalid: true }));
    expect(done).toMatchObject({ saved: 3, skippedRows: 1 });
    const m = async (item: string, who: number) =>
      (
        await owner.query(
          'SELECT points FROM lms.manual_marks WHERE item_id = $1 AND participant_id = $2',
          [items[item], pids[who]],
        )
      ).rows[0];
    expect(Number((await m('Test 1', 0)).points)).toBe(41);
    expect(Number((await m('Test 2', 0)).points)).toBe(12);
    expect(Number((await m('Test 2', 1)).points)).toBe(50); // the row with "abc" was skipped as a whole
    expect(await m('Test 1', 2)).toMatchObject({ points: '20.00' });
    const again = await ic.post(`${b}/mark-imports/${s.importId}/apply`, {});
    expect(errorCode(again)).toBe('mark_import_done');
    const { rows: h } = await owner.query(
      `SELECT count(*)::int AS n FROM lms.manual_mark_history WHERE source = 'import'`,
    );
    expect(h[0].n).toBe(3);
  });

  it('formula injection: a cell that would run as a formula never becomes a mark, and is never echoed as a formula', async () => {
    const csv = [
      'register_number,Test 1',
      `${regs[0]},=SUM(A1)`,
      `=cmd|calc,5`,
      `${regs[1]},@A1`,
      `${regs[2]},+5`,
    ].join('\n');
    const s = ok(await stage(csv));
    expect(s.errorCells).toBe(4);
    const { rows } = await owner.query(
      `SELECT points FROM lms.manual_marks WHERE item_id = $1 AND participant_id = $2`,
      [items['Test 1'], pids[0]],
    );
    expect(Number(rows[0].points)).toBe(41);
  });

  it('bad files are refused with a clear message; an assistant imports only into allowed columns', async () => {
    expect(errorCode(await stage('Test 1,Test 2\n1,2'))).toBe('invalid_marks_csv');
    expect(errorCode(await stage('register_number,Test 1,test 1\nR1,1,2'))).toBe(
      'invalid_marks_csv',
    );
    expect(errorCode(await stage('register_number,Test 1'))).toBe('invalid_marks_csv');
    expect(errorCode(await stage('register_number,Test 1\nR1,'))).toBe('invalid_marks_csv');
    const s = ok(await stage(`register_number,Test 1\n${regs[0]},3`, ac));
    expect(s.errors[0].error).toMatch(/may not enter/);
    expect((await stage(`register_number,Test 1\n${regs[0]},3`, lc)).statusCode).toBe(403);
    const ok2 = ok(await stage(`register_number,Test 2\n${regs[0]},3`, ac));
    expect(ok2.errorCells).toBe(0);
  });
});

describe('overrides', () => {
  it('need a reason of at least three characters, a value within the maximum, and replace the mark in the calculation', async () => {
    const url = `${b}/learners/${pids[2]}/override`;
    expect(
      (await ic.put(url, { itemId: items['Test 1'], points: '45', reason: 'ab' })).statusCode,
    ).toBe(400);
    expect(
      (await ic.put(url, { itemId: items['Test 1'], points: '51', reason: 'medical' })).statusCode,
    ).toBe(400);
    expect(
      (await ac.put(url, { itemId: items['Test 1'], points: '45', reason: 'medical' })).statusCode,
    ).toBe(403);
    ok(
      await ic.put(url, {
        itemId: items['Test 1'],
        points: '45',
        reason: 'Missed the test: medical certificate',
      }),
    );
    const x = ok(await ic.get(`${b}/learners/${pids[2]}`));
    expect(x.overrides).toMatchObject([
      { itemId: items['Test 1'], points: 45, reason: 'Missed the test: medical certificate' },
    ]);
    const t1 = x.explanation.categories[0].items.find((i: Json) => i.title === 'Test 1');
    expect(t1).toMatchObject({ state: 'o', earned: 45 });
    // replaced: one active override per cell, the previous one is kept as revoked history
    ok(await ic.put(url, { itemId: items['Test 1'], points: '46', reason: 'Re-test result' }));
    const { rows } = await owner.query(
      `SELECT points, revoked_at IS NOT NULL AS revoked FROM lms.grade_overrides WHERE participant_id = $1 AND item_id = $2 ORDER BY set_at`,
      [pids[2], items['Test 1']],
    );
    expect(rows.map((r) => [Number(r.points), r.revoked])).toEqual([
      [45, true],
      [46, false],
    ]);
  });

  it('a final override replaces the final and is explained as such; both are audited with the reason', async () => {
    const url = `${b}/learners/${pids[2]}/override`;
    ok(await ic.put(url, { itemId: null, points: '33.5', reason: 'Moderation: +2 marks' }));
    const x = ok(await ic.get(`${b}/learners/${pids[2]}`));
    expect(x.explanation).toMatchObject({ overridden: true, final: 33.5 });
    const grid = ok(await ic.get(`${b}/grid`));
    const row = grid.rows.find((r: Json) => r.participantId === pids[2]);
    expect(row).toMatchObject({ finalMarks: 33.5, overridden: true });
    const { rows } = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE action = 'gradebook.override_set' ORDER BY created_at`,
    );
    expect(rows.map((r) => r.metadata.reason)).toEqual([
      'Missed the test: medical certificate',
      'Re-test result',
      'Moderation: +2 marks',
    ]);
    expect(rows[1].metadata).toMatchObject({ before: 45, after: 46 });
  });

  it('removing an override restores the calculation; the history stays', async () => {
    const url = `${b}/learners/${pids[2]}/override`;
    ok(await ic.delete(url));
    ok(await ic.delete(`${url}?itemId=${items['Test 1']}`));
    const x = ok(await ic.get(`${b}/learners/${pids[2]}`));
    expect(x.overrides).toEqual([]);
    expect(x.explanation.overridden).toBe(false);
    expect((await ic.delete(url)).statusCode).toBe(404);
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM lms.grade_overrides WHERE participant_id = $1`,
      [pids[2]],
    );
    expect(rows[0].n).toBe(3);
  });
});

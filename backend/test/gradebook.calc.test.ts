// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import fc from 'fast-check';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import type { TestClient } from './client';
import { loginAs, type Structure, structure } from './courses-helpers';
import {
  compute,
  configureDb,
  gradebookClass,
  participantIds,
  resetGradebook,
  setMark,
  setOverrideDb,
} from './gradebook-helpers';
import {
  eq,
  parseDecimal,
  q,
  type RefCase,
  type RoundMode,
  reference,
  roundQ,
  show,
} from './gradebook-reference';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Step 11: the calculation. Every rule of the specification, then property tests: random weights, drops, missing policies and
// rounding against the simple reference implementation (BigInt rationals), which the SQL function must match EXACTLY.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let st: Structure;
let cls: Awaited<ReturnType<typeof gradebookClass>>;
let pids: string[];

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({});
  A = await createAuthFixture(owner, 'gbc-a');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
  cls = await gradebookClass(owner, t, A, admin, st, ['Asha', 'Bala', 'Chitra']);
  pids = await participantIds(owner, cls.offeringId, cls.learners);
}, 120_000);
afterAll(async () => {
  await t.close();
  await owner.end();
});

const mark = (item: string, who: number, v: number | string) =>
  setMark(owner, A.tenantId, item, pids[who]!, v);
const final = async (who = 0, mode: 'staff' | 'learner' = 'staff') =>
  (await compute(owner, A.tenantId, cls.offeringId, mode, [pids[who]!], true))[0]!;

const SCALE = [
  { min: 0, label: 'RA', pass: false },
  { min: 50, label: 'C' },
  { min: 60, label: 'B' },
  { min: 70, label: 'B+' },
  { min: 80, label: 'A' },
  { min: 90, label: 'A+' },
  { min: 95, label: 'O' },
];

describe('categories, weights, drop lowest, extra credit', () => {
  it('weights combine category percentages; the result is scaled to "out of"', async () => {
    await resetGradebook(owner, A.tenantId, cls.offeringId);
    const g = await configureDb(owner, A.tenantId, cls.offeringId, {
      weighted: true,
      outOf: 40,
      categories: [
        { name: 'Internal tests', weight: 50 },
        { name: 'Assignments', weight: 30 },
        { name: 'Quizzes', weight: 20 },
      ],
      manual: [
        { title: 'T1', points: 50, category: 'Internal tests', released: true },
        { title: 'A1', points: 20, category: 'Assignments', released: true },
        { title: 'Q1', points: 10, category: 'Quizzes', released: true },
      ],
      scale: SCALE,
    });
    await mark(g.itemIds.T1!, 0, 40); // 80 %
    await mark(g.itemIds.A1!, 0, 15); // 75 %
    await mark(g.itemIds.Q1!, 0, 10); // 100 %
    // 0.5*80 + 0.3*75 + 0.2*100 = 40 + 22.5 + 20 = 82.5 % of 40 = 33
    const r = await final();
    expect(r.final_marks).toBe('33');
    expect(r.final_percent).toBe('82.5000');
    expect(r.grade).toBe('A');
    expect(r.explanation.weightTotal).toBe(100);
    expect(r.explanation.categories.map((c: { name: string }) => c.name)).toEqual([
      'Internal tests',
      'Assignments',
      'Quizzes',
    ]);
  });

  it('plain points when the gradebook is not weighted', async () => {
    await resetGradebook(owner, A.tenantId, cls.offeringId);
    const g = await configureDb(owner, A.tenantId, cls.offeringId, {
      weighted: false,
      outOf: 100,
      categories: [{ name: 'Everything', weight: 0 }],
      manual: [
        { title: 'P1', points: 30, category: 'Everything', released: true },
        { title: 'P2', points: 70, category: 'Everything', released: true },
      ],
      scale: SCALE,
    });
    await mark(g.itemIds.P1!, 0, 15);
    await mark(g.itemIds.P2!, 0, 35);
    expect((await final()).final_marks).toBe('50'); // 50 of 100 points
  });

  it('drops the lowest N of a category (never the last one), by percent', async () => {
    await resetGradebook(owner, A.tenantId, cls.offeringId);
    const g = await configureDb(owner, A.tenantId, cls.offeringId, {
      weighted: true,
      outOf: 100,
      categories: [{ name: 'Quizzes', weight: 100, dropLowest: 2 }],
      manual: ['Q1', 'Q2', 'Q3', 'Q4'].map((title) => ({
        title,
        points: 10,
        category: 'Quizzes',
        released: true,
      })),
      scale: SCALE,
    });
    for (const [t2, v] of [
      ['Q1', 2],
      ['Q2', 9],
      ['Q3', 4],
      ['Q4', 10],
    ] as const)
      await mark(g.itemIds[t2]!, 0, v);
    const r = await final();
    // Q1 (20 %) and Q3 (40 %) are dropped: (9 + 10) / 20 = 95 %
    expect(r.final_marks).toBe('95');
    const items = r.explanation.categories[0].items as { title: string; dropped: boolean }[];
    expect(
      items
        .filter((i) => i.dropped)
        .map((i) => i.title)
        .sort(),
    ).toEqual(['Q1', 'Q3']);
    // a category with a single scored item never drops it
    await owner.query(`UPDATE lms.gradebook_categories SET drop_lowest = 10 WHERE id = $1`, [
      g.categoryIds.Quizzes,
    ]);
    const r2 = await final();
    expect(
      r2.explanation.categories[0].items.filter((i: { dropped: boolean }) => i.dropped),
    ).toHaveLength(3);
    expect(r2.final_marks).toBe('100'); // only Q4 (10 / 10) is left
  });

  it('extra credit adds to the earned points but not to the maximum, and is never dropped', async () => {
    await resetGradebook(owner, A.tenantId, cls.offeringId);
    const g = await configureDb(owner, A.tenantId, cls.offeringId, {
      weighted: true,
      outOf: 100,
      categories: [{ name: 'Work', weight: 100, dropLowest: 1 }],
      manual: [
        { title: 'W1', points: 10, category: 'Work', released: true },
        { title: 'W2', points: 10, category: 'Work', released: true },
        { title: 'Bonus', points: 5, category: 'Work', released: true, extra: true },
      ],
      scale: SCALE,
    });
    await mark(g.itemIds.W1!, 0, 6);
    await mark(g.itemIds.W2!, 0, 10);
    await mark(g.itemIds.Bonus!, 0, 0); // the bonus is the lowest percent, still not dropped
    const r = await final();
    // W1 (60 %) dropped: (10 + 0) / 10 = 100 %
    expect(r.final_marks).toBe('100');
    await mark(g.itemIds.Bonus!, 0, 5);
    expect((await final()).final_marks).toBe('150'); // (10 + 5) / 10
  });

  it('a category with nothing to count does not take part: weights renormalise over the categories that count', async () => {
    await resetGradebook(owner, A.tenantId, cls.offeringId);
    const g = await configureDb(owner, A.tenantId, cls.offeringId, {
      weighted: true,
      outOf: 100,
      categories: [
        { name: 'Tests', weight: 70 },
        { name: 'Labs', weight: 30 },
      ],
      manual: [
        { title: 'T', points: 10, category: 'Tests', released: true },
        { title: 'L', points: 10, category: 'Labs', released: true },
      ],
      scale: SCALE,
    });
    await mark(g.itemIds.T!, 0, 8);
    // Labs has no mark yet: the provisional total is the 80 % of Tests alone
    expect((await final()).final_marks).toBe('80');
    await mark(g.itemIds.L!, 0, 10);
    expect((await final()).final_marks).toBe('86'); // 0.7*80 + 0.3*100
  });
});

describe('missing work', () => {
  it('"exclude": a missing mark is left out until graded; adding a new manual column never lowers a provisional total', async () => {
    await resetGradebook(owner, A.tenantId, cls.offeringId);
    const g = await configureDb(owner, A.tenantId, cls.offeringId, {
      weighted: true,
      outOf: 100,
      categories: [{ name: 'Work', weight: 100, missing: 'exclude' }],
      manual: [{ title: 'W1', points: 10, category: 'Work', released: true }],
      scale: SCALE,
    });
    await mark(g.itemIds.W1!, 0, 8);
    expect((await final()).final_marks).toBe('80');
    // a new column appears: nobody has a mark in it
    await owner.query(
      `INSERT INTO lms.gradebook_items (id, tenant_id, gradebook_id, category_id, source, title, points, position)
       VALUES (lms.uuid_v7(), $1, $2, $3, 'manual', 'Viva', 20, 9)`,
      [A.tenantId, g.gradebookId, g.categoryIds.Work],
    );
    expect((await final()).final_marks).toBe('80');
    const cell = Object.values((await final()).cells).map((c) => c[0]);
    expect(cell.sort()).toEqual(['s', 'x']);
  });

  it('"zero after due": a missing manual mark counts as zero only after its due date has passed or the item is released', async () => {
    await resetGradebook(owner, A.tenantId, cls.offeringId);
    const g = await configureDb(owner, A.tenantId, cls.offeringId, {
      weighted: true,
      outOf: 100,
      categories: [{ name: 'Work', weight: 100, missing: 'zero_after_due' }],
      manual: [
        { title: 'Done', points: 10, category: 'Work', released: true },
        { title: 'NoDue', points: 10, category: 'Work' },
        { title: 'Future', points: 10, category: 'Work', dueAt: '2999-01-01T00:00:00Z' },
        { title: 'Past', points: 10, category: 'Work', dueAt: '2020-01-01T00:00:00Z' },
      ],
      scale: SCALE,
    });
    await mark(g.itemIds.Done!, 0, 10);
    // NoDue (unreleased, no date) and Future are left out; Past counts as 0: 10 / 20
    let r = await final();
    expect(r.final_marks).toBe('50');
    const states = (title: string) => r.cells[g.itemIds[title]!]![0];
    expect([states('NoDue'), states('Future'), states('Past')]).toEqual(['x', 'x', 'z']);
    // releasing the item makes its missing marks count as zero
    await owner.query(`UPDATE lms.gradebook_items SET released = true WHERE id = $1`, [
      g.itemIds.NoDue,
    ]);
    r = await final();
    expect(states('NoDue')).toBe('z');
    expect(r.final_marks).toBe('33'); // 10 / 30
  });

  it('a hidden (unreleased) manual item does not exist for the learner', async () => {
    await resetGradebook(owner, A.tenantId, cls.offeringId);
    const g = await configureDb(owner, A.tenantId, cls.offeringId, {
      weighted: true,
      outOf: 100,
      categories: [{ name: 'Work', weight: 100, missing: 'zero_after_due' }],
      manual: [
        { title: 'Shown', points: 10, category: 'Work', released: true },
        {
          title: 'Secret',
          points: 10,
          category: 'Work',
          released: false,
          dueAt: '2020-01-01T00:00:00Z',
        },
      ],
      scale: SCALE,
    });
    await mark(g.itemIds.Shown!, 0, 9);
    await mark(g.itemIds.Secret!, 0, 1);
    const staff = await final(0, 'staff');
    expect(staff.final_marks).toBe('50'); // (9 + 1) / 20
    const learner = await final(0, 'learner');
    expect(learner.final_marks).toBe('90');
    expect(Object.keys(learner.cells)).toContain(g.itemIds.Secret);
    expect(learner.cells[g.itemIds.Secret!]).toEqual(['h', null, 0]);
    // the explanation of a learner does not mention the secret item at all
    expect(JSON.stringify(learner.explanation)).not.toContain('Secret');
    expect(JSON.stringify(learner.explanation)).not.toContain(g.itemIds.Secret!);
  });
});

describe('rounding', () => {
  async function marksFor(
    mode: RoundMode,
    decimals: number,
    earned: number,
    points: number,
    outOf: number,
  ) {
    await resetGradebook(owner, A.tenantId, cls.offeringId);
    const g = await configureDb(owner, A.tenantId, cls.offeringId, {
      weighted: false,
      outOf,
      roundMode: mode,
      roundDecimals: decimals,
      categories: [{ name: 'W', weight: 0 }],
      manual: [{ title: 'X', points, category: 'W', released: true }],
      scale: SCALE,
    });
    await mark(g.itemIds.X!, 0, earned);
    return (await final()).final_marks;
  }

  it('half up, half even, floor and ceiling on exact ties (0.5, 1.5, 2.5 marks)', async () => {
    // 1 of 2 points out of 1 = 0.5, out of 3 = 1.5, out of 5 = 2.5 marks
    expect(await marksFor('half_up', 0, 1, 2, 1)).toBe('1');
    expect(await marksFor('half_even', 0, 1, 2, 1)).toBe('0');
    expect(await marksFor('half_even', 0, 1, 2, 3)).toBe('2');
    expect(await marksFor('half_even', 0, 1, 2, 5)).toBe('2');
    expect(await marksFor('half_up', 0, 1, 2, 5)).toBe('3');
    expect(await marksFor('floor', 0, 1, 2, 5)).toBe('2');
    expect(await marksFor('ceil', 0, 1, 2, 5)).toBe('3');
  });

  it("one decimal: 0.25 -> 0.3 (half up) / 0.2 (half even) / 0.2 (floor) / 0.3 (ceil); the scale is the rule's", async () => {
    expect(await marksFor('half_up', 1, 1, 4, 1)).toBe('0.3');
    expect(await marksFor('half_even', 1, 1, 4, 1)).toBe('0.2');
    expect(await marksFor('floor', 1, 1, 4, 1)).toBe('0.2');
    expect(await marksFor('ceil', 1, 1, 4, 1)).toBe('0.3');
    expect(await marksFor('half_up', 2, 1, 3, 1)).toBe('0.33'); // 0.3333 never decided early
  });

  it('thirds add up exactly: 1/3 + 1/3 + 1/3 is 1, never 0.9999 (no early division)', async () => {
    await resetGradebook(owner, A.tenantId, cls.offeringId);
    const g = await configureDb(owner, A.tenantId, cls.offeringId, {
      weighted: true,
      outOf: 1,
      roundMode: 'half_up',
      roundDecimals: 0,
      categories: [
        { name: 'A', weight: 1 },
        { name: 'B', weight: 1 },
        { name: 'C', weight: 1 },
      ],
      manual: ['A', 'B', 'C'].map((c) => ({
        title: `i${c}`,
        points: 3,
        category: c,
        released: true,
      })),
      scale: SCALE,
    });
    for (const k of ['iA', 'iB', 'iC']) await mark(g.itemIds[k]!, 0, 1); // each category 1/3
    // the true value is exactly 1/3 of 1 = 0.333 -> 0 ; with out of 3 it would be exactly 1
    await owner.query('UPDATE lms.gradebooks SET out_of = 3 WHERE id = $1', [g.gradebookId]);
    expect((await final()).final_marks).toBe('1');
  });

  it('the grade band is decided on the ROUNDED final (79.5 % of 40 rounds to 32 = 80 %)', async () => {
    await resetGradebook(owner, A.tenantId, cls.offeringId);
    const g = await configureDb(owner, A.tenantId, cls.offeringId, {
      weighted: false,
      outOf: 40,
      roundMode: 'half_up',
      roundDecimals: 0,
      categories: [{ name: 'W', weight: 0 }],
      manual: [{ title: 'X', points: 200, category: 'W', released: true }],
      scale: SCALE,
    });
    await mark(g.itemIds.X!, 0, 159); // 79.5 % -> 31.8 marks -> 32 -> 80 % -> A
    const r = await final();
    expect(r.final_marks).toBe('32');
    expect(r.grade).toBe('A');
    await mark(g.itemIds.X!, 0, 157); // 78.5 % -> 31.4 -> 31 -> 77.5 % -> B+
    expect((await final()).grade).toBe('B+');
  });
});

describe('overrides and explanations', () => {
  it('an item override replaces the mark and counts even when nothing was entered; a final override replaces the final', async () => {
    await resetGradebook(owner, A.tenantId, cls.offeringId);
    const g = await configureDb(owner, A.tenantId, cls.offeringId, {
      weighted: true,
      outOf: 100,
      categories: [{ name: 'W', weight: 100 }],
      manual: [
        { title: 'X', points: 10, category: 'W', released: true },
        { title: 'Y', points: 10, category: 'W', released: true },
      ],
      scale: SCALE,
    });
    await mark(g.itemIds.X!, 0, 4);
    expect((await final()).final_marks).toBe('40');
    await setOverrideDb(owner, A.tenantId, g.gradebookId, pids[0]!, g.itemIds.Y!, 10);
    const r = await final();
    expect(r.final_marks).toBe('70'); // (4 + 10) / 20
    expect(r.cells[g.itemIds.Y!]![0]).toBe('o');
    await setOverrideDb(owner, A.tenantId, g.gradebookId, pids[0]!, null, 91.5);
    const f = await final();
    expect(f.final_marks).toBe('91.50');
    expect(f.overridden).toBe(true);
    expect(f.grade).toBe('A+');
    expect(f.explanation.overridden).toBe(true);
    // the learner is not shown the final override (it takes effect when the gradebook is approved)
    expect((await final(0, 'learner')).final_marks).toBe('70');
  });

  it('every final number has an explanation: categories, items, what was dropped, the weights and the rounding', async () => {
    await resetGradebook(owner, A.tenantId, cls.offeringId);
    const g = await configureDb(owner, A.tenantId, cls.offeringId, {
      weighted: true,
      outOf: 50,
      roundMode: 'half_even',
      roundDecimals: 1,
      categories: [
        { name: 'Tests', weight: 60, dropLowest: 1 },
        { name: 'Labs', weight: 40, missing: 'zero_after_due' },
      ],
      manual: [
        { title: 'T1', points: 10, category: 'Tests', released: true },
        { title: 'T2', points: 10, category: 'Tests', released: true },
        { title: 'L1', points: 10, category: 'Labs', released: true },
      ],
      scale: SCALE,
    });
    await mark(g.itemIds.T1!, 0, 3);
    await mark(g.itemIds.T2!, 0, 9);
    const r = await final();
    const x = r.explanation;
    expect(x).toMatchObject({
      weighted: true,
      outOf: 50,
      rounding: { mode: 'half_even', decimals: 1 },
      weightTotal: 100,
    });
    const tests = x.categories[0];
    expect(tests).toMatchObject({
      name: 'Tests',
      weight: 60,
      dropLowest: 1,
      earned: 9,
      max: 10,
      percent: 90,
    });
    expect(
      tests.items.map((i: { title: string; state: string; dropped: boolean }) => [
        i.title,
        i.state,
        i.dropped,
      ]),
    ).toEqual([
      ['T1', 's', true],
      ['T2', 's', false],
    ]);
    // Labs: L1 has no mark and no due date and is released: counts as zero -> 0 %
    expect(x.categories[1]).toMatchObject({ name: 'Labs', earned: 0, max: 10, percent: 0 });
    // 0.6 * 90 + 0.4 * 0 = 54 % of 50 = 27.0
    expect(x.unrounded).toBe(27);
    expect(x.final).toBe(27);
    expect(r.final_marks).toBe('27.0');
  });

  it('the grid has no explanation (cheap), the per-learner call does', async () => {
    const r = (await compute(owner, A.tenantId, cls.offeringId, 'staff', [pids[0]!], false))[0]!;
    expect(r.explanation).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------- property tests
const cents = (max: number) => fc.integer({ min: 1, max });
const arbCase = fc
  .record({
    weighted: fc.boolean(),
    outOf: fc.integer({ min: 100, max: 50_000 }),
    mode: fc.constantFrom<RoundMode>('half_up', 'half_even', 'floor', 'ceil'),
    decimals: fc.integer({ min: 0, max: 2 }),
    cats: fc.array(
      fc.record({
        weightMilli: fc.integer({ min: 0, max: 100_000 }),
        drop: fc.integer({ min: 0, max: 3 }),
        policy: fc.constantFrom('exclude' as const, 'zero_after_due' as const),
      }),
      { minLength: 1, maxLength: 4 },
    ),
    items: fc.array(
      fc.record({
        catPick: fc.nat(),
        points: cents(5000),
        extra: fc.boolean(),
        released: fc.boolean(),
        due: fc.constantFrom('past' as const, 'future' as const, null),
        marks: fc.array(fc.option(fc.integer({ min: 0, max: 1000 }), { nil: null, freq: 3 }), {
          minLength: 3,
          maxLength: 3,
        }),
        overrides: fc.array(fc.option(fc.integer({ min: 0, max: 1000 }), { nil: null, freq: 12 }), {
          minLength: 3,
          maxLength: 3,
        }),
      }),
      { minLength: 1, maxLength: 9 },
    ),
    finalOverride: fc.array(fc.option(fc.integer({ min: 0, max: 1000 }), { nil: null, freq: 12 }), {
      minLength: 3,
      maxLength: 3,
    }),
  })
  .map((r): RefCase => {
    const items = r.items.map((i) => ({
      cat: i.catPick % r.cats.length,
      points: i.points,
      extra: i.extra,
      released: i.released,
      due: i.due,
      marks: i.marks.map((m) => (m === null ? null : Math.floor((i.points * m) / 1000))),
      overrides: i.overrides.map((m) => (m === null ? null : Math.floor((i.points * m) / 1000))),
    }));
    return {
      weighted: r.weighted,
      outOf: r.outOf,
      mode: r.mode,
      decimals: r.decimals,
      cats: r.cats,
      items,
      finalOverride: r.finalOverride.map((m) =>
        m === null ? null : Math.floor((r.outOf * m) / 1000),
      ),
    };
  });

describe('property: the SQL function agrees EXACTLY with the reference implementation', () => {
  it('random weights, drops, missing policies, extra credit, overrides and rounding (staff and learner views)', async () => {
    await fc.assert(
      fc.asyncProperty(arbCase, async (c) => {
        await resetGradebook(owner, A.tenantId, cls.offeringId);
        const cfg = await configureDb(owner, A.tenantId, cls.offeringId, {
          weighted: c.weighted,
          outOf: c.outOf / 100,
          roundMode: c.mode,
          roundDecimals: c.decimals,
          categories: c.cats.map((k, i) => ({
            name: `C${i}`,
            weight: k.weightMilli / 1000,
            dropLowest: k.drop,
            missing: k.policy,
          })),
          manual: c.items.map((it, i) => ({
            title: `I${i}`,
            points: it.points / 100,
            category: `C${it.cat}`,
            extra: it.extra,
            released: it.released,
            dueAt:
              it.due === 'past'
                ? '2020-01-01T00:00:00Z'
                : it.due === 'future'
                  ? '2999-01-01T00:00:00Z'
                  : null,
          })),
          scale: [{ min: 0, label: 'X' }],
        });
        for (const [i, it] of c.items.entries()) {
          for (let l = 0; l < 3; l++) {
            const m = it.marks[l];
            if (m !== null && m !== undefined)
              await mark(cfg.itemIds[`I${i}`]!, l, (m / 100).toFixed(2));
            const o = it.overrides[l];
            if (o !== null && o !== undefined)
              await setOverrideDb(
                owner,
                A.tenantId,
                cfg.gradebookId,
                pids[l]!,
                cfg.itemIds[`I${i}`]!,
                (o / 100).toFixed(2),
              );
          }
        }
        for (let l = 0; l < 3; l++) {
          const f = c.finalOverride[l];
          if (f !== null && f !== undefined)
            await setOverrideDb(
              owner,
              A.tenantId,
              cfg.gradebookId,
              pids[l]!,
              null,
              (f / 100).toFixed(2),
            );
        }
        for (const mode of ['staff', 'learner'] as const) {
          const rows = await compute(owner, A.tenantId, cls.offeringId, mode, pids);
          for (let l = 0; l < 3; l++) {
            const row = rows.find((r) => r.participant_id === pids[l])!;
            const want = reference(c, l, mode === 'learner');
            const got = row.final_marks === null ? null : parseDecimal(row.final_marks);
            const same = want === null || got === null ? want === got : eq(want, got);
            if (!same)
              throw new Error(
                `${mode} learner ${l}: database ${row.final_marks} vs reference ${show(want)}\n${JSON.stringify(c)}`,
              );
          }
        }
      }),
      { numRuns: 60, interruptAfterTimeLimit: 100_000 },
    );
  }, 120_000);

  it('the reference itself rounds ties as specified', () => {
    expect(roundQ(q(1, 2), 'half_up', 0)).toEqual(q(1));
    expect(roundQ(q(1, 2), 'half_even', 0)).toEqual(q(0));
    expect(roundQ(q(5, 2), 'half_even', 0)).toEqual(q(2));
    expect(roundQ(q(7, 2), 'half_even', 0)).toEqual(q(4));
    expect(roundQ(q(1, 3), 'ceil', 1)).toEqual(q(4, 10));
  });
});

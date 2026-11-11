// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { addQuestion, type Exam, exam, optionId, q } from './assessments-helpers';
import type { TestClient } from './client';
import {
  errorCode,
  type Json,
  loginAs,
  newCourse,
  ok,
  type Structure,
  structure,
} from './courses-helpers';
import { csv } from './imports-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Step 9a: the question bank. Types and their keys, versions (an edit never changes what was shown), random option ids,
// who may read / manage, tags, and the CSV import (dry run with per-row errors, formula safety, confirm).

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let st: Structure;
let e: Exam;
let c: TestClient;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'qb-a');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
  e = await exam(owner, t, A, admin, st, 1);
  c = e.instructor.client;
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const base = () => `/courses/${e.courseId}/questions`;

describe('creating and reading questions', () => {
  it('stores each type and gives the instructor the key back', async () => {
    const single = await addQuestion(
      c,
      e.courseId,
      q.single('Capital of France?', ['Paris', 'Rome', 'Oslo'], 0, { tags: ['Geo', ' europe '] }),
    );
    expect(single.type).toBe('single_choice');
    expect(single.options.filter((o: Json) => o.correct)).toHaveLength(1);
    expect(single.tags).toEqual(['europe', 'geo']);
    expect(single.version).toBe(1);

    const multi = await addQuestion(
      c,
      e.courseId,
      q.multi('Primes?', ['2', '4', '7'], [0, 2], { partialCredit: true }),
    );
    expect(multi.partialCredit).toBe(true);
    expect(multi.options.filter((o: Json) => o.correct)).toHaveLength(2);

    const tf = await addQuestion(c, e.courseId, q.tf('Water is wet', true));
    expect(tf.trueIsCorrect).toBe(true);
    const tfFalse = await addQuestion(c, e.courseId, q.tf('The sun is cold', false));
    expect(tfFalse.trueIsCorrect).toBe(false);

    const num = await addQuestion(c, e.courseId, q.numeric('Pi to 2 places', 3.14, 0.01));
    expect(num.numeric).toEqual({ value: 3.14, tolerance: 0.01, mode: 'absolute' });

    const short = await addQuestion(
      c,
      e.courseId,
      q.short('Chemical symbol of gold', ['Au', ' au ']),
    );
    expect(short.shortAnswer).toEqual({ mode: 'auto', accepted: ['Au', 'au'] });

    const essay = await addQuestion(
      c,
      e.courseId,
      q.essay('Discuss', {
        maxWords: 300,
        explanation: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'rubric' }] }],
        },
      }),
    );
    expect(essay.maxWords).toBe(300);
    expect(essay.explanation).not.toBeNull();
  });

  it('refuses invalid questions with the field that is wrong', async () => {
    const bad = async (input: Json) => {
      const r = await c.post(base(), input);
      expect(r.statusCode, r.body).toBe(400);
      expect(errorCode(r)).toBe('invalid_question');
    };
    await bad(
      q.single('x', ['a', 'b'], 0, {
        options: [
          {
            text: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'only' }] }],
            },
            correct: true,
          },
        ],
      }),
    );
    await bad(
      q.single('two right', ['a', 'b'], 0, { options: q.multi('x', ['a', 'b'], [0, 1]).options }),
    );
    await bad(q.multi('none right', ['a', 'b'], []));
    await bad({ type: 'true_false', stem: q.essay('s').stem });
    await bad({ type: 'numeric', stem: q.essay('s').stem });
    await bad(q.short('no answers', []));
    await bad(q.single('bad tag', ['a', 'b'], 0, { tags: ['has#hash'] }));
    await bad(
      q.single('unknown option id', ['a', 'b'], 0, {
        options: [
          { id: 'abcdef123456', text: q.essay('x').stem, correct: true },
          { text: q.essay('y').stem, correct: false },
        ],
      }),
    );
  });

  it('lists with filters, keyset paging and a tag count', async () => {
    const course = await newCourse(admin);
    ok(await admin.post(`/offerings`, { courseId: course.id, termId: st.termId }));
    // an instructor of another course sees nothing of this one
    const other = await c.get(`/courses/${course.id}/questions`);
    expect(other.statusCode).toBe(404);

    for (let i = 0; i < 5; i++)
      await addQuestion(
        c,
        e.courseId,
        q.single(`List ${i}`, ['a', 'b'], 0, {
          difficulty: i % 2 ? 'hard' : 'easy',
          tags: ['lister'],
        }),
      );
    const page1 = ok(await c.get(base(), { query: 'tag=lister&limit=2' }));
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = ok(
      await c.get(base(), { query: `tag=lister&limit=10&after=${page1.nextCursor}` }),
    );
    expect(page2.items).toHaveLength(3);
    const hard = ok(await c.get(base(), { query: 'tag=lister&difficulty=hard' }));
    expect(hard.items.every((x: Json) => x.difficulty === 'hard')).toBe(true);
    const tags = ok(await c.get(`/courses/${e.courseId}/question-tags`));
    expect(tags.items.find((x: Json) => x.tag === 'lister').count).toBe(5);
  });
});

describe('versions', () => {
  it('an edit adds a version; kept options keep their ids, new options get new ones, old versions stay readable', async () => {
    const v1 = await addQuestion(
      c,
      e.courseId,
      q.single('Largest planet?', ['Earth', 'Jupiter'], 1),
    );
    const jupiter = optionId(v1, 'Jupiter');
    const earth = optionId(v1, 'Earth');
    const edit = q.single('Largest planet in the solar system?', ['Earth', 'Jupiter', 'Saturn'], 1);
    edit.options[0].id = earth;
    edit.options[1].id = jupiter;
    const v2 = ok(await c.put(`${base()}/${v1.id}`, edit));
    expect(v2.version).toBe(2);
    expect(v2.latestVersion).toBe(2);
    expect(v2.versionId).not.toBe(v1.versionId);
    expect(optionId(v2, 'Jupiter')).toBe(jupiter);
    expect(optionId(v2, 'Saturn')).not.toBe(jupiter);
    expect(v2.options.map((o: Json) => o.id)).toHaveLength(
      new Set(v2.options.map((o: Json) => o.id)).size,
    );

    const old = ok(await c.get(`${base()}/${v1.id}`, { query: 'version=1' }));
    expect(old.stem.content[0].content[0].text).toBe('Largest planet?');
    expect(old.options).toHaveLength(2);
    expect(old.latestVersion).toBe(2);
    expect((await c.get(`${base()}/${v1.id}`, { query: 'version=9' })).statusCode).toBe(404);
    const versions = ok(await c.get(`${base()}/${v1.id}/versions`));
    expect(versions.items.map((x: Json) => [x.version, x.current])).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  it('refuses an option id that never belonged to the question', async () => {
    const v1 = await addQuestion(c, e.courseId, q.single('Pick', ['a', 'b'], 0));
    const edit = q.single('Pick', ['a', 'b'], 0);
    edit.options[0].id = 'deadbeef0001';
    const r = await c.put(`${base()}/${v1.id}`, edit);
    expect(r.statusCode).toBe(400);
  });

  it('archives and unarchives; archived questions leave the default list', async () => {
    const v1 = await addQuestion(
      c,
      e.courseId,
      q.single('To archive', ['a', 'b'], 0, { tags: ['arch'] }),
    );
    ok(await c.post(`${base()}/${v1.id}/archive`));
    expect(ok(await c.get(base(), { query: 'tag=arch' })).items).toHaveLength(0);
    expect(ok(await c.get(base(), { query: 'tag=arch&status=archived' })).items).toHaveLength(1);
    ok(await c.post(`${base()}/${v1.id}/unarchive`));
    expect(ok(await c.get(base(), { query: 'tag=arch' })).items).toHaveLength(1);
  });
});

describe('option ids', () => {
  it('are random: they do not follow the authoring order, the position or each other', async () => {
    const ids: string[][] = [];
    for (let i = 0; i < 40; i++) {
      const made = await addQuestion(
        c,
        e.courseId,
        q.multi(`Order ${i}`, ['w', 'x', 'y', 'z'], [0]),
      );
      ids.push(made.options.map((o: Json) => o.id));
    }
    const all = ids.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((id) => /^[0-9a-f]{12}$/.test(id))).toBe(true);
    // authoring order = ascending id would be true for every question if ids were derived from the order (chance of
    // 4 random ids ascending is 1 in 24: far below half of 40)
    const ascending = ids.filter((l) => [...l].sort().join() === l.join()).length;
    expect(ascending).toBeLessThan(20);
    // and the ids of the first option do not share a prefix pattern (no counter)
    expect(new Set(ids.map((l) => (l[0] as string).slice(0, 4))).size).toBeGreaterThan(30);
  });
});

describe('who may do what', () => {
  it('assistants and administrators read; only instructors manage; strangers get 404', async () => {
    const made = await addQuestion(c, e.courseId, q.single('Who?', ['a', 'b'], 0));
    for (const reader of [e.assistant.client, admin]) {
      expect((await reader.get(`${base()}/${made.id}`)).statusCode).toBe(200);
      expect((await reader.post(base(), q.single('no', ['a', 'b'], 0))).statusCode).toBe(403);
      expect(
        (await reader.put(`${base()}/${made.id}`, q.single('no', ['a', 'b'], 0))).statusCode,
      ).toBe(403);
    }
    // a learner of the offering is not an instructor or an assistant: the course is not visible to them
    const learner = e.learners[0]!.client;
    expect((await learner.get(`${base()}/${made.id}`)).statusCode).toBe(404);
    expect((await learner.post(base(), q.single('no', ['a', 'b'], 0))).statusCode).toBe(404);
  });
});

/** POST a CSV to the import endpoint as a browser would (multipart). */
function uploadCsv(client: TestClient, courseId: string, content: string, name = 'questions.csv') {
  const boundary = `----qb${Math.random().toString(16).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/csv\r\n\r\n`,
    ),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return client.request('POST', `/courses/${courseId}/question-imports`, {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
}
const HEAD =
  'type,question,option_a,option_b,option_c,option_d,correct,difficulty,tags,partial_credit,explanation';

describe('CSV import', () => {
  it('serves a template, stages rows with per-row errors, and creates questions on confirm', async () => {
    const tpl = await c.get(`/courses/${e.courseId}/question-imports/template.csv`);
    expect(tpl.statusCode).toBe(200);
    expect(tpl.headers['content-type']).toContain('text/csv');
    expect(tpl.body.split('\n')[0]).toContain('option_a');

    const file = csv(HEAD, [
      ['single_choice', 'Import one?', 'yes', 'no', '', '', 'A', 'easy', 'imp;csv', '', 'because'],
      ['multiple_choice', 'Import two?', 'a', 'b', 'c', '', 'A;C', 'hard', 'imp', 'yes', ''],
      ['true_false', 'Import three', '', '', '', '', 'false', '', '', '', ''],
      ['single_choice', '=HYPERLINK("x")', 'a', 'b', '', '', 'A', '', '', '', ''],
      ['single_choice', 'Bad letter', 'a', 'b', '', '', 'D', '', '', '', ''],
      ['essay', 'Not allowed', '', '', '', '', 'A', '', '', '', ''],
      ['single_choice', 'Two right', 'a', 'b', '', '', 'A;B', '', '', '', ''],
    ]);
    const imp = ok(await uploadCsv(c, e.courseId, file));
    expect(imp).toMatchObject({ status: 'staged', totalRows: 7, validRows: 3, invalidRows: 4 });

    const rows = ok(
      await c.get(`/courses/${e.courseId}/question-imports/${imp.id}/rows`, {
        query: 'status=invalid',
      }),
    );
    expect(rows.items.map((r: Json) => r.rowNo)).toEqual([4, 5, 6, 7]);
    expect(rows.items[0].errors[0].message).toMatch(/formula/);
    expect(rows.items[1].errors[0].column).toBe('correct');

    // nothing exists yet
    expect(ok(await c.get(base(), { query: 'tag=imp' })).items).toHaveLength(0);
    // invalid rows block a plain confirm
    const blocked = await c.post(`/courses/${e.courseId}/question-imports/${imp.id}/confirm`, {});
    expect(blocked.statusCode).toBe(409);
    expect(errorCode(blocked)).toBe('invalid_rows');

    const done = ok(
      await c.post(`/courses/${e.courseId}/question-imports/${imp.id}/confirm`, {
        skipInvalid: true,
      }),
    );
    expect(done).toMatchObject({ status: 'applied', createdCount: 3 });
    const made = ok(await c.get(base(), { query: 'tag=imp&limit=50' }));
    expect(made.items).toHaveLength(2);
    const multi = made.items.find((x: Json) => x.type === 'multiple_choice');
    expect(multi.partialCredit).toBe(true);
    expect(multi.options.filter((o: Json) => o.correct)).toHaveLength(2);
    const tf = ok(await c.get(base(), { query: 'type=true_false&limit=100' })).items.find(
      (x: Json) => x.stem.content[0].content[0].text === 'Import three',
    );
    expect(tf.trueIsCorrect).toBe(false);
    // staging rows are gone, and a second confirm is refused
    const rowsLeft = await owner.query(
      'SELECT count(*)::int AS n FROM lms.question_import_rows WHERE import_id = $1',
      [imp.id],
    );
    expect(rowsLeft.rows[0].n).toBe(0);
    expect(
      (
        await c.post(`/courses/${e.courseId}/question-imports/${imp.id}/confirm`, {
          skipInvalid: true,
        })
      ).statusCode,
    ).toBe(409);
  });

  it('refuses unknown columns, other file types, too many rows, and lets a staged import be cancelled', async () => {
    const unknown = await uploadCsv(
      c,
      e.courseId,
      'type,question,correct,secret\r\nsingle_choice,x,A,y\r\n',
    );
    expect(unknown.statusCode).toBe(400);
    expect(errorCode(unknown)).toBe('invalid_header');
    expect((await uploadCsv(c, e.courseId, 'x', 'notes.txt')).statusCode).toBe(400);
    // a quote in the middle of an unquoted cell is not valid CSV: a clear 400, not a server error
    const broken = await uploadCsv(
      c,
      e.courseId,
      'type,question,option_a,option_b,correct\r\nsingle_choice,say "hi",a,b,A\r\n',
    );
    expect(broken.statusCode).toBe(400);
    expect(errorCode(broken)).toBe('invalid_csv');
    const many = csv(
      HEAD,
      Array.from({ length: 1001 }, (_, i) => [
        'true_false',
        `Row ${i}`,
        '',
        '',
        '',
        '',
        'true',
        '',
        '',
        '',
        '',
      ]),
    );
    const big = await uploadCsv(c, e.courseId, many);
    expect(big.statusCode).toBe(413);
    expect(errorCode(big)).toBe('too_many_rows');

    const imp = ok(
      await uploadCsv(
        c,
        e.courseId,
        csv(HEAD, [['true_false', 'Cancel me', '', '', '', '', 'true', '', '', '', '']]),
      ),
    );
    const cancelled = ok(await c.post(`/courses/${e.courseId}/question-imports/${imp.id}/cancel`));
    expect(cancelled.status).toBe('cancelled');
    expect(
      (await c.post(`/courses/${e.courseId}/question-imports/${imp.id}/confirm`, {})).statusCode,
    ).toBe(409);
  });

  it('is for instructors only', async () => {
    const r = await uploadCsv(
      e.assistant.client,
      e.courseId,
      csv(HEAD, [['true_false', 'x', '', '', '', '', 'true', '', '', '', '']]),
    );
    expect(r.statusCode).toBe(403);
  });
});

describe('scoring (the database function behind every submit and regrade)', () => {
  const score = async (type: string, key: Json, answer: Json | null, points = 10) => {
    const r = await owner.query('SELECT (lms.score_answer($1, $2::jsonb, $3::jsonb, $4)).* AS s', [
      type,
      JSON.stringify(key),
      answer === null ? null : JSON.stringify(answer),
      points,
    ]);
    return { score: Number(r.rows[0].score), manual: r.rows[0].manual as boolean };
  };

  it('single choice and true / false: all or nothing', async () => {
    expect(await score('single_choice', { correct: ['a'] }, { o: ['a'] })).toEqual({
      score: 10,
      manual: false,
    });
    expect(await score('single_choice', { correct: ['a'] }, { o: ['b'] })).toEqual({
      score: 0,
      manual: false,
    });
    expect(await score('single_choice', { correct: ['a'] }, { o: ['a', 'b'] })).toEqual({
      score: 0,
      manual: false,
    });
    expect(await score('true_false', { correct: ['t'] }, { o: ['t'] })).toEqual({
      score: 10,
      manual: false,
    });
    expect(await score('single_choice', { correct: ['a'] }, null)).toEqual({
      score: 0,
      manual: false,
    });
    expect(await score('single_choice', { correct: ['a'] }, { o: [] })).toEqual({
      score: 0,
      manual: false,
    });
  });

  it('multiple choice: exact set, or partial credit (right minus wrong, never below zero)', async () => {
    const strict = { correct: ['a', 'b', 'c', 'd'] };
    expect((await score('multiple_choice', strict, { o: ['a', 'b', 'c', 'd'] })).score).toBe(10);
    expect((await score('multiple_choice', strict, { o: ['a', 'b', 'c'] })).score).toBe(0);
    const partial = { correct: ['a', 'b', 'c', 'd'], partial: true };
    expect((await score('multiple_choice', partial, { o: ['a', 'b'] })).score).toBe(5);
    expect((await score('multiple_choice', partial, { o: ['a', 'b', 'x'] })).score).toBe(2.5);
    expect((await score('multiple_choice', partial, { o: ['x', 'y'] })).score).toBe(0);
    expect((await score('multiple_choice', partial, { o: ['a', 'x', 'y'] })).score).toBe(0);
    expect((await score('multiple_choice', partial, { o: ['a', 'b', 'c', 'd'] })).score).toBe(10);
    expect((await score('multiple_choice', partial, { o: ['a', 'b', 'c', 'd', 'x'] })).score).toBe(
      7.5,
    );
  });

  it('numeric: absolute and percent tolerance, and garbage', async () => {
    expect(
      (await score('numeric', { value: 3.14, tolerance: 0.01, mode: 'absolute' }, { n: 3.15 }))
        .score,
    ).toBe(10);
    expect(
      (await score('numeric', { value: 3.14, tolerance: 0.01, mode: 'absolute' }, { n: 3.16 }))
        .score,
    ).toBe(0);
    expect(
      (await score('numeric', { value: 100, tolerance: 5, mode: 'percent' }, { n: 95 })).score,
    ).toBe(10);
    expect(
      (await score('numeric', { value: 100, tolerance: 5, mode: 'percent' }, { n: 94.9 })).score,
    ).toBe(0);
    expect(
      (await score('numeric', { value: -50, tolerance: 10, mode: 'percent' }, { n: -45 })).score,
    ).toBe(10);
    expect((await score('numeric', { value: 7, tolerance: 0 }, { n: 7 })).score).toBe(10);
    expect((await score('numeric', { value: 7 }, { n: 'seven' })).score).toBe(0);
    expect((await score('numeric', { value: 7 }, { t: 'x' })).score).toBe(0);
  });

  it('short answer: normalised exact match (case, spaces, unicode), or manual', async () => {
    const key = { mode: 'auto', accepted: ['Au', 'Gold'] };
    expect((await score('short_answer', key, { t: '  au ' })).score).toBe(10);
    expect((await score('short_answer', key, { t: 'GOLD' })).score).toBe(10);
    expect((await score('short_answer', key, { t: 'g  old' })).score).toBe(0);
    expect(
      (await score('short_answer', { mode: 'auto', accepted: ['café'] }, { t: 'CAFÉ' })).score,
    ).toBe(10);
    expect(
      (await score('short_answer', { mode: 'auto', accepted: ['ﬁsh'] }, { t: 'fish' })).score,
    ).toBe(10); // NFKC ligature
    expect(await score('short_answer', { mode: 'manual' }, { t: 'something' })).toEqual({
      score: 0,
      manual: true,
    });
    expect(await score('short_answer', { mode: 'manual' }, { t: '  ' })).toEqual({
      score: 0,
      manual: false,
    });
  });

  it('essay: waits for a person, unless it is empty', async () => {
    expect(await score('essay', {}, { t: 'An answer' })).toEqual({ score: 0, manual: true });
    expect(await score('essay', {}, { t: '   ' })).toEqual({ score: 0, manual: false });
    expect(await score('essay', {}, null)).toEqual({ score: 0, manual: false });
  });
});

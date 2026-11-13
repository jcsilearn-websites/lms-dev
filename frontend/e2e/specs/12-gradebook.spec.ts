import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import { apiAs, createMember, expectAccessible, originOf, signIn } from '../support';

// The gradebook end to end, on the real API, worker and database:
//  - the instructor configures categories, weights, items and the scale in the UI;
//  - enters manual marks by PASTING from a spreadsheet;
//  - the gradebook pulls the released quiz and assignment scores (and nothing unreleased);
//  - the learner sees a PROVISIONAL total; the instructor submits; an admin returns it with a comment, then approves it;
//  - after the lock a score changes (an assignment re-grade): the locked snapshot, its export and the learner's record stay;
//  - CSV and Excel exports download; the learner sees the FINAL grade with its explanation;
//  - every new screen passes axe (light, dark and a 360 px phone).

const COLLEGE = 'e2e-one';
const COURSE = 'E2G101';
const GINA = 'gina.gradebook@e2e-one.test';
const RAVI = 'ravi.rao@e2e-one.test';
const SITA = 'sita.sen@e2e-one.test';
const TARA = 'tara.thomas@e2e-one.test';

let courseId = '';
let offeringId = '';
let moduleId = '';
let quizId = '';
let essayId = '';

test.describe.configure({ mode: 'serial' });

const url = (path: string) => `${originOf(COLLEGE)}${path}`;
const gb = () => url(`/offerings/${offeringId}/gradebook`);
const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

async function asUser(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await signIn(page, COLLEGE, email);
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  return page;
}
async function accessibleEverywhere(page: Page, label: string) {
  await expectAccessible(page, `${label} (light)`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page, `${label} (dark)`);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 360, height: 740 });
  await expectAccessible(page, `${label} (360 px)`);
  await page.setViewportSize({ width: 1280, height: 720 });
}
/** What Excel puts on the clipboard, delivered as a paste event to the grid. */
async function pasteIntoGrid(page: Page, text: string) {
  await page.getByRole('grid', { name: 'Gradebook' }).evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, text);
}
const ok = async (res: Awaited<ReturnType<APIRequestContext['post']>>) => {
  if (!res.ok() && res.status() !== 409)
    throw new Error(`setup call failed: ${res.status()} ${await res.text()}`);
  return res;
};

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const admin = await apiAs(COLLEGE, `admin@${COLLEGE}.test`);
  await ok(
    await admin.post('academic-years', {
      data: { label: 'E2E 2026', startDate: '2026-06-01', endDate: '2027-05-31' },
    }),
  );
  const year = (
    (await (await admin.get('academic-years?limit=100')).json()) as {
      items: { id: string; label: string }[];
    }
  ).items.find((y) => y.label === 'E2E 2026');
  await ok(
    await admin.post('terms', {
      data: {
        academicYearId: year?.id,
        name: 'E2E Semester 1',
        startDate: '2026-06-01',
        endDate: '2026-11-30',
      },
    }),
  );
  const t1 = (
    (await (await admin.get('terms?limit=100')).json()) as { items: { id: string; name: string }[] }
  ).items.find((x) => x.name === 'E2E Semester 1')?.id;
  const gina = await createMember(COLLEGE, GINA, 'Gina Gradebook');
  const learners = [
    await createMember(COLLEGE, RAVI, 'Ravi Rao'),
    await createMember(COLLEGE, SITA, 'Sita Sen'),
    await createMember(COLLEGE, TARA, 'Tara Thomas'),
  ];
  await ok(await admin.post('courses', { data: { code: COURSE, title: 'Gradebook', credits: 3 } }));
  courseId = (
    (await (await admin.get(`courses?q=${COURSE}&limit=10`)).json()) as {
      items: { id: string; code: string }[];
    }
  ).items.find((c) => c.code === COURSE)?.id as string;
  await ok(await admin.post('offerings', { data: { courseId, termId: t1 } }));
  offeringId = (
    (await (await admin.get(`offerings?courseId=${courseId}&limit=10`)).json()) as {
      items: { id: string }[];
    }
  ).items[0]?.id as string;
  await ok(
    await admin.post(`offerings/${offeringId}/participants`, {
      data: { userId: gina, participation: 'instructor' },
    }),
  );
  for (const userId of learners)
    await ok(
      await admin.post(`offerings/${offeringId}/participants`, {
        data: { userId, participation: 'learner' },
      }),
    );
  // a grade scale of the college (the UI for scales has its own test below)
  await ok(
    await admin.post('grade-scales', {
      data: {
        name: 'E2E scale',
        bands: [
          { minPercent: 0, label: 'RA', isPass: false },
          { minPercent: 50, label: 'C', isPass: true },
          { minPercent: 70, label: 'B', isPass: true },
          { minPercent: 85, label: 'A', isPass: true },
        ],
      },
    }),
  );
  await admin.dispose();

  const g = await apiAs(COLLEGE, GINA);
  await ok(await g.post(`offerings/${offeringId}/publish`));
  moduleId = (
    (await (
      await ok(await g.post(`offerings/${offeringId}/modules`, { data: { title: 'Work' } }))
    ).json()) as { id: string }
  ).id;
  await ok(
    await g.patch(`offerings/${offeringId}/modules/${moduleId}`, { data: { published: true } }),
  );
  // a quiz with one auto-graded question (immediate results): Ravi right, Sita wrong, Tara does not take it
  const q = (await (
    await ok(
      await g.post(`courses/${courseId}/questions`, {
        data: {
          type: 'single_choice',
          stem: doc('Capital of France?'),
          options: [
            { text: doc('Paris'), correct: true },
            { text: doc('Rome'), correct: false },
          ],
        },
      }),
    )
  ).json()) as { id: string };
  const quiz = (await (
    await ok(
      await g.post(`offerings/${offeringId}/modules/${moduleId}/items`, {
        data: { kind: 'assessment', title: 'Quiz 1', published: true },
      }),
    )
  ).json()) as { id: string };
  quizId = quiz.id;
  await ok(
    await g.put(`offerings/${offeringId}/items/${quizId}/assessment/slots`, {
      data: { slots: [{ kind: 'fixed', questionId: q.id, points: 10 }] },
    }),
  );
  for (const [email, label] of [
    [RAVI, 'Paris'],
    [SITA, 'Rome'],
  ] as const) {
    const l = await apiAs(COLLEGE, email);
    const started = (await (
      await ok(await l.post(`offerings/${offeringId}/items/${quizId}/attempts`))
    ).json()) as { attemptId: string };
    const attempt = (await (
      await l.get(`offerings/${offeringId}/attempts/${started.attemptId}`)
    ).json()) as {
      questions: {
        position: number;
        options: { id: string; text: { content: { content: { text: string }[] }[] } }[];
      }[];
    };
    const first = attempt.questions[0];
    const option = first?.options.find((o) => o.text.content[0]?.content[0]?.text === label);
    await ok(
      await l.put(`offerings/${offeringId}/attempts/${started.attemptId}/answers`, {
        data: {
          answers: [{ position: first?.position, answer: { o: [option?.id] }, rev: 1, at: 1 }],
          events: [],
        },
      }),
    );
    await ok(await l.post(`offerings/${offeringId}/attempts/${started.attemptId}/submit`));
    await l.dispose();
  }
  // an assignment (text hand-in) graded 80 / 60 and released
  const essay = (await (
    await ok(
      await g.post(`offerings/${offeringId}/modules/${moduleId}/items`, {
        data: { kind: 'assignment', title: 'Essay', published: true },
      }),
    )
  ).json()) as { id: string };
  essayId = essay.id;
  await ok(
    await g.put(`offerings/${offeringId}/items/${essayId}/assignment`, {
      data: { allowText: true, allowFile: false, maxPoints: 100 },
    }),
  );
  for (const email of [RAVI, SITA]) {
    const l = await apiAs(COLLEGE, email);
    await ok(
      await l.post(`offerings/${offeringId}/items/${essayId}/assignment/submissions`, {
        data: { requestKey: randomUUID(), text: 'My essay', fileIds: [] },
      }),
    );
    await l.dispose();
  }
  await g.dispose();
  await regrade(RAVI, 80);
  await regrade(SITA, 60);
  const g2 = await apiAs(COLLEGE, GINA);
  await ok(
    await g2.post(`offerings/${offeringId}/items/${essayId}/assignment/release`, { data: {} }),
  );
  await g2.dispose();
});

/** Grades (or re-grades) one learner's essay as the instructor. */
async function regrade(email: string, score: number) {
  const g = await apiAs(COLLEGE, GINA);
  const base = `offerings/${offeringId}/items/${essayId}/assignment/grading`;
  const queue = (await (await g.get(`${base}/queue?limit=100`)).json()) as {
    items: { learnerKey: string; email: string }[];
  };
  const key = queue.items.find((x) => x.email === email)?.learnerKey;
  const detail = (await (await g.get(`${base}/learners/${key}`)).json()) as {
    submissions: { id: string }[];
  };
  await ok(
    await g.put(`${base}/learners/${key}/grade`, {
      data: { submissionId: detail.submissions[0]?.id, rawScore: score, feedback: doc('ok') },
    }),
  );
  await g.dispose();
}

test('the instructor configures categories, weights, items, the scale and the rounding in the UI', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await asUser(browser, GINA);
  await page.goto(gb());
  await expect(page.getByRole('heading', { name: 'Gradebook' })).toBeVisible();
  await page.getByRole('tab', { name: 'Settings' }).click();

  // general: weighted, out of 40, the scale
  const general = page
    .getByRole('region', { name: 'General' })
    .or(page.locator('section', { has: page.getByRole('heading', { name: 'General' }) }));
  await general.getByLabel(/Count categories by their weights/).check();
  await general.getByLabel('The final is out of (marks)').fill('40');
  await general.getByLabel('Grade scale').selectOption({ label: 'E2E scale' });
  await general.getByLabel('Rounding of the final').selectOption('half_up');
  await general.getByRole('button', { name: 'Save general settings' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();

  // categories: rename the default one, add two
  const cats = page.locator('section', { has: page.getByRole('heading', { name: 'Categories' }) });
  await cats.getByLabel('Name').first().fill('Internal tests');
  await cats.getByLabel('Weight').first().fill('50');
  await cats.getByRole('button', { name: 'Add a category' }).click();
  await cats.getByLabel('Name').nth(1).fill('Assignments');
  await cats.getByLabel('Weight').nth(1).fill('30');
  await cats.getByRole('button', { name: 'Add a category' }).click();
  await cats.getByLabel('Name').nth(2).fill('Quizzes');
  await cats.getByLabel('Weight').nth(2).fill('20');
  await expect(cats.getByText(/Weights add up to 100/)).toBeVisible();
  await cats.getByRole('button', { name: 'Save categories' }).click();
  await expect(page.getByText('Categories saved')).toBeVisible();

  // items: a manual column, the quiz and the assignment
  const items = page.locator('section', { has: page.getByRole('heading', { name: 'Items' }) });
  await items.getByRole('button', { name: 'Add a manual column' }).click();
  await items.getByLabel('Column name').fill('Internal 1');
  await items.getByLabel('Worth (points)').fill('50');
  await items.getByLabel('Learners can see these marks').check();
  await items.getByLabel('Category').first().selectOption({ label: 'Internal tests' });
  await items.getByLabel('Add a quiz or assignment').selectOption({ label: 'Quiz 1 (quiz)' });
  await items.getByRole('button', { name: 'Add', exact: true }).click();
  await items.getByLabel('Add a quiz or assignment').selectOption({ label: 'Essay (assignment)' });
  await items.getByRole('button', { name: 'Add', exact: true }).click();
  const category = items.getByLabel('Category');
  await category.nth(1).selectOption({ label: 'Quizzes' });
  await category.nth(2).selectOption({ label: 'Assignments' });
  await items.getByLabel('Worth (points)').nth(2).fill('100');
  await items.getByLabel('Worth (points)').nth(1).fill('10');
  await items.getByRole('button', { name: 'Save items' }).click();
  await expect(page.getByText('Items saved')).toBeVisible();

  await accessibleEverywhere(page, 'gradebook settings');
  await page.context().close();
});

test('manual marks are pasted from a spreadsheet; the released quiz and assignment scores are in the grid', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await asUser(browser, GINA);
  await page.goto(gb());
  await expect(page.getByRole('grid', { name: 'Gradebook' })).toBeVisible();
  // the quiz (Ravi right, Sita wrong) and the essay (80 / 60 of 100, worth 100) are pulled in
  await expect(page.getByRole('gridcell', { name: 'Ravi Rao, Quiz 1: 10' })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'Sita Sen, Quiz 1: 0' })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'Tara Thomas, Quiz 1: no mark' })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'Ravi Rao, Essay: 80' })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'Sita Sen, Essay: 60' })).toBeVisible();
  // paste three marks into "Internal 1" starting at Ravi's cell
  await page.getByRole('gridcell', { name: 'Ravi Rao, Internal 1: no mark' }).click();
  await pasteIntoGrid(page, '40\r\n35\r\n28\r\n');
  await expect(page.getByText('3 marks saved')).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'Ravi Rao, Internal 1: 40' })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'Tara Thomas, Internal 1: 28' })).toBeVisible();
  // a value that is not a mark is refused for that cell, with the reason
  await page.getByRole('gridcell', { name: 'Sita Sen, Internal 1: 35' }).click();
  await pasteIntoGrid(page, 'abc');
  await expect(page.getByRole('alert').filter({ hasText: /not applied/ })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'Sita Sen, Internal 1: 35' })).toBeVisible();
  // Ravi: 0.5 * 80 % + 0.3 * 80 % + 0.2 * 100 % = 84 % of 40 = 33.6 -> 34
  const ravi = page.getByRole('gridcell', { name: /^Ravi Rao, Final \/ 40: / });
  await expect(ravi).toContainText('34');
  // the explanation opens from the learner's name
  await page.getByRole('button', { name: /^Ravi Rao/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/Before rounding: 33.6/)).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Internal tests' })).toBeVisible();
  await accessibleEverywhere(page, 'the explanation');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await accessibleEverywhere(page, 'the gradebook grid');
  await page.context().close();
});

test('a learner sees a PROVISIONAL total, labelled as such, built from released items only', async ({
  browser,
}) => {
  const page = await asUser(browser, RAVI);
  await page.goto(url(`/offerings/${offeringId}/grades`));
  await expect(page.getByText(/use only the results released to you so far/)).toBeVisible();
  await expect(page.getByText('Running total')).toBeVisible();
  await expect(page.getByTestId('final-marks')).toContainText('34');
  await expect(page.getByTestId('final-grade')).toHaveCount(0);
  await expect(page.getByText('Provisional').first()).toBeVisible();
  await accessibleEverywhere(page, 'my grades (provisional)');
  await page.context().close();
});

test('the instructor submits; an admin returns it with a comment; it is corrected, submitted and approved', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const gina = await asUser(browser, GINA);
  await gina.goto(gb());
  await gina.getByRole('button', { name: 'Submit for approval' }).click();
  await gina.getByRole('dialog').getByRole('button', { name: 'Submit for approval' }).click();
  await expect(gina.getByText('Submitted for approval')).toBeVisible();
  await expect(gina.getByText('Waiting for approval').first()).toBeVisible();
  // nothing can change now
  await gina.getByRole('gridcell', { name: 'Ravi Rao, Internal 1: 40' }).click();
  await pasteIntoGrid(gina, '41');
  await expect(gina.getByRole('alert').filter({ hasText: /locked/ })).toBeVisible();

  const admin = await asUser(browser, 'admin@e2e-one.test').catch(async () => {
    const page = await (await browser.newContext()).newPage();
    await signIn(page, COLLEGE, 'admin@e2e-one.test');
    await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
    return page;
  });
  await admin.goto(url('/gradebooks'));
  await expect(admin.getByRole('heading', { name: 'Gradebook approvals' })).toBeVisible();
  await accessibleEverywhere(admin, 'the approval queue');
  await admin.getByRole('link', { name: new RegExp(COURSE) }).click();
  await expect(admin.getByText('Nothing stops this gradebook from being approved.')).toBeVisible();
  await expect(
    admin.getByRole('heading', { name: /Learners who will NOT be in the snapshot/ }),
  ).toBeVisible();
  await admin.getByRole('button', { name: 'Return with a comment' }).click();
  await admin
    .getByRole('dialog')
    .getByLabel(/What has to change/)
    .fill('Please re-check the quiz marks of Tara');
  await admin.getByRole('dialog').getByRole('button', { name: 'Return' }).click();
  await expect(
    admin.getByRole('paragraph').filter({ hasText: 'Returned to the instructor' }),
  ).toBeVisible();

  // the instructor sees the comment, corrects a mark and submits again
  await gina.reload();
  await expect(
    gina.getByRole('status').filter({ hasText: 'Please re-check the quiz marks of Tara' }),
  ).toBeVisible();
  await gina.getByRole('gridcell', { name: 'Tara Thomas, Internal 1: 28' }).click();
  await pasteIntoGrid(gina, '30');
  await expect(gina.getByRole('gridcell', { name: 'Tara Thomas, Internal 1: 30' })).toBeVisible();
  await gina.getByRole('button', { name: 'Submit for approval' }).click();
  await gina.getByRole('dialog').getByRole('button', { name: 'Submit for approval' }).click();
  await expect(gina.getByText('Submitted for approval')).toBeVisible();

  await admin.reload();
  await admin.getByRole('button', { name: 'Approve and lock' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Approve and lock' }).click();
  await expect(admin.getByText('Approved: the gradebook is locked')).toBeVisible();
  await expect(admin.getByText('Approved and locked').first()).toBeVisible();
  await admin.context().close();
  await gina.context().close();
});

test('after the lock a score changes: the snapshot, its export and the learner record stay as approved', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const admin = await apiAs(COLLEGE, `admin@${COLLEGE}.test`);
  const csv = async () =>
    (await admin.get(`offerings/${offeringId}/gradebook/export.csv?version=1`)).text();
  const before = await csv();
  expect(before).toContain('Ravi Rao');
  await regrade(RAVI, 20); // a re-grade of the assignment after the lock
  const live = (await (await admin.get(`offerings/${offeringId}/gradebook/grid`)).json()) as {
    rows: { name: string; finalMarks: number }[];
  };
  expect(live.rows.find((r) => r.name === 'Ravi Rao')?.finalMarks).toBeLessThan(34); // the live grid follows
  expect(await csv()).toBe(before); // the snapshot does not
  await admin.dispose();
  const page = await asUser(browser, RAVI);
  await page.goto(url(`/offerings/${offeringId}/grades`));
  await expect(page.getByText(/approved record \(version 1\)/)).toBeVisible();
  await expect(page.getByTestId('final-marks')).toContainText('34');
  await expect(page.getByTestId('final-grade')).toContainText('Grade A'); // 34 / 40 = 85 %
  await expect(page.getByText('Final total').first()).toBeVisible();
  await accessibleEverywhere(page, 'my grades (final)');
  await page.context().close();
});

test('the approved gradebook exports as CSV and Excel, and the grade scale screen is accessible', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await signIn(page, COLLEGE, `admin@${COLLEGE}.test`);
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  await page.goto(gb());
  await expect(page.getByText('Approved versions')).toBeVisible();
  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download version 1 as CSV' }).click(),
  ]);
  const text = readFileSync((await csv.path()) as string, 'utf8');
  expect(text.split('\r\n')[0]).toBe(
    'Register number,Name,Internal 1,Quiz 1,Essay,Internal tests (%),Assignments (%),Quizzes (%),Final marks,Final percent,Grade',
  );
  expect(text).toMatch(/Ravi Rao,40,10,80,80,80,100,34,/);
  const [xlsx] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download version 1 as Excel' }).click(),
  ]);
  const bytes = readFileSync((await xlsx.path()) as string);
  expect(bytes.subarray(0, 2).toString()).toBe('PK');
  expect(xlsx.suggestedFilename()).toBe('gradebook-v1.xlsx');
  await accessibleEverywhere(page, 'the approved gradebook');
  await page.goto(url('/grade-scales'));
  await expect(page.getByRole('heading', { name: 'Grade scales' })).toBeVisible();
  await expect(page.getByText('E2E scale')).toBeVisible();
  await page.getByRole('button', { name: 'New scale' }).click();
  await accessibleEverywhere(page, 'the grade scale editor');
  await page.getByRole('dialog').getByLabel('Name').fill('Pass / fail');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved “Pass / fail”')).toBeVisible();
  await page.context().close();
});

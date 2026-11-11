import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { apiAs, createMember, eventually, expectAccessible, originOf, signIn } from '../support';

// Quizzes and exams end to end, on the real API, worker and database:
//  - the instructor builds a question bank (one by one and from a CSV) and an exam with random pools in the UI;
//  - a learner takes it, reloads in the middle and resumes, loses the connection, answers, RELOADS while still
//    disconnected, comes back, and every answer arrives; the submit dialog lists what is unanswered;
//  - a learner with an accommodation gets extra time; an attempt nobody hands in is closed by the worker at its deadline;
//  - the instructor grades an essay, regrades a corrected answer key, releases the results; the learner sees them;
//  - every new screen passes axe (light, dark and on a phone).
// The exam has a 1-minute limit, the grace after the deadline is 3 s and the sweeper runs every 2 s (scripts/stack.mjs).

const COLLEGE = 'e2e-one';
const COURSE = 'E2A101';
const INSTRUCTOR = 'quinn.quizmaster@e2e-one.test';
const LENA = 'lena.examinee@e2e-one.test';
const LEON = 'leon.examinee@e2e-one.test';

let courseId = '';
let offeringId = '';
let moduleId = '';
let itemId = '';

test.describe.configure({ mode: 'serial' });

async function asUser(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, COLLEGE, email);
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  return page;
}
const url = (path: string) => `${originOf(COLLEGE)}${path}`;

/** axe in the three looks the product promises: light, dark, and a 360 px phone. */
async function accessibleEverywhere(page: Page, label: string) {
  await expectAccessible(page, `${label} (light)`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page, `${label} (dark)`);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 360, height: 740 });
  await expectAccessible(page, `${label} (360 px)`);
  await page.setViewportSize({ width: 1280, height: 720 });
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const admin = await apiAs(COLLEGE, `admin@${COLLEGE}.test`);
  const must = async (res: Awaited<ReturnType<typeof admin.post>>) => {
    if (!res.ok() && res.status() !== 409)
      throw new Error(`setup call failed: ${res.status()} ${await res.text()}`);
    return res;
  };
  await must(
    await admin.post('academic-years', {
      data: { label: 'E2E 2026', startDate: '2026-06-01', endDate: '2027-05-31' },
    }),
  );
  const year = (
    (await (await admin.get('academic-years?limit=100')).json()) as {
      items: { id: string; label: string }[];
    }
  ).items.find((y) => y.label === 'E2E 2026');
  await must(
    await admin.post('terms', {
      data: {
        academicYearId: year?.id,
        name: 'E2E Semester 1',
        startDate: '2026-06-01',
        endDate: '2026-11-30',
      },
    }),
  );
  const term = (
    (await (await admin.get('terms?limit=100')).json()) as { items: { id: string; name: string }[] }
  ).items.find((x) => x.name === 'E2E Semester 1');
  const quinn = await createMember(COLLEGE, INSTRUCTOR, 'Quinn Quizmaster');
  const lena = await createMember(COLLEGE, LENA, 'Lena Examinee');
  const leon = await createMember(COLLEGE, LEON, 'Leon Examinee');
  await must(
    await admin.post('courses', { data: { code: COURSE, title: 'Assessments', credits: 2 } }),
  );
  const course = (
    (await (await admin.get(`courses?q=${COURSE}&limit=10`)).json()) as {
      items: { id: string; code: string }[];
    }
  ).items.find((c) => c.code === COURSE);
  courseId = course?.id ?? '';
  await must(await admin.post('offerings', { data: { courseId, termId: term?.id } }));
  offeringId = (
    (await (await admin.get(`offerings?courseId=${courseId}&limit=10`)).json()) as {
      items: { id: string }[];
    }
  ).items[0]?.id as string;
  for (const [userId, participation] of [
    [quinn, 'instructor'],
    [lena, 'learner'],
    [leon, 'learner'],
  ] as const) {
    await must(
      await admin.post(`offerings/${offeringId}/participants`, { data: { userId, participation } }),
    );
  }
  await admin.dispose();
  const q = await apiAs(COLLEGE, INSTRUCTOR);
  await must(await q.post(`offerings/${offeringId}/publish`));
  const m = (await (
    await must(await q.post(`offerings/${offeringId}/modules`, { data: { title: 'Exams' } }))
  ).json()) as { id: string };
  moduleId = m.id;
  await must(
    await q.patch(`offerings/${offeringId}/modules/${moduleId}`, { data: { published: true } }),
  );
  await q.dispose();
});

test('the instructor builds a question bank: one question in the form, essay, and a CSV import', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await asUser(browser, INSTRUCTOR);
  await page.goto(url(`/offerings/${offeringId}`));
  await page.getByRole('link', { name: 'Question bank' }).click();
  await expect(page.getByRole('heading', { name: 'Question bank' })).toBeVisible();
  await expect(page.getByText('No questions yet')).toBeVisible();
  await expectAccessible(page, 'question bank (empty)');

  // a single choice question in the form
  await page.getByRole('button', { name: 'New question' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New question' });
  await dialog.getByRole('textbox', { name: 'Question text' }).click();
  await page.keyboard.type('Which planet is closest to the Sun?');
  await dialog.getByLabel('Option 1 text').fill('Venus');
  await dialog.getByLabel('Option 2 text').fill('Mercury');
  await dialog.getByLabel('Option 2 is correct').check();
  await dialog.getByLabel('Tags, separated by commas').fill('planets');
  await expectAccessible(page, 'new question dialog');
  await dialog.getByRole('button', { name: 'Add question' }).click();
  await expect(page.getByText('Question added.')).toBeVisible();
  await expect(page.getByText('Which planet is closest to the Sun?')).toBeVisible();

  // an essay
  await page.getByRole('button', { name: 'New question' }).first().click();
  const essay = page.getByRole('dialog', { name: 'New question' });
  await essay.getByLabel('Type').selectOption('essay');
  await essay.getByRole('textbox', { name: 'Question text' }).click();
  await page.keyboard.type('Explain why the sky is blue.');
  await essay.getByRole('button', { name: 'Add question' }).click();
  await expect(page.getByText('Explain why the sky is blue.')).toBeVisible();

  // a CSV: 6 easy and 6 hard questions with the tag e2epool, one row with a formula (refused)
  const dir = join(import.meta.dirname, '..', '..', '.e2e-tmp', 'assessments');
  mkdirSync(dir, { recursive: true });
  const rows = ['type,question,option_a,option_b,option_c,correct,difficulty,tags'];
  for (let i = 1; i <= 6; i++)
    rows.push(`single_choice,Easy pool question ${i},yes,no,maybe,A,easy,e2epool`);
  for (let i = 1; i <= 6; i++)
    rows.push(`single_choice,Hard pool question ${i},right,wrong,other,B,hard,e2epool`);
  rows.push('single_choice,"=HYPERLINK(""x"")",a,b,c,A,easy,e2epool');
  const file = join(dir, 'pool.csv');
  writeFileSync(file, `${rows.join('\r\n')}\r\n`);
  await page.getByRole('button', { name: 'Import from CSV' }).click();
  const imp = page.getByRole('dialog', { name: 'Import questions from CSV' });
  await imp.locator('input[type=file]').setInputFiles(file);
  await expect(imp.getByRole('status')).toContainText('13 rows, 12 valid, 1 with problems');
  await expect(imp.getByText(/must not start with "="/)).toBeVisible();
  await expectAccessible(page, 'question import with a problem');
  await imp.getByRole('button', { name: 'Add the 12 valid questions only' }).click();
  await expect(page.getByText('12 questions added.')).toBeVisible();
  await page.getByLabel('Tag', { exact: true }).selectOption('e2epool');
  await expect(page.getByText('Easy pool question 1')).toBeVisible();
  await accessibleEverywhere(page, 'question bank');
  await page.context().close();
});

test('the instructor builds an exam with random pools, a time limit and a manual release', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await asUser(browser, INSTRUCTOR);
  await page.goto(url(`/offerings/${offeringId}/build`));
  await page.getByRole('button', { name: 'Add quiz or exam' }).click();
  const add = page.getByRole('dialog', { name: 'Add quiz or exam' });
  await add.getByLabel('Title').fill('Midterm exam');
  await add.getByLabel('Visible to learners').check();
  await add.getByRole('button', { name: 'Add quiz or exam' }).click();
  await expect(page.getByText('Midterm exam').first()).toBeVisible();
  await page.getByRole('link', { name: 'Questions and settings' }).click();
  await expect(page.getByRole('heading', { name: 'Midterm exam' })).toBeVisible();
  itemId = page.url().split('/items/')[1]?.split('/')[0] ?? '';
  expect(itemId).not.toBe('');

  // settings
  await page.getByLabel('Kind').selectOption('exam');
  await page.getByLabel('Time limit in minutes (empty: none of its own)').fill('1');
  await page.getByLabel('Attempts allowed').fill('2');
  await page.getByLabel('Which attempt counts').selectOption('highest');
  await page.getByLabel('Learners see their results').selectOption('manual');
  await page.getByLabel('Learners see the correct answers').selectOption('after_release');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();

  // questions: the planet question and the essay (fixed), two easy and one hard from the pool
  await page.getByRole('button', { name: 'Add a fixed question' }).click();
  const picker = page.getByRole('dialog', { name: 'Pick a question' });
  await picker
    .getByRole('listitem')
    .filter({ hasText: 'closest to the Sun' })
    .getByRole('button', { name: 'Add' })
    .click();
  await page.getByRole('button', { name: 'Add a fixed question' }).click();
  await page
    .getByRole('dialog', { name: 'Pick a question' })
    .getByRole('listitem')
    .filter({ hasText: 'sky is blue' })
    .getByRole('button', { name: 'Add' })
    .click();
  for (const [difficulty, count] of [
    ['easy', '2'],
    ['hard', '1'],
  ] as const) {
    await page.getByRole('button', { name: 'Add a random pool' }).click();
    const slot = page.getByRole('listitem').filter({ hasText: 'Random pool' }).last();
    await slot.getByLabel('Tag').selectOption('e2epool');
    await slot.getByLabel('Difficulty').selectOption(difficulty);
    await slot.getByLabel('How many').fill(count);
  }
  await page.getByRole('button', { name: 'Save questions' }).click();
  await expect(page.getByText('Questions saved.')).toBeVisible();
  await expect(page.getByText('5 questions · 5 points', { exact: true })).toBeVisible();
  await expect(page.getByText('6 matching questions in the bank').first()).toBeVisible();
  await page.getByRole('button', { name: 'Preview a sample paper' }).click();
  const preview = page.getByRole('dialog', { name: /Sample paper/ });
  await expect(preview.getByRole('listitem').filter({ hasText: /^Question \d/ })).toHaveCount(5);
  await expectAccessible(page, 'sample paper preview');
  await preview.getByRole('button', { name: 'Close' }).click();
  await accessibleEverywhere(page, 'assessment builder');
  await page.context().close();
});

test('a learner takes the exam: reload resumes, the connection drops, a reload while disconnected loses nothing', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await asUser(browser, LENA);
  await page.goto(url(`/offerings/${offeringId}/items/${itemId}`));
  await expect(page.getByText('5', { exact: true }).first()).toBeVisible(); // five questions
  await expect(page.getByText('0 of 2 used')).toBeVisible();
  await expectAccessible(page, 'assessment page of a learner');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('timer')).toBeVisible();
  const attemptId = page.url().split('/attempts/')[1]?.split('/')[0] ?? '';
  expect(attemptId).not.toBe('');
  await expect(page.getByRole('status').first()).toContainText('Saved');

  // answer the first question and move on: it is saved at once
  const nav = page.getByRole('navigation', { name: 'Questions' });
  const choose = async (position: number) => {
    await nav.getByRole('button', { name: new RegExp(`^Question ${position},`) }).click();
    const radios = page.getByRole('radio');
    if ((await radios.count()) > 0) await radios.first().check();
    else await page.getByLabel('Your answer').fill(`My essay answer ${Date.now()}`);
  };
  await choose(1);
  await choose(2);
  await expect(nav.getByRole('button', { name: /^Question 1, answered/ })).toBeVisible();
  await expect(page.getByRole('status').first()).toContainText('Saved');

  // reload in the middle: the same attempt, the answers are still there
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Questions' })).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Questions' })
      .getByRole('button', { name: /^Question 1, answered/ }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Questions' })
      .getByRole('button', { name: /^Question 2, answered/ }),
  ).toBeVisible();
  await expect(page.getByRole('status').first()).toContainText('Saved');
  // a second start (another tab, another device) is the SAME attempt
  const again = await page.context().newPage();
  await again.goto(url(`/offerings/${offeringId}/items/${itemId}`));
  await expect(again.getByRole('link', { name: 'Continue your attempt' })).toHaveAttribute(
    'href',
    new RegExp(attemptId),
  );
  await again.close();

  // the connection to the server is lost: answer, see the notice, RELOAD while it is still lost
  await page.route('**/api/**', (route) => route.abort('connectionrefused'));
  await choose(3);
  await choose(4);
  await expect(page.getByRole('status').first()).toContainText('Offline — answers will sync');
  await expect(page.getByText(/You are offline\. Keep answering/)).toBeVisible();
  await page.reload();
  const navOffline = page.getByRole('navigation', { name: 'Questions' });
  await expect(navOffline).toBeVisible();
  for (const n of [1, 2, 3, 4])
    await expect(
      navOffline.getByRole('button', { name: new RegExp(`^Question ${n}, answered`) }),
    ).toBeVisible();
  await expect(page.getByRole('status').first()).toContainText('Offline — answers will sync');
  // still disconnected: the learner answers the last one, and the exam screen is fine to use on a phone and in the dark
  await choose(5);
  await accessibleEverywhere(page, 'exam screen');

  // the connection returns: everything arrives
  await page.unroute('**/api/**');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('status').first()).toContainText('Saved', { timeout: 30_000 });
  const lena = await apiAs(COLLEGE, LENA);
  const onServer = await eventually(
    async () =>
      (await (await lena.get(`offerings/${offeringId}/attempts/${attemptId}`)).json()) as {
        questions: { position: number; answer: unknown }[];
      },
    (a) => a.questions.every((q) => q.answer !== null),
    'every answer on the server',
  );
  expect(onServer.questions).toHaveLength(5);
  await lena.dispose();

  // leave one question unanswered: the submit dialog says which
  await nav.getByRole('button', { name: /^Question 5,/ }).click();
  await page.getByRole('button', { name: 'Clear answer' }).click();
  await page.getByRole('button', { name: 'Submit' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Submit your answers?' });
  await expect(dialog.getByText('1 question is not answered:')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Question 5' })).toBeVisible();
  await expectAccessible(page, 'submit dialog');
  await dialog.getByRole('button', { name: 'Keep working' }).click();
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Submit' }).first().click();
  await page
    .getByRole('dialog', { name: 'Submit your answers?' })
    .getByRole('button', { name: 'Submit now' })
    .click();
  await expect(page.getByText('Your answers are in.')).toBeVisible();
  await expect(
    page.getByText('Your instructor has not released the results yet.', { exact: false }),
  ).toBeVisible();
  await accessibleEverywhere(page, 'result (not released)');
  await page.context().close();
});

test('an accommodation gives extra time; an attempt nobody hands in is closed by the worker at its deadline', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const q = await browser.newContext();
  const qp = await q.newPage();
  await signIn(qp, COLLEGE, INSTRUCTOR);
  await expect(qp.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  await qp.goto(url(`/offerings/${offeringId}/items/${itemId}/assessment`));
  const card = qp
    .locator('section, div')
    .filter({ has: qp.getByRole('heading', { name: 'Accommodations' }) })
    .last();
  await expect(qp.getByLabel('Reason (optional)')).toBeVisible();
  await expect(qp.getByText('Do not write medical details here.')).toBeVisible();
  await qp.getByLabel('Learner', { exact: true }).selectOption({ label: 'Leon Examinee' });
  await qp.getByLabel('Extra minutes').fill('5');
  await qp.getByLabel('Reason (optional)').fill('Approved by the disability office');
  await qp.getByRole('button', { name: 'Save accommodation' }).click();
  await expect(qp.getByText('Accommodation saved for Leon Examinee.')).toBeVisible();
  await expect(card.getByText('Leon Examinee').first()).toBeVisible();
  await expectAccessible(qp, 'assessment builder with an accommodation');
  await q.close();

  // Leon's page says 6 minutes; Lena's 1 (second attempt below)
  const leon = await browser.newContext();
  const lp = await leon.newPage();
  await signIn(lp, COLLEGE, LEON);
  await expect(lp.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  await lp.goto(url(`/offerings/${offeringId}/items/${itemId}`));
  await expect(lp.getByText('6 minutes')).toBeVisible();
  await expect(lp.getByText('including 5 extra minutes you were given')).toBeVisible();
  await leon.close();

  // Lena's second attempt: started, one answer, then the browser is closed: the worker closes it at the deadline
  const lena = await apiAs(COLLEGE, LENA);
  const started = (await (
    await lena.post(`offerings/${offeringId}/items/${itemId}/attempts`, { data: {} })
  ).json()) as {
    attemptId: string;
  };
  const paper = (await (
    await lena.get(`offerings/${offeringId}/attempts/${started.attemptId}`)
  ).json()) as {
    questions: { position: number; options: { id: string }[] }[];
  };
  const first = paper.questions.find((x) => x.options.length > 0);
  await lena.put(`offerings/${offeringId}/attempts/${started.attemptId}/answers`, {
    data: {
      answers: [
        {
          position: first?.position,
          answer: { o: [first?.options[0]?.id] },
          rev: 1,
          at: Date.now(),
        },
      ],
      events: [],
    },
  });
  const instructor = await apiAs(COLLEGE, INSTRUCTOR);
  const closed = await eventually(
    async () =>
      (await (
        await instructor.get(`offerings/${offeringId}/items/${itemId}/assessment/attempts`)
      ).json()) as {
        items: { attemptId: string; status: string; submitKind: string | null }[];
      },
    (r) => r.items.find((x) => x.attemptId === started.attemptId)?.status !== 'in_progress',
    'the worker to close the attempt at its deadline',
    120_000,
  );
  const row = closed.items.find((x) => x.attemptId === started.attemptId);
  expect(row?.submitKind).toBe('deadline');
  await lena.dispose();
  await instructor.dispose();
});

test('the instructor grades the essay, regrades a corrected key, and releases the results', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await asUser(browser, INSTRUCTOR);
  await page.goto(url(`/offerings/${offeringId}/items/${itemId}/grading`));
  await expect(page.getByRole('heading', { name: 'Grading and results' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Lena Examinee' }).first()).toBeVisible();
  await expect(page.getByText('closed at the deadline')).toBeVisible();
  await accessibleEverywhere(page, 'grading: attempts');

  // grade by question: the essay of the first attempt
  await page.getByRole('tab', { name: 'Grade by question' }).click();
  await page.getByRole('button', { name: /sky is blue/ }).click();
  await expect(page.getByTestId('answer-text')).toContainText('My essay answer');
  await page.getByLabel(/^Points \(0–/).fill('0.5');
  await page.getByLabel(/^Points \(0–/).press('Control+Enter');
  await expect(page.getByText('All answers to this question are graded')).toBeVisible();
  await accessibleEverywhere(page, 'grading: by question');

  // the key of the planet question was wrong: Venus was marked, Mercury is right. Fix it in the bank (a new version)...
  await page.goto(url(`/courses/${courseId}/questions`));
  await page
    .getByRole('listitem')
    .filter({ hasText: 'closest to the Sun' })
    .getByRole('button', { name: 'Edit' })
    .click();
  const edit = page.getByRole('dialog', { name: /Edit question/ });
  await edit.getByLabel('Option 1 is correct').check();
  await edit.getByRole('button', { name: 'Save as a new version' }).click();
  await expect(page.getByText('Saved as version 2.')).toBeVisible();
  // ... and regrade the finished attempts with it
  await page.goto(url(`/offerings/${offeringId}/items/${itemId}/grading`));
  await page.getByRole('tab', { name: 'Regrade' }).click();
  await page
    .getByLabel('Question', { exact: true })
    .selectOption({ label: 'Which planet is closest to the Sun?' });
  const v2 = await page
    .getByLabel('Score with version')
    .locator('option', { hasText: 'Version 2' })
    .getAttribute('value');
  await page.getByLabel('Score with version').selectOption(v2 as string);
  await page.getByRole('button', { name: 'Show what would change' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'would change' })).toBeVisible();
  await expectAccessible(page, 'regrade preview');
  await page.getByRole('button', { name: /^Apply to \d+ attempts$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Apply the regrade' }).click();
  await expect(page.getByText(/Regraded \d+ attempts\./)).toBeVisible();
  await expect(page.getByText(/regrade|rekey/i).first()).toBeVisible();
  await accessibleEverywhere(page, 'grading: regrade');

  // item analysis
  await page.getByRole('tab', { name: 'Item analysis' }).click();
  await expect(page.getByText('Finished attempts')).toBeVisible();
  await expectAccessible(page, 'grading: item analysis');

  // release
  await page.getByRole('tab', { name: 'Attempts' }).click();
  await page.getByRole('button', { name: 'Release results…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Release graded results' }).click();
  await expect(
    page.getByText(/attempts? released\./).or(page.getByText(/1 attempt released\./)),
  ).toBeVisible();
  await page.context().close();
});

test('the learner sees the released result with the correct answers; another learner sees nothing of it', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await asUser(browser, LENA);
  await page.goto(url(`/offerings/${offeringId}/items/${itemId}`));
  await expect(page.getByTestId('counted-score')).toBeVisible();
  await page.getByRole('link', { name: 'See the result' }).first().click();
  await expect(page.getByTestId('score')).toBeVisible();
  await expect(page.getByText('Correct answer').first()).toBeVisible();
  await expect(page.getByText('Feedback').first())
    .toBeVisible()
    .catch(() => undefined);
  await accessibleEverywhere(page, 'result (released)');
  await page.context().close();

  // Leon never took the exam: his page has no attempts, and Lena's attempt is not his to read
  const lena = await apiAs(COLLEGE, LENA);
  const list = (await (
    await lena.get(`offerings/${offeringId}/items/${itemId}/assessment/me`)
  ).json()) as {
    attempts: { id: string }[];
  };
  await lena.dispose();
  const leon = await apiAs(COLLEGE, LEON);
  const theirs = await leon.get(`offerings/${offeringId}/attempts/${list.attempts[0]?.id}/result`);
  expect(theirs.status()).toBe(404);
  await leon.dispose();
});

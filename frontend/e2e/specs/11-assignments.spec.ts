import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { type Browser, chromium, expect, type Page, test } from '@playwright/test';
import { apiAs, createMember, expectAccessible, originOf, signIn } from '../support';

// Assignments end to end, on the real API, worker, storage and database:
//  - the instructor builds a rubric and an assignment (late policy, blind grading, an attachment) in the UI;
//  - learners hand in: a PDF with a resubmission, a text, and the deadline: a LATE version that would replace an on-time one
//    asks for a confirmation with the exact penalty; keeping the on-time version writes nothing;
//  - the instructor grades blind (codes, no names), uses the rubric, sees the late penalty on its own line, waives it with a
//    reason, releases; the bulk ZIP downloads with the folders named by anonymous code;
//  - the learner sees raw score, penalty (waived) and final score;
//  - copying the offering into the next term brings the assignment and an exam with their dates moved by the offset of the terms,
//    and nothing a learner did;
//  - every new screen passes axe (light, dark and on a phone).

const COLLEGE = 'e2e-one';
const COURSE = 'E2B101';
const INSTRUCTOR = 'paula.professor@e2e-one.test';
const MIA = 'mia.marker@e2e-one.test';
const NOAH = 'noah.nolan@e2e-one.test';
const OLIVE = 'olive.owens@e2e-one.test';

let courseId = '';
let offeringId = '';
let nextOfferingId = '';
let itemId = '';
let moduleId = '';
const DAY = 86_400_000;
const FILES = join(process.cwd(), '.e2e-tmp', 'assignment-files');

test.describe.configure({ mode: 'serial' });

async function asUser(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, COLLEGE, email);
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  return page;
}
const url = (path: string) => `${originOf(COLLEGE)}${path}`;
const local = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const pdf = (label: string) =>
  Buffer.from(`%PDF-1.4\n1 0 obj\n<<>>\nendobj\n% ${label}\ntrailer\n<<>>\n%%EOF\n`);

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
  mkdirSync(FILES, { recursive: true });
  writeFileSync(join(FILES, 'mia-essay.pdf'), pdf('mia 1'));
  writeFileSync(join(FILES, 'mia-better.pdf'), pdf('mia 2'));
  writeFileSync(join(FILES, 'brief.pdf'), pdf('the brief'));
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
  for (const [name, startDate, endDate] of [
    ['E2E Semester 1', '2026-06-01', '2026-11-30'],
    ['E2E Semester 2', '2026-12-14', '2027-05-15'],
  ] as const)
    await must(
      await admin.post('terms', { data: { academicYearId: year?.id, name, startDate, endDate } }),
    );
  const terms = (
    (await (await admin.get('terms?limit=100')).json()) as { items: { id: string; name: string }[] }
  ).items;
  const t1 = terms.find((x) => x.name === 'E2E Semester 1')?.id;
  const t2 = terms.find((x) => x.name === 'E2E Semester 2')?.id;
  const paula = await createMember(COLLEGE, INSTRUCTOR, 'Paula Professor');
  const people = [
    [await createMember(COLLEGE, MIA, 'Mia Marker'), 'learner'],
    [await createMember(COLLEGE, NOAH, 'Noah Nolan'), 'learner'],
    [await createMember(COLLEGE, OLIVE, 'Olive Owens'), 'learner'],
  ] as const;
  await must(
    await admin.post('courses', { data: { code: COURSE, title: 'Assignments', credits: 2 } }),
  );
  courseId = (
    (await (await admin.get(`courses?q=${COURSE}&limit=10`)).json()) as {
      items: { id: string; code: string }[];
    }
  ).items.find((c) => c.code === COURSE)?.id as string;
  await must(await admin.post('offerings', { data: { courseId, termId: t1 } }));
  await must(await admin.post('offerings', { data: { courseId, termId: t2, label: 'next term' } }));
  const offerings = (
    (await (await admin.get(`offerings?courseId=${courseId}&limit=10`)).json()) as {
      items: { id: string; label: string }[];
    }
  ).items;
  offeringId = offerings.find((o) => o.label === '')?.id as string;
  nextOfferingId = offerings.find((o) => o.label === 'next term')?.id as string;
  for (const o of [offeringId, nextOfferingId])
    await must(
      await admin.post(`offerings/${o}/participants`, {
        data: { userId: paula, participation: 'instructor' },
      }),
    );
  for (const [userId, participation] of people)
    await must(
      await admin.post(`offerings/${offeringId}/participants`, { data: { userId, participation } }),
    );
  await admin.dispose();
  const q = await apiAs(COLLEGE, INSTRUCTOR);
  await must(await q.post(`offerings/${offeringId}/publish`));
  const m = (await (
    await must(await q.post(`offerings/${offeringId}/modules`, { data: { title: 'Work' } }))
  ).json()) as { id: string };
  moduleId = m.id;
  await must(
    await q.patch(`offerings/${offeringId}/modules/${moduleId}`, { data: { published: true } }),
  );
  await q.dispose();
});

test('the instructor builds a rubric and an assignment with a late policy, blind grading and an attachment', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const page = await asUser(browser, INSTRUCTOR);
  await page.goto(url(`/offerings/${offeringId}/build`));
  await page.getByRole('button', { name: 'Add assignment' }).click();
  const add = page.getByRole('dialog', { name: 'Add assignment' });
  await add.getByLabel('Title').fill('Essay');
  await add.getByLabel('Visible to learners').check();
  await add.getByRole('button', { name: 'Add assignment' }).click();
  await expect(page.getByText('Essay').first()).toBeVisible();

  // the rubric first (course scope)
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await expect(page.getByRole('heading', { name: 'Essay' })).toBeVisible();
  itemId = page.url().split('/items/')[1]?.split('/')[0] ?? '';
  expect(itemId).not.toBe('');
  await page.getByRole('link', { name: 'Rubrics' }).click();
  await expect(page.getByRole('heading', { name: 'Rubrics' })).toBeVisible();
  await expect(page.getByText('No rubrics yet')).toBeVisible();
  await expectAccessible(page, 'rubrics (empty)');
  await page.getByRole('button', { name: 'New rubric' }).first().click();
  const rd = page.getByRole('dialog', { name: 'New rubric' });
  await rd.getByLabel('Name', { exact: true }).fill('Essay rubric');
  await rd.getByLabel('Criterion 1 name').fill('Content');
  await rd.getByLabel('Criterion 1 level 1', { exact: true }).fill('Weak');
  await rd.getByLabel('Points of criterion 1 level 1').fill('0');
  await rd.getByLabel('Criterion 1 level 2', { exact: true }).fill('Strong');
  await rd.getByLabel('Points of criterion 1 level 2').fill('10');
  await rd.getByRole('button', { name: 'Add a criterion' }).click();
  await rd.getByLabel('Criterion 2 name').fill('Language');
  await rd.getByLabel('Criterion 2 level 1', { exact: true }).fill('Poor');
  await rd.getByLabel('Points of criterion 2 level 1').fill('0');
  await rd.getByLabel('Criterion 2 level 2', { exact: true }).fill('Good');
  await rd.getByLabel('Points of criterion 2 level 2').fill('5');
  await expect(rd.getByTestId('rubric-max')).toContainText('15');
  await expectAccessible(page, 'rubric dialog');
  await rd.getByRole('button', { name: 'Create rubric' }).click();
  await expect(page.getByText('Rubric created.')).toBeVisible();
  await expect(page.getByText('Essay rubric', { exact: true })).toBeVisible();
  await accessibleEverywhere(page, 'rubrics');

  // the assignment's settings
  await page.goto(url(`/offerings/${offeringId}/items/${itemId}/assignment`));
  await expect(page.getByRole('heading', { name: 'Essay' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Instructions' }).click();
  await page.keyboard.type('Write about the causes of the French Revolution.');
  await page.getByLabel('Due', { exact: true }).fill(local(Date.now() + 2 * DAY));
  await page.getByLabel('Late work').selectOption('allowed');
  await page.getByLabel('Hard cutoff').fill(local(Date.now() + 8 * DAY));
  await page.getByLabel('Penalty', { exact: true }).selectOption('per_day');
  await page.getByLabel('Penalty (% of the maximum points)').fill('10');
  await page.getByLabel('The penalty never exceeds (%)').fill('30');
  await page.getByLabel('Maximum points', { exact: true }).fill('50');
  await page.getByLabel('Text', { exact: true }).check();
  await page.getByLabel(/Blind grading/).check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();

  // an attachment and the rubric
  await page.getByLabel('Add a file').setInputFiles(join(FILES, 'brief.pdf'));
  await expect(page.getByText('File added.')).toBeVisible();
  await expect(page.getByText('brief.pdf').first()).toBeVisible();
  await page
    .getByLabel('Rubric', { exact: true })
    .selectOption({ label: 'Essay rubric (15 points)' });
  await page.getByRole('button', { name: 'Save rubric' }).click();
  await expect(page.getByText('Rubric saved.')).toBeVisible();
  await expect(page.getByText(/Attached: Essay rubric/)).toBeVisible();
  await accessibleEverywhere(page, 'assignment builder');
});

test('learners hand in: a PDF and a resubmission, a text; the page shows the rules, the versions and the countdown', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const mia = await asUser(browser, MIA);
  await mia.goto(url(`/offerings/${offeringId}/items/${itemId}`));
  await expect(mia.getByText('Write about the causes of the French Revolution.')).toBeVisible();
  await expect(mia.getByTestId('late-policy')).toContainText(
    '10% of the maximum (5 points) for every day',
  );
  await expect(mia.getByTestId('grace-note')).toContainText(
    'START uploading a file before the due date',
  );
  await expect(mia.getByTestId('countdown')).toContainText('day');
  await expect(mia.getByRole('button', { name: /brief\.pdf/ })).toBeVisible();
  await expect(mia.getByRole('button', { name: 'Hand in' })).toBeDisabled();
  await accessibleEverywhere(mia, 'assignment (learner, open)');

  await mia.getByLabel('Files', { exact: true }).setInputFiles(join(FILES, 'mia-essay.pdf'));
  await expect(mia.getByText('Uploaded')).toBeVisible();
  await mia.getByRole('button', { name: 'Hand in', exact: true }).click();
  await expect(mia.getByText('Handed in as version 1.')).toBeVisible();
  await expect(mia.getByText('Version 1', { exact: true })).toBeVisible();
  await expect(mia.getByText('This one counts')).toBeVisible();
  await expect(mia.getByText('On time', { exact: true })).toBeVisible();
  // a second version keeps the first
  await mia.getByLabel('Files', { exact: true }).setInputFiles(join(FILES, 'mia-better.pdf'));
  await expect(mia.getByText('Uploaded')).toBeVisible();
  await mia.getByLabel('Your text').fill('Second version with a note.');
  await mia.getByRole('button', { name: 'Hand in', exact: true }).click();
  await expect(mia.getByText('Handed in as version 2.')).toBeVisible();
  await expect(mia.getByText('Version 1', { exact: true })).toBeVisible();
  await expect(mia.getByText('Version 2', { exact: true })).toBeVisible();

  const noah = await asUser(browser, NOAH);
  await noah.goto(url(`/offerings/${offeringId}/items/${itemId}`));
  await noah.getByLabel('Your text').fill('This answer is written in plain text.');
  await noah.getByRole('button', { name: 'Hand in', exact: true }).click();
  await expect(noah.getByText('Handed in as version 1.')).toBeVisible();
  await accessibleEverywhere(noah, 'assignment (learner, handed in)');
});

test('the deadline passes: a LATE version asks for a confirmation with the exact penalty before it replaces an on-time one', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  // the due date moves to 30 hours ago (2 started days = 20% of 50 points = 10 points)
  const q = await apiAs(COLLEGE, INSTRUCTOR);
  const moved = await q.put(`offerings/${offeringId}/items/${itemId}/assignment`, {
    data: {
      dueAt: new Date(Date.now() - 30 * 3_600_000).toISOString(),
      lateCutoffAt: new Date(Date.now() + 5 * DAY).toISOString(),
    },
  });
  expect(moved.ok(), await moved.text()).toBe(true);
  await q.dispose();

  const mia = await asUser(browser, MIA);
  await mia.goto(url(`/offerings/${offeringId}/items/${itemId}`));
  await expect(mia.getByText('Late: a penalty applies')).toBeVisible();
  await expect(mia.getByTestId('late-now')).toContainText('20% = 10 points of 50 points');
  await mia.getByLabel('Files', { exact: true }).setInputFiles(join(FILES, 'mia-better.pdf'));
  await expect(mia.getByText('Uploaded')).toBeVisible();
  await mia.getByRole('button', { name: /Hand in late \(20% penalty\)/ }).click();
  const ask = mia.getByRole('dialog', { name: 'Hand in late and replace your on-time version?' });
  await expect(ask.getByTestId('late-confirm-penalty')).toContainText(
    '20% = 10 points of 50 points',
  );
  await expectAccessible(mia, 'late confirmation');
  // keeping the on-time version writes nothing
  await ask.getByRole('button', { name: 'Keep my on-time version' }).click();
  await expect(mia.getByText('Version 3', { exact: true })).toHaveCount(0);
  // confirming writes the late version with the penalty the dialog showed
  await mia.getByRole('button', { name: /Hand in late \(20% penalty\)/ }).click();
  await mia
    .getByRole('dialog', { name: 'Hand in late and replace your on-time version?' })
    .getByRole('button', { name: /Hand in late \(20% penalty\)/ })
    .click();
  await expect(mia.getByText(/Handed in as version 3: .* late, 20% penalty/)).toBeVisible();
  await expect(mia.getByText(/Late by .*: 20% penalty/)).toBeVisible();
  await accessibleEverywhere(mia, 'assignment (learner, late)');

  // Olive has nothing on time: no confirmation, she is only told what it costs
  const olive = await asUser(browser, OLIVE);
  await olive.goto(url(`/offerings/${offeringId}/items/${itemId}`));
  await olive.getByLabel('Your text').fill('A late text answer.');
  await olive.getByRole('button', { name: /Hand in late/ }).click();
  await expect(olive.getByText(/Handed in as version 1: .* late, 20% penalty/)).toBeVisible();
});

test('the instructor grades BLIND: codes, no names; the rubric; the penalty on its own line, waived with a reason; release; the ZIP', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await asUser(browser, INSTRUCTOR);
  await page.goto(url(`/offerings/${offeringId}/items/${itemId}/assignment/grading`));
  await expect(page.getByText(/Blind grading is on/).first()).toBeVisible();
  const queue = page.getByTestId('queue');
  await expect(queue.getByRole('button')).toHaveCount(3);
  for (const name of ['Mia Marker', 'Noah Nolan', 'Olive Owens', MIA, NOAH, OLIVE])
    await expect(page.locator('body')).not.toContainText(name);
  await expect(page.getByLabel('Order by').locator('option')).toHaveText([
    'Anonymous code',
    'Submission time',
  ]);
  await expect(page.getByTestId('summary')).toContainText('Late');
  await accessibleEverywhere(page, 'grading queue (blind)');

  // find the learner with three versions (Mia) by opening the rows
  const rows = queue.getByRole('button');
  let found = false;
  for (let i = 0; i < 3 && !found; i++) {
    await rows.nth(i).click();
    await expect(page.getByTestId('learner-panel')).toBeVisible();
    found = (await page.getByRole('tab', { name: /Version 3/ }).count()) > 0;
  }
  expect(found).toBe(true);
  await expect(page.getByTestId('learner-heading')).toContainText(/^Learner [A-Z2-9]{6}$/);
  await expect(page.locator('body')).not.toContainText('Mia Marker');
  // the files of a version: images and text are shown, a PDF opens in the browser's own viewer
  await page.getByRole('tab', { name: /Version 1/ }).click();
  await expect(page.getByRole('link', { name: 'Open in the browser viewer' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Download .*\.pdf/ })).toBeVisible();
  // the downloaded file's name is neutral while blind
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: /Download .*\.pdf/ })
    .first()
    .click();
  expect((await download).suggestedFilename()).toMatch(/^[A-Z2-9]{6}-v\d\.pdf$/);

  // grade with the rubric: the late version is graded; the penalty is shown separately
  await page.getByRole('tab', { name: /Version 3/ }).click();
  await page.getByLabel(/Strong/).check();
  await page.getByLabel(/Good/).check();
  await expect(page.getByTestId('rubric-score')).toContainText('15');
  await expect(page.getByTestId('penalty')).toContainText('− 10 points (20%)');
  await expect(page.getByTestId('score-breakdown')).toContainText('5 / 50');
  await page.getByLabel('Comment on Content').fill('A clear argument.');
  await page.getByRole('textbox', { name: 'Feedback' }).click();
  await page.keyboard.type('Well argued; watch the dates.');
  await page.getByRole('button', { name: 'Save grade' }).click();
  await expect(page.getByText('Grade saved.')).toBeVisible();
  await expect(page.getByTestId('summary')).toContainText('Graded 1');
  // the waiver, with a reason (audited)
  await page.getByRole('button', { name: 'Waive the late penalty' }).click();
  const waive = page.getByRole('dialog', { name: 'Waive the late penalty?' });
  await waive.getByLabel('Reason').fill('The portal was down on the due date.');
  await waive.getByRole('button', { name: 'Waive the penalty' }).click();
  await expect(page.getByText('The late penalty is waived.')).toBeVisible();
  await expect(page.getByTestId('penalty')).toContainText('waived');
  await expect(page.getByTestId('score-breakdown')).toContainText('15 / 50');
  await accessibleEverywhere(page, 'grading (blind, one learner)');

  // the bulk ZIP: folders by anonymous code, an index, no names
  const zip = await page.request.get(
    url(`/api/offerings/${offeringId}/items/${itemId}/assignment/submissions.zip`),
  );
  expect(zip.status()).toBe(200);
  expect(zip.headers()['content-type']).toBe('application/zip');
  expect(zip.headers()['content-disposition']).toContain('attachment');
  const bytes = await zip.body();
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
  const text = bytes.toString('latin1');
  expect(text).toContain('index.csv');
  expect(text).toMatch(/[A-Z2-9]{6}\/file-1\.pdf/);
  for (const name of ['Mia', 'Noah', 'Olive', 'Marker']) expect(text).not.toContain(name);

  // release everything graded: Mia's name appears, the others stay anonymous
  await page.getByRole('button', { name: 'Release all graded' }).click();
  await page
    .getByRole('dialog', { name: 'Release every graded submission?' })
    .getByRole('button', { name: 'Release all graded' })
    .click();
  await expect(page.getByText('1 grade released.')).toBeVisible();
  await expect(queue.getByText('Mia Marker')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Noah Nolan');
});

test('the learner sees the raw score, the (waived) penalty and the final score, the rubric and the feedback', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const mia = await asUser(browser, MIA);
  await mia.goto(url(`/offerings/${offeringId}/items/${itemId}`));
  await expect(mia.getByTestId('grade-raw')).toContainText('15 / 50');
  await expect(mia.getByTestId('grade-penalty')).toContainText('Waived by your instructor');
  await expect(mia.getByTestId('grade-final')).toContainText('15 / 50');
  await expect(mia.getByText('A clear argument.')).toBeVisible();
  await expect(mia.getByText('Well argued; watch the dates.')).toBeVisible();
  await expect(mia.getByRole('cell', { name: 'Strong' })).toBeVisible();
  await accessibleEverywhere(mia, 'assignment (learner, graded)');
  // Noah's grade was not released: nothing is shown
  const noah = await asUser(browser, NOAH);
  await noah.goto(url(`/offerings/${offeringId}/items/${itemId}`));
  await expect(noah.getByTestId('grade')).toHaveCount(0);
});

test('copying into the next term brings the assignment and an exam with their dates moved by the offset of the terms, and nothing a learner did', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  // an exam with its own dates in the source (set through the API: the exam builder has its own spec)
  const q = await apiAs(COLLEGE, INSTRUCTOR);
  const bank = await q.post(`courses/${courseId}/questions`, {
    data: {
      type: 'single_choice',
      stem: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Copy me?' }] }],
      },
      options: [
        {
          text: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Yes' }] }],
          },
          correct: true,
        },
        {
          text: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'No' }] }],
          },
          correct: false,
        },
      ],
    },
  });
  const question = (await bank.json()) as { id: string };
  const examItem = (await (
    await q.post(`offerings/${offeringId}/modules/${moduleId}/items`, {
      data: { kind: 'assessment', title: 'Midterm', published: true },
    })
  ).json()) as { id: string };
  const opens = new Date('2026-07-01T09:00:00.000Z');
  const closes = new Date('2026-07-01T11:00:00.000Z');
  expect(
    (
      await q.put(`offerings/${offeringId}/items/${examItem.id}/assessment`, {
        data: {
          kind: 'exam',
          opensAt: opens.toISOString(),
          closesAt: closes.toISOString(),
          timeLimitMinutes: 45,
        },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await q.put(`offerings/${offeringId}/items/${examItem.id}/assessment/slots`, {
        data: { slots: [{ kind: 'fixed', questionId: question.id, points: 5 }] },
      })
    ).ok(),
  ).toBe(true);
  const source = (await (
    await q.get(`offerings/${offeringId}/items/${itemId}/assignment`)
  ).json()) as { settings: { dueAt: string } };
  await q.dispose();

  const page = await asUser(browser, INSTRUCTOR);
  await page.goto(url(`/offerings/${nextOfferingId}/build`));
  await page.getByRole('button', { name: 'Copy content from…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Copy content from another course' });
  await dialog.getByLabel('Copy from').selectOption({ index: 1 });
  const preview = dialog.getByTestId('copy-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('196 days');
  await expect(preview).toContainText('Essay');
  await expect(preview).toContainText('Midterm');
  await expect(preview).toContainText('Never copied: attempts, submissions, grades');
  await expect(dialog.getByLabel('Move the dates by (days)')).toHaveValue('196');
  await expectAccessible(page, 'copy preview');
  await dialog.getByRole('button', { name: 'Copy content' }).click();
  await expect(page.getByText(/Copied 1 module and 2 items/)).toBeVisible();

  // the copy: the assignment's due date moved by 196 days, the exam too, and no learner data
  const n = await apiAs(COLLEGE, INSTRUCTOR);
  const outline = (await (await n.get(`offerings/${nextOfferingId}/outline`)).json()) as {
    modules: { items: { id: string; kind: string; title: string }[] }[];
  };
  const items = outline.modules.flatMap((m) => m.items);
  const essay = items.find((i) => i.kind === 'assignment');
  const midterm = items.find((i) => i.kind === 'assessment');
  expect(essay && midterm).toBeTruthy();
  const copied = (await (
    await n.get(`offerings/${nextOfferingId}/items/${essay?.id}/assignment`)
  ).json()) as {
    settings: { dueAt: string; anonymousGrading: boolean; latePolicy: string };
    attachments: unknown[];
    rubric: { title: string } | null;
  };
  expect(new Date(copied.settings.dueAt).getTime()).toBe(
    new Date(source.settings.dueAt).getTime() + 196 * DAY,
  );
  expect(copied.settings).toMatchObject({ anonymousGrading: true, latePolicy: 'allowed' });
  expect(copied.attachments).toHaveLength(1);
  expect(copied.rubric?.title).toBe('Essay rubric');
  const exam = (await (
    await n.get(`offerings/${nextOfferingId}/items/${midterm?.id}/assessment`)
  ).json()) as {
    settings: { opensAt: string; closesAt: string; timeLimitMinutes: number };
    questionCount: number;
  };
  expect(new Date(exam.settings.opensAt).getTime()).toBe(opens.getTime() + 196 * DAY);
  expect(new Date(exam.settings.closesAt).getTime()).toBe(closes.getTime() + 196 * DAY);
  expect(exam).toMatchObject({ questionCount: 1 });
  const summary = (await (
    await n.get(`offerings/${nextOfferingId}/items/${essay?.id}/assignment/grading/summary`)
  ).json()) as {
    submitted: number;
    late: number;
    graded: number;
    released: number;
    notSubmitted: number;
  };
  expect(summary).toMatchObject({ submitted: 0, late: 0, graded: 0, released: 0 });
  await n.dispose();
});

// Chromium refuses a PDF in a sandboxed iframe, so the grading screen does NOT preview PDFs in one: it offers "Open in the browser
// viewer" (a new tab, the storage answers `nosniff` and a sandboxing CSP). Both halves are checked here in a FULL Chromium (the
// default headless shell has no PDF viewer): the real file opens in the viewer; and, with the same headers, a sandboxed iframe is
// refused. If a future Chromium lifts the refusal this test fails and the preview can be made inline.
test("a PDF opens in the browser's own viewer from the grading screen; a sandboxed iframe is refused by Chromium", async () => {
  test.setTimeout(120_000);
  const q = await apiAs(COLLEGE, INSTRUCTOR);
  const queue = (await (
    await q.get(`offerings/${offeringId}/items/${itemId}/assignment/grading/queue?limit=10`)
  ).json()) as { items: { learnerKey: string; versionNo: number | null }[] };
  const key = queue.items.find((i) => i.versionNo !== null)?.learnerKey;
  const detail = (await (
    await q.get(`offerings/${offeringId}/items/${itemId}/assignment/grading/learners/${key}`)
  ).json()) as { submissions: { files: { fileId: string; contentType: string }[] }[] };
  const file = detail.submissions
    .flatMap((s) => s.files)
    .find((f) => f.contentType === 'application/pdf');
  const target = (await (
    await q.get(`offerings/${offeringId}/items/${itemId}/assignment/grading/files/${file?.fileId}`)
  ).json()) as { url: string; inline: boolean };
  await q.dispose();
  expect(target.inline).toBe(true);

  const browser = await chromium.launch({ channel: 'chromium' });
  const probe = createServer((req, res) => {
    if (req.url?.startsWith('/page')) {
      res.setHeader('content-type', 'text/html');
      res.end(
        '<!doctype html><title>t</title><iframe sandbox="" src="/file.pdf" width="300" height="300"></iframe>',
      );
      return;
    }
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', 'inline; filename="a.pdf"');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'none'; sandbox");
    res.end(pdf('probe'));
  });
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signIn(page, COLLEGE, INSTRUCTOR);
    await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
    // the link of the grading screen: the real file, top level, signed URL of the real storage
    await page.goto(new URL(target.url, originOf(COLLEGE)).href);
    await expect
      .poll(() => page.frames().some((f) => f.url().startsWith('chrome-extension://')), {
        timeout: 15_000,
      })
      .toBe(true);
    // the same kind of response in a sandboxed iframe: refused
    const other = await (await browser.newContext()).newPage();
    const port = (probe.address() as { port: number }).port;
    await other.goto(`http://127.0.0.1:${port}/page`);
    await other.waitForTimeout(1500);
    expect(other.frames().some((f) => f.url().startsWith('chrome-extension://'))).toBe(false);
    expect(other.frames().some((f) => f.url().startsWith('chrome-error://'))).toBe(true);
  } finally {
    probe.close();
    await browser.close();
  }
});

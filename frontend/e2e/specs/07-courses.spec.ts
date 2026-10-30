import { expect, type Page, test } from '@playwright/test';
import {
  apiAs,
  createMember,
  eventually,
  expectAccessible,
  originOf,
  signIn,
  signInAsAdmin,
} from '../support';

// Courses end to end, on the real API, worker and database: an administrator sets up a course, an offering,
// an instructor and a section; the instructor builds the content and publishes; learners see it, a student
// who changes section loses and regains access; unpublished and locked entries stay closed; every new screen
// passes axe in both themes.

const COLLEGE = 'e2e-one';
const COURSE = 'E2E101';
const TITLE = 'Introduction to testing';
let offeringId = '';
let sectionA = '';
let sectionB = '';
let leoId = '';

const future = () => {
  const d = new Date(Date.now() + 14 * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`;
};

/** A fresh browser context signed in as `email`. */
async function asUser(browser: import('@playwright/test').Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, COLLEGE, email);
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  return page;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const api = await apiAs(COLLEGE, `admin@${COLLEGE}.test`);
  const get = async (url: string) =>
    (await (await api.get(url)).json()) as {
      items: { id: string; code?: string; name?: string; label?: string }[];
    };
  const must = async (res: Awaited<ReturnType<typeof api.post>>) => {
    if (!res.ok() && res.status() !== 409)
      throw new Error(`setup call failed: ${res.status()} ${await res.text()}`);
  };
  // the academic structure (idempotent: another spec may have made part of it)
  await must(await api.post('departments', { data: { code: 'CSE', name: 'Computer Science' } }));
  const dept = (await get('departments?limit=100')).items.find((d) => d.code === 'CSE');
  await must(
    await api.post('programs', {
      data: { departmentId: dept?.id, code: 'BTECH', name: 'B.Tech', durationYears: 4 },
    }),
  );
  const prog = (await get(`programs?departmentId=${dept?.id}&limit=100`)).items.find(
    (p) => p.code === 'BTECH',
  );
  await must(
    await api.post('batches', {
      data: { programId: prog?.id, admissionYear: 2023, graduationYear: 2027 },
    }),
  );
  const batch = (await get(`batches?programId=${prog?.id}&limit=100`)).items[0];
  await must(await api.post('sections', { data: { batchId: batch?.id, code: 'A' } }));
  await must(await api.post('sections', { data: { batchId: batch?.id, code: 'B' } }));
  const sections = (await get(`sections?batchId=${batch?.id}&limit=100`)).items;
  sectionA = sections.find((s) => s.code === 'A')?.id ?? '';
  sectionB = sections.find((s) => s.code === 'B')?.id ?? '';
  await must(
    await api.post('academic-years', {
      data: { label: 'E2E 2026', startDate: '2026-06-01', endDate: '2027-05-31' },
    }),
  );
  const year = (await get('academic-years?limit=100')).items.find((y) => y.label === 'E2E 2026');
  await must(
    await api.post('terms', {
      data: {
        academicYearId: year?.id,
        name: 'E2E Semester 1',
        startDate: '2026-06-01',
        endDate: '2026-11-30',
      },
    }),
  );

  // the people
  await createMember(COLLEGE, 'ira.instructor@e2e-one.test', 'Ira Instructor');
  await createMember(COLLEGE, 'lena.learner@e2e-one.test', 'Lena Learner');
  leoId = await createMember(COLLEGE, 'leo.mover@e2e-one.test', 'Leo Mover');
  const lenaId = await createMember(COLLEGE, 'lena.learner@e2e-one.test', 'Lena Learner');
  for (const [id, reg] of [
    [lenaId, 'E2E-LENA'],
    [leoId, 'E2E-LEO'],
  ] as const) {
    await must(
      await api.patch(`members/${id}/profile`, {
        data: {
          profileType: 'student',
          registerNumber: reg,
          batchId: batch?.id,
          sectionId: sectionA,
        },
      }),
    );
  }
  await api.dispose();
});

test('an administrator creates a course without a department, an offering, an instructor, and enrols a section', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signInAsAdmin(page, COLLEGE);

  // ---- the catalog
  await page.getByRole('link', { name: 'Courses' }).first().click();
  await expect(page.getByRole('heading', { name: 'Courses' })).toBeVisible();
  await expectAccessible(page, 'courses (empty or not)');
  await page.getByRole('button', { name: 'New course' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'New course' });
  await expectAccessible(page, 'new course dialog');
  await dlg.getByLabel('Course code').fill(COURSE);
  await dlg.getByLabel('Title').fill(TITLE);
  await dlg.getByLabel('Credits (optional)').fill('3');
  await dlg.getByRole('button', { name: 'Create course' }).click();
  await expect(page.getByText(`Created ${COURSE} — ${TITLE}.`)).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: COURSE });
  await expect(row).toContainText('None'); // no department
  // the "no department" filter finds it, a department filter does not
  await page.getByLabel('Department').selectOption('none');
  await expect(page.getByRole('row').filter({ hasText: COURSE })).toBeVisible();
  await expectAccessible(page, 'courses');

  // ---- the offering
  await page.getByRole('link', { name: 'Offerings' }).first().click();
  await expect(page.getByRole('heading', { name: 'Offerings' })).toBeVisible();
  await page.getByRole('button', { name: 'New offering' }).first().click();
  const od = page.getByRole('dialog', { name: 'New offering' });
  await od.getByLabel('Course').selectOption({ label: `${COURSE} — ${TITLE}` });
  await od.getByLabel('Term').selectOption({ label: 'E2E Semester 1' });
  await od.getByRole('button', { name: 'Create offering' }).click();
  await expect(page.getByText(/Created Introduction to testing for E2E Semester 1/)).toBeVisible();
  await page.getByRole('link', { name: new RegExp(`${COURSE} — ${TITLE}`) }).click();
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();
  offeringId = page.url().split('/offerings/')[1]?.split(/[/?#]/)[0] ?? '';
  expect(offeringId).toMatch(/^[0-9a-f-]{36}$/);
  await expectAccessible(page, 'offering (administrator)');

  // ---- people: an instructor by hand, a section for the learners
  await page.getByRole('link', { name: 'People and sections' }).click();
  await expect(page.getByRole('heading', { name: 'People and sections' })).toBeVisible();
  await page.getByRole('button', { name: 'Add a person' }).click();
  const pd = page.getByRole('dialog', { name: 'Add a person' });
  await pd.getByLabel(/Find a member/).fill('ira.instructor');
  await pd.getByRole('button', { name: /Ira Instructor/ }).click();
  await pd.getByLabel('Role in this course').selectOption('instructor');
  await expectAccessible(page, 'add a person dialog');
  await pd.getByRole('button', { name: 'Add Ira Instructor' }).click();
  await expect(page.getByText('Ira Instructor was added as instructor.')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Ira Instructor' })).toContainText(
    'Added by hand',
  );

  await page.getByRole('button', { name: 'Enrol a section' }).click();
  const sd = page.getByRole('dialog', { name: 'Enrol a section' });
  await sd.getByLabel('Department').selectOption({ label: 'CSE — Computer Science' });
  await sd.getByLabel('Program').selectOption({ index: 1 });
  await sd.getByLabel('Batch').selectOption({ index: 1 });
  await sd.getByLabel('Section').selectOption({ label: 'A' });
  await sd.getByRole('button', { name: 'Enrol this section' }).click();
  await expect(page.getByText(/The section is enrolled/)).toBeVisible();
  await expectAccessible(page, 'people and sections');

  // the worker enrols the section's students in the background
  const api = await apiAs(COLLEGE, `admin@${COLLEGE}.test`);
  const learners = await eventually(
    async () =>
      (
        await (
          await api.get(`offerings/${offeringId}/participants?participation=learner&limit=100`)
        ).json()
      ).items as { displayName: string; source: string }[],
    (items) =>
      items.some((i) => i.displayName === 'Lena Learner') &&
      items.some((i) => i.displayName === 'Leo Mover'),
    'the section sync to enrol Lena and Leo',
  );
  expect(learners.find((l) => l.displayName === 'Lena Learner')?.source).toBe('section');
  await api.dispose();
  await page.getByRole('button', { name: 'Refresh the class list' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Lena Learner' })).toContainText(
    'Section A',
  );
});

test('the instructor builds a module with text, a file, a link and hidden / locked entries, then publishes', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await asUser(browser, 'ira.instructor@e2e-one.test');
  // the course is on the home page, flagged as a draft
  const card = page.getByRole('link', { name: new RegExp(TITLE) });
  await expect(card).toContainText('Draft');
  await card.click();
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();
  await page.getByRole('link', { name: 'Edit content' }).click();
  await expect(page.getByText('Draft: learners cannot see this course yet')).toBeVisible();

  // ---- a module
  await page.getByRole('button', { name: 'Add a module' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename module' });
  await rename.getByLabel('Title').fill('Week 1');
  await rename.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Week 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Show module Week 1 to learners' }).click();
  await expect(page.getByRole('button', { name: 'Hide module Week 1 to learners' })).toBeVisible();

  // ---- a text item (the editor chunk may already have been fetched in idle time)
  await page.getByRole('button', { name: 'Add text' }).click();
  const td = page.getByRole('dialog', { name: 'Add text' });
  await td.getByLabel('Title').fill('Read this first');
  const editor = td.getByRole('textbox', { name: 'Text of this item' });
  await editor.click();
  await page.keyboard.type('Welcome to the course. ');
  const bold = td.getByRole('button', { name: 'Bold' });
  await bold.click();
  // the mark is on and the caret is back in the editor before typing (slow CI)
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await expect(editor).toBeFocused();
  await page.keyboard.type('Read carefully');
  await expect(editor.locator('strong', { hasText: 'Read carefully' })).toBeVisible();
  await expectAccessible(page, 'add text dialog (rich text editor)');
  await td.getByLabel('Visible to learners').check();
  await td.getByRole('button', { name: 'Add text' }).click();
  await expect(page.getByText('Added “Read this first”.')).toBeVisible();

  // ---- a file item with an upload
  await page.getByRole('button', { name: 'Add file' }).click();
  const fd = page.getByRole('dialog', { name: 'Add file' });
  await fd.getByLabel('File', { exact: true }).setInputFiles({
    name: 'grades.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('name,mark\nLena,90\nLeo,85\n'),
  });
  await expect(fd.getByText('grades.csv')).toBeVisible();
  await fd.getByLabel('Visible to learners').check();
  await fd.getByRole('button', { name: 'Add file' }).click();
  await expect(page.getByText(/Added “grades”/)).toBeVisible();

  // a file the server refuses (an executable called .pdf is judged by its bytes at confirm; .exe by its name)
  await page.getByRole('button', { name: 'Add file' }).click();
  const bad = page.getByRole('dialog', { name: 'Add file' });
  await bad.getByLabel('File', { exact: true }).setInputFiles({
    name: 'setup.exe',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('MZ'),
  });
  await expect(bad.getByRole('alert')).toContainText('cannot be uploaded');
  await bad.getByRole('button', { name: 'Cancel' }).click();

  // ---- a hidden item and a locked item
  await page.getByRole('button', { name: 'Add link' }).click();
  const hd = page.getByRole('dialog', { name: 'Add link' });
  await hd.getByLabel('Title').fill('Hidden exam answers');
  await hd.getByLabel('Web address').fill('https://example.org/answers');
  await hd.getByRole('button', { name: 'Add link' }).click(); // not visible to learners
  await expect(page.getByText('Added “Hidden exam answers”.')).toBeVisible();

  await page.getByRole('button', { name: 'Add link' }).click();
  const ld = page.getByRole('dialog', { name: 'Add link' });
  await ld.getByLabel('Title').fill('Opens in two weeks');
  await ld.getByLabel('Web address').fill('https://example.org/later');
  await ld.getByLabel('Visible to learners').check();
  await ld.getByLabel('Opens on (optional)').fill(future());
  await ld.getByRole('button', { name: 'Add link' }).click();
  await expect(page.getByText('Added “Opens in two weeks”.')).toBeVisible();

  // ---- reorder with the buttons (keyboard users) and see it announced
  await page.getByRole('button', { name: 'Move Opens in two weeks up' }).click();
  await expect(page.getByText(/Opens in two weeks moved to position 3 of 4/)).toBeVisible();
  await expectAccessible(page, 'builder');

  // ---- a second module reorders by drag handle buttons too
  await page.getByRole('button', { name: 'Add a module' }).click();
  await page.getByRole('dialog', { name: 'Rename module' }).getByLabel('Title').fill('Week 2');
  await page
    .getByRole('dialog', { name: 'Rename module' })
    .getByRole('button', { name: 'Save' })
    .click();
  await page.getByRole('button', { name: 'Move module Week 2 up' }).click();
  await expect(page.getByRole('heading', { level: 2 }).first()).toHaveText('Week 2');
  await page.getByRole('button', { name: 'Move module Week 2 down' }).click();

  // ---- publish
  await page.getByRole('button', { name: 'Publish course' }).click();
  await expect(page.getByRole('button', { name: 'Unpublish course' })).toBeVisible();

  // the layout holds on a phone and in the dark theme
  await page.setViewportSize({ width: 360, height: 740 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `builder scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page, 'builder (dark, 360 px)');
  await page.context().close();
});

test('a learner sees the published entries, the locked one by title and date, never the hidden one; downloads the file', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await asUser(browser, 'lena.learner@e2e-one.test');
  await page.getByRole('link', { name: new RegExp(TITLE) }).click();
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit content' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Read this first/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /grades/ })).toBeVisible();
  await expect(page.getByText('Hidden exam answers')).toHaveCount(0);
  const locked = page.locator('ul > li').filter({ hasText: 'Opens in two weeks' });
  await expect(locked).toContainText('Available from');
  await expect(locked.getByRole('link')).toHaveCount(0);
  await expect(page.getByText('example.org/later')).toHaveCount(0);
  await expectAccessible(page, 'offering (learner)');

  // the text, as formatted text
  await page.getByRole('link', { name: /Read this first/ }).click();
  await expect(page.getByText('Welcome to the course.')).toBeVisible();
  await expect(page.locator('strong', { hasText: 'Read carefully' })).toBeVisible();
  await expectAccessible(page, 'item (text)');

  // the file downloads through a signed link
  await page.goBack();
  await page.getByRole('link', { name: /grades/ }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download grades.csv' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('grades.csv');
  await page.context().close();
});

test('a student who changes section loses access after the sync, and gets it back when moved back', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const leo = await asUser(browser, 'leo.mover@e2e-one.test');
  await expect(leo.getByRole('link', { name: new RegExp(TITLE) })).toBeVisible();

  const admin = await apiAs(COLLEGE, `admin@${COLLEGE}.test`);
  const status = async () => {
    const leoApi = await apiAs(COLLEGE, 'leo.mover@e2e-one.test');
    const res = await leoApi.get(`offerings/${offeringId}`);
    await leoApi.dispose();
    return res.status();
  };
  const move = async (sectionId: string) => {
    const res = await admin.post(`members/${leoId}/profile/section`, { data: { sectionId } });
    expect(res.ok(), await res.text()).toBe(true);
  };
  await move(sectionB);
  await eventually(status, (s) => s === 404, 'Leo to lose access');
  await leo.reload();
  await expect(leo.getByRole('link', { name: new RegExp(TITLE) })).toHaveCount(0);
  await expect(leo.getByText('You are not in any course yet')).toBeVisible();
  await leo.goto(`${originOf(COLLEGE)}/offerings/${offeringId}`);
  await expect(leo.getByText('Could not open this course')).toBeVisible();

  await move(sectionA);
  await eventually(status, (s) => s === 200, 'Leo to get access back');
  await leo.goto(`${originOf(COLLEGE)}/`);
  await expect(leo.getByRole('link', { name: new RegExp(TITLE) })).toBeVisible();
  await admin.dispose();
  await leo.context().close();
});

test('every new screen passes the accessibility check in the light and dark theme and on a phone', async ({
  browser,
  page,
}) => {
  test.setTimeout(150_000);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await signInAsAdmin(page, COLLEGE);
    for (const [path, heading] of [
      ['/courses', 'Courses'],
      ['/offerings', 'Offerings'],
      [`/offerings/${offeringId}/people`, 'People and sections'],
    ] as const) {
      await page.goto(`${originOf(COLLEGE)}${path}`);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expectAccessible(page, `${path} (${scheme})`);
    }
  }
  await page.setViewportSize({ width: 360, height: 740 });
  for (const path of [
    '/courses',
    '/offerings',
    `/offerings/${offeringId}`,
    `/offerings/${offeringId}/people`,
  ]) {
    await page.goto(`${originOf(COLLEGE)}${path}`);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
    await expectAccessible(page, `${path} (360 px)`);
  }
  // the learner's course page and an item in the dark theme
  const learner = await asUser(browser, 'lena.learner@e2e-one.test');
  await learner.emulateMedia({ colorScheme: 'dark' });
  await learner.goto(`${originOf(COLLEGE)}/offerings/${offeringId}`);
  await expect(learner.getByRole('heading', { name: TITLE })).toBeVisible();
  await expectAccessible(learner, 'offering (learner, dark)');
  await learner.context().close();
});

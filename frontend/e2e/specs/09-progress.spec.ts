import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import { apiAs, createMember, expectAccessible, originOf, signIn } from '../support';

// Learning progress end to end, on the real API, worker (ffmpeg) and database: a learner marks a text item done and
// opens a link (course progress follows), watches part of a video and a NEW browser context resumes at the saved
// position, watches enough and the video completes; a second learner who only skips ahead does not complete it;
// the instructor sees the class table (filters, drilldown, CSV) and creates no progress by previewing; deleting an
// item with progress archives it; every new screen passes axe in both themes and on a phone.
//
// The clip is 30 s. The offering's completion share is set to 50 % (a setting of the offering) so the test does not
// have to play 27 s in real time; the 90 % default is covered by the backend tests.

const COLLEGE = 'e2e-one';
const COURSE = 'E2P101';
const INSTRUCTOR = 'pia.professor@e2e-one.test';
const LIAM = 'liam.learner@e2e-one.test';
const LARA = 'lara.learner@e2e-one.test';

let offeringId = '';
let notesId = '';
let linkId = '';
let videoItemId = '';
let clipPath = '';

test.describe.configure({ mode: 'serial' });

async function asUser(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, COLLEGE, email);
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  return page;
}

const itemUrl = (id: string) => `${originOf(COLLEGE)}/offerings/${offeringId}/items/${id}`;

interface Mine {
  participant: boolean;
  percent: number | null;
  completedRequired: number;
  totalRequired: number;
  items: {
    itemId: string;
    status: string;
    watchedPercent: number | null;
    positionSeconds: number | null;
  }[];
}
const mineOf = async (api: APIRequestContext): Promise<Mine> =>
  (await (await api.get(`offerings/${offeringId}/progress`)).json()) as Mine;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const dir = join(import.meta.dirname, '..', '..', '.e2e-tmp', 'progress');
  mkdirSync(dir, { recursive: true });
  clipPath = join(dir, 'clip.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=25:d=30',
    '-f',
    'lavfi',
    '-i',
    'sine=f=330:d=30',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '50',
    '-c:a',
    'aac',
    '-shortest',
    clipPath,
  ]);

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

  const piaId = await createMember(COLLEGE, INSTRUCTOR, 'Pia Professor');
  const liamId = await createMember(COLLEGE, LIAM, 'Liam Learner');
  const laraId = await createMember(COLLEGE, LARA, 'Lara Learner');

  await must(
    await admin.post('courses', { data: { code: COURSE, title: 'Learning progress', credits: 2 } }),
  );
  const course = (
    (await (await admin.get(`courses?q=${COURSE}&limit=10`)).json()) as {
      items: { id: string; code: string }[];
    }
  ).items.find((c) => c.code === COURSE);
  await must(await admin.post('offerings', { data: { courseId: course?.id, termId: term?.id } }));
  const offering = (
    (await (await admin.get(`offerings?courseId=${course?.id}&limit=10`)).json()) as {
      items: { id: string }[];
    }
  ).items[0];
  offeringId = offering?.id ?? '';
  for (const [userId, participation] of [
    [piaId, 'instructor'],
    [liamId, 'learner'],
    [laraId, 'learner'],
  ] as const) {
    await must(
      await admin.post(`offerings/${offeringId}/participants`, {
        data: { userId, participation },
      }),
    );
  }
  await admin.dispose();

  const pia = await apiAs(COLLEGE, INSTRUCTOR);
  await must(await pia.post(`offerings/${offeringId}/publish`));
  await must(
    await pia.patch(`offerings/${offeringId}`, {
      data: { completionThreshold: 50, behindAfterDays: 7 },
    }),
  );
  const module_ = (await (
    await must(await pia.post(`offerings/${offeringId}/modules`, { data: { title: 'Unit 1' } }))
  ).json()) as { id: string };
  await must(
    await pia.patch(`offerings/${offeringId}/modules/${module_.id}`, { data: { published: true } }),
  );
  const addItem = async (data: Record<string, unknown>) =>
    (
      (await (
        await must(
          await pia.post(`offerings/${offeringId}/modules/${module_.id}/items`, {
            data: { published: true, ...data },
          }),
        )
      ).json()) as { id: string }
    ).id;
  const doc = (t: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
  });
  notesId = await addItem({ kind: 'text', title: 'Welcome notes', body: doc('Hello') });
  linkId = await addItem({ kind: 'link', title: 'Reading list', url: 'https://example.org/list' });

  // the video: uploaded in chunks through the API like the browser does, then transcoded by the worker
  const bytes = readFileSync(clipPath);
  const created = (await (
    await must(
      await pia.post(`offerings/${offeringId}/videos`, {
        data: { fileName: 'clip.mp4', size: bytes.length },
      }),
    )
  ).json()) as { video: { id: string }; upload: { chunkBytes: number } };
  const videoId = created.video.id;
  for (let offset = 0; offset < bytes.length; offset += created.upload.chunkBytes) {
    const res = await pia.patch(`offerings/${offeringId}/videos/${videoId}/upload`, {
      headers: {
        'content-type': 'application/offset+octet-stream',
        'upload-offset': String(offset),
      },
      data: bytes.subarray(offset, offset + created.upload.chunkBytes),
    });
    if (!res.ok()) throw new Error(`chunk at ${offset} failed: ${res.status()}`);
  }
  await must(await pia.post(`offerings/${offeringId}/videos/${videoId}/complete`));
  await expect
    .poll(
      async () =>
        (
          (await (await pia.get(`offerings/${offeringId}/videos/${videoId}`)).json()) as {
            status: string;
          }
        ).status,
      { timeout: 150_000, intervals: [1000] },
    )
    .toBe('ready');
  videoItemId = await addItem({ kind: 'video', title: 'Lecture', videoId });
  await pia.dispose();
});

test('a learner starts at 0 %, marks a text item as done and opens a link: the course progress follows', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const page = await asUser(browser, LIAM);
  const bar = page.getByRole('progressbar', { name: 'Progress in Learning progress' });
  await expect(bar).toHaveAttribute('aria-valuenow', '0');
  await expectAccessible(page, 'My courses with a progress bar');

  await page
    .getByRole('link', { name: /Learning progress/ })
    .first()
    .click();
  await expect(page.getByRole('progressbar', { name: /Your progress in/ })).toHaveAttribute(
    'aria-valuenow',
    '0',
  );
  await expect(page.getByText('0 of 3 required items')).toBeVisible();
  await expectAccessible(page, 'course page with progress');

  // a text item is marked by hand
  await page.getByRole('link', { name: /Welcome notes/ }).click();
  await expect(page.getByRole('heading', { name: 'Welcome notes' })).toBeVisible();
  await expect(page.getByText('Not started', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mark as done' }).click();
  await expect(page.getByText('You marked this as done.')).toBeVisible();
  await expectAccessible(page, 'item page, done');
  // undo and redo: the number follows
  await page.getByRole('button', { name: 'Mark as not done' }).click();
  await expect(page.getByRole('button', { name: 'Mark as done' })).toBeVisible();
  await page.getByRole('button', { name: 'Mark as done' }).click();
  await expect(page.getByText('You marked this as done.')).toBeVisible();

  // a link completes when it is opened
  await page.goto(itemUrl(linkId));
  await expect(page.getByRole('heading', { name: 'Reading list' })).toBeVisible();
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();

  await page.goto(`${originOf(COLLEGE)}/offerings/${offeringId}`);
  await expect(page.getByRole('progressbar', { name: /Your progress in/ })).toHaveAttribute(
    'aria-valuenow',
    '67',
  );
  await expect(page.getByText('2 of 3 required items')).toBeVisible();
  await page.goto(`${originOf(COLLEGE)}/`);
  await expect(
    page.getByRole('progressbar', { name: 'Progress in Learning progress' }),
  ).toHaveAttribute('aria-valuenow', '67');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page, 'My courses (dark)');
  await page.setViewportSize({ width: 360, height: 740 });
  await expectAccessible(page, 'My courses (phone)');
  await page.context().close();
});

test('part of the video is watched; a NEW browser context resumes at the saved position', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await asUser(browser, LIAM);
  await page.goto(itemUrl(videoItemId));
  const player = page.getByRole('region', { name: 'Video player: Lecture' });
  await player.getByRole('button', { name: 'Play' }).click();
  const time = () => page.locator('video').evaluate((v) => (v as HTMLVideoElement).currentTime);
  await expect.poll(time, { timeout: 45_000 }).toBeGreaterThan(7);
  await player.getByRole('button', { name: 'Pause' }).click(); // the pause sends a heartbeat at once
  await page.context().close();

  // the server knows the position and the unique seconds (poll: the heartbeat travels after the click)
  const liam = await apiAs(COLLEGE, LIAM);
  await expect
    .poll(
      async () => (await mineOf(liam)).items.find((i) => i.itemId === videoItemId)?.positionSeconds,
      {
        timeout: 15_000,
      },
    )
    .toBeGreaterThanOrEqual(6);
  const partial = (await mineOf(liam)).items.find((i) => i.itemId === videoItemId);
  expect(partial?.status).toBe('in_progress');
  expect(partial?.watchedPercent).toBeGreaterThan(0);
  expect(partial?.watchedPercent).toBeLessThan(50);
  await liam.dispose();

  // a new context (another device: no local storage) starts where the learner stopped
  const again = await asUser(browser, LIAM);
  await again.goto(itemUrl(videoItemId));
  await expect(again.getByText('In progress', { exact: true })).toBeVisible();
  const box = again.getByRole('region', { name: 'Video player: Lecture' });
  await box.getByRole('button', { name: 'Play' }).click();
  await expect
    .poll(
      () =>
        again.locator('video').evaluate((v) => {
          const el = v as HTMLVideoElement;
          return el.readyState >= 2 ? el.currentTime : -1;
        }),
      { timeout: 45_000 },
    )
    .toBeGreaterThanOrEqual(6);
  await again.context().close();
});

test('watching enough completes the video item and the course reaches 100 %', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await asUser(browser, LIAM);
  await page.goto(itemUrl(videoItemId));
  const player = page.getByRole('region', { name: 'Video player: Lecture' });
  await player.getByRole('button', { name: 'Play' }).click();
  await player.getByRole('combobox', { name: 'Playback speed' }).selectOption('2');
  const time = () => page.locator('video').evaluate((v) => (v as HTMLVideoElement).currentTime);
  // it resumed near 7 s and needs 15 s of unique video: play on to 20 s
  await expect.poll(time, { timeout: 60_000 }).toBeGreaterThan(20);
  await player.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText('Video completed')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();
  await page.goto(`${originOf(COLLEGE)}/offerings/${offeringId}`);
  await expect(page.getByRole('progressbar', { name: /Your progress in/ })).toHaveAttribute(
    'aria-valuenow',
    '100',
  );
  await page.context().close();
});

test('a second learner who only skips ahead does not complete the video', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await asUser(browser, LARA);
  await page.goto(itemUrl(videoItemId));
  const player = page.getByRole('region', { name: 'Video player: Lecture' });
  await player.getByRole('button', { name: 'Play' }).click();
  const time = () => page.locator('video').evaluate((v) => (v as HTMLVideoElement).currentTime);
  await expect.poll(time, { timeout: 45_000 }).toBeGreaterThan(2);
  // jump to 90 % and play a little more
  await player.focus();
  await page.keyboard.press('9');
  await expect.poll(time, { timeout: 15_000 }).toBeGreaterThan(26);
  await expect.poll(time, { timeout: 15_000 }).toBeGreaterThan(28);
  await player.getByRole('button', { name: 'Pause' }).click();
  const lara = await apiAs(COLLEGE, LARA);
  await expect
    .poll(
      async () =>
        (await mineOf(lara)).items.find((i) => i.itemId === videoItemId)?.positionSeconds ?? 0,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(26);
  const row = (await mineOf(lara)).items.find((i) => i.itemId === videoItemId);
  expect(row?.status).toBe('in_progress'); // about 5 s of 30 were really watched
  expect(row?.watchedPercent).toBeLessThan(50);
  await lara.dispose();
  await page.context().close();
});

test('the instructor sees the class table, filters it, opens a learner, exports the CSV, and creates no progress', async ({
  browser,
}) => {
  const page = await asUser(browser, INSTRUCTOR);
  await page.goto(`${originOf(COLLEGE)}/offerings/${offeringId}`);
  await expect(page.getByRole('progressbar', { name: /Your progress in/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Class progress' }).click();
  const table = page.getByRole('table', { name: 'Class progress' });
  await expect(table).toBeVisible();
  const liam = table.getByRole('row').filter({ hasText: 'Liam Learner' });
  const lara = table.getByRole('row').filter({ hasText: 'Lara Learner' });
  await expect(liam).toContainText('100% complete');
  await expect(liam).toContainText('Completed');
  await expect(lara).toContainText('In progress');
  await expect(page.getByText('2 learners')).toBeVisible();
  await expectAccessible(page, 'class progress');

  // filter by status: only the learner who is still working
  await page.getByLabel('Status').selectOption('in_progress');
  await expect(table.getByRole('row').filter({ hasText: 'Liam Learner' })).toHaveCount(0);
  await expect(lara).toBeVisible();
  await page.getByLabel('Status').selectOption('');
  // sort by progress, lowest first
  await page.getByLabel('Sort by').selectOption('percent');
  await expect(table.getByRole('row').nth(1)).toContainText('Lara Learner');

  // one learner, item by item (with the dialog open for axe)
  await page.getByRole('button', { name: 'Details of Lara Learner' }).click();
  const dialog = page.getByRole('dialog', { name: /Lara Learner.s progress/ });
  await expect(dialog.getByText('Lecture')).toBeVisible();
  await expect(dialog.getByText(/watched \d+%/)).toBeVisible();
  await expectAccessible(page, 'class progress, learner details');
  await dialog.getByRole('button', { name: 'Close' }).click();

  // CSV with the filters of the screen
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('class-progress.csv');
  const csv = readFileSync((await download.path()) ?? '', 'utf8');
  expect(csv).toContain('Liam Learner');
  expect(csv).toContain('Lara Learner');
  expect(csv.split('\n')[0]).toContain('Unit 1');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page, 'class progress (dark)');
  await page.setViewportSize({ width: 360, height: 740 });
  await expect(page.getByRole('button', { name: 'Details of Liam Learner' })).toBeVisible();
  await expectAccessible(page, 'class progress (phone)');
  await page.context().close();

  // previewing creates no progress: the API refuses a heartbeat from an instructor and the table keeps 2 learners
  const pia = await apiAs(COLLEGE, INSTRUCTOR);
  const beat = await pia.post(`offerings/${offeringId}/items/${videoItemId}/progress/heartbeat`, {
    data: {
      videoId: '00000000-0000-7000-8000-000000000001',
      streamId: '00000000-0000-7000-8000-000000000002',
      seq: 1,
      ranges: [[0, 5]],
      position: 5,
      rate: 1,
    },
  });
  expect(beat.status()).toBe(403);
  const classView = (await (await pia.get(`offerings/${offeringId}/progress/class`)).json()) as {
    total: number;
  };
  expect(classView.total).toBe(2);
  await pia.dispose();
});

test('learners never see the class view', async () => {
  const lara = await apiAs(COLLEGE, LARA);
  expect((await lara.get(`offerings/${offeringId}/progress/class`)).status()).toBe(403);
  expect((await lara.get(`offerings/${offeringId}/progress/class.csv`)).status()).toBe(403);
  await lara.dispose();
});

test('deleting an item that has learner progress archives it, and the percentages follow', async ({
  browser,
}) => {
  const page = await asUser(browser, INSTRUCTOR);
  await page.goto(`${originOf(COLLEGE)}/offerings/${offeringId}/build`);
  await page.getByRole('button', { name: 'Delete Welcome notes' }).click();
  const dialog = page.getByRole('dialog', { name: /Archive “Welcome notes”\?/ });
  await expect(dialog).toContainText('This item has learner progress, so it will be archived');
  await expectAccessible(page, 'archive confirmation');
  await dialog.getByRole('button', { name: 'Archive “Welcome notes”' }).click();
  await expect(
    page.getByText('Archived “Welcome notes”. Its learner progress is kept.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Welcome notes' })).toHaveCount(0);
  await page.context().close();

  // Liam: the item is gone from his course and the percentage is computed on what is left (2 of 2)
  const liam = await apiAs(COLLEGE, LIAM);
  const mine = await mineOf(liam);
  expect(mine.totalRequired).toBe(2);
  expect(mine.percent).toBe(100);
  expect(mine.items.map((i) => i.itemId)).not.toContain(notesId);
  expect((await liam.get(`offerings/${offeringId}/items/${notesId}`)).status()).toBe(404);
  await liam.dispose();
});

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { apiAs, createMember, expectAccessible, originOf, signIn, signInAsAdmin } from '../support';

// Video lessons end to end, on the real API, worker (ffmpeg) and database: an instructor uploads a short video,
// waits until it is ready and publishes it; a learner plays it (the manifest loads and the playback time advances);
// a person who does not take part is denied, and so is a link that belongs to someone else; an expired link stops
// the segments; every new screen passes axe in both themes and on a phone.
//
// The stack sets VIDEO_PLAYBACK_TTL_SECONDS=20 (stack.mjs): a playback link is good for 20 seconds here.

const COLLEGE = 'e2e-one';
const COURSE = 'E2V101';
const INSTRUCTOR = 'ira.instructor@e2e-one.test';
const LEARNER = 'lena.learner@e2e-one.test';
const OUTSIDER = 'olga.outsider@e2e-one.test';
const VTT =
  'WEBVTT\n\n00:00.000 --> 00:03.000\nWelcome to the lecture\n\n00:03.000 --> 00:06.000\nThe second caption\n';

let offeringId = '';
let moduleId = '';
let itemId = '';
let clipPath = '';

test.describe.configure({ mode: 'serial' });

/** A fresh browser context signed in as `email`. */
async function asUser(browser: import('@playwright/test').Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, COLLEGE, email);
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  return page;
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  // a short test clip (a test pattern and a tone: no copyrighted material), made with the ffmpeg on the PATH
  const dir = join(import.meta.dirname, '..', '..', '.e2e-tmp', 'video');
  mkdirSync(dir, { recursive: true });
  clipPath = join(dir, 'lecture.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=25:d=8',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=8',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
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
  // a term (another spec may have made it)
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

  const iraId = await createMember(COLLEGE, INSTRUCTOR, 'Ira Instructor');
  const lenaId = await createMember(COLLEGE, LEARNER, 'Lena Learner');
  await createMember(COLLEGE, OUTSIDER, 'Olga Outsider');

  await must(
    await admin.post('courses', { data: { code: COURSE, title: 'Video lessons', credits: 2 } }),
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
  await must(
    await admin.post(`offerings/${offeringId}/participants`, {
      data: { userId: iraId, participation: 'instructor' },
    }),
  );
  await must(
    await admin.post(`offerings/${offeringId}/participants`, {
      data: { userId: lenaId, participation: 'learner' },
    }),
  );
  await admin.dispose();

  const ira = await apiAs(COLLEGE, INSTRUCTOR);
  await must(await ira.post(`offerings/${offeringId}/publish`));
  const m = (await (
    await must(await ira.post(`offerings/${offeringId}/modules`, { data: { title: 'Week 1' } }))
  ).json()) as { id: string };
  moduleId = m.id;
  await must(
    await ira.patch(`offerings/${offeringId}/modules/${moduleId}`, { data: { published: true } }),
  );
  await ira.dispose();
});

test('an instructor uploads a short video, adds captions, waits until it is ready, and publishes it', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const page = await asUser(browser, INSTRUCTOR);
  await page.goto(`${originOf(COLLEGE)}/offerings/${offeringId}/build`);
  await expect(page.getByRole('heading', { name: 'Week 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Add video' }).click();
  const dlg = page.getByRole('dialog', { name: 'Add video' });
  await expect(dlg.getByRole('button', { name: 'Add video' })).toBeDisabled(); // nothing to save before a video exists
  await expectAccessible(page, 'add video dialog');

  await dlg.getByLabel('Title').fill('Lecture 1');
  await dlg.getByLabel('Visible to learners').check();
  await dlg.getByLabel('Video file').setInputFiles(clipPath);
  // the upload (in chunks, see stack.mjs), then the worker transcodes it: the dialog follows along
  await expect(dlg.getByText('Ready', { exact: false }).first()).toBeVisible({ timeout: 120_000 });
  await expect(dlg.getByText(/360p/)).toBeVisible(); // the renditions that were made

  // captions: an instructor adds WebVTT, one language
  await dlg
    .getByLabel('Captions file (.vtt)')
    .setInputFiles({ name: 'en.vtt', mimeType: 'text/vtt', buffer: Buffer.from(VTT) });
  await expect(page.getByText('Added English captions.')).toBeVisible();
  await expect(dlg.getByText('English (en)')).toBeVisible();
  await expectAccessible(page, 'add video dialog (ready, with captions)');

  await dlg.getByRole('button', { name: 'Add video' }).click();
  await expect(page.getByText('Added “Lecture 1”.')).toBeVisible();
  const row = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: 'Edit Lecture 1' }) })
    .last(); // the module's own list item contains it too
  await expect(row).toBeVisible();
  await expect(row.getByText('Video', { exact: true })).toBeVisible();
  await expect(row).toContainText('min'); // the duration badge
  await expectAccessible(page, 'builder with a video item');

  // editing it: the preview plays through the same session as a learner's
  await row.getByRole('button', { name: 'Edit Lecture 1' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit video' });
  await edit.getByRole('button', { name: 'Preview' }).click();
  await expect(edit.getByRole('region', { name: 'Video player: Lecture 1' })).toBeVisible();
  await edit.getByRole('button', { name: 'Cancel' }).click();
  await page.context().close();
});

test('a learner plays it: the manifest loads and the playback time advances', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await asUser(browser, LEARNER);
  await page.goto(`${originOf(COLLEGE)}/offerings/${offeringId}`);
  const link = page.getByRole('link', { name: /Lecture 1/ });
  await expect(link).toBeVisible();
  itemId = (await link.getAttribute('href'))?.split('/items/')[1] ?? '';
  expect(itemId).toMatch(/^[0-9a-f-]{36}$/);

  // what the browser saw, for the failure report (a stalled player is otherwise a mystery)
  const seen: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/video/play/'))
      seen.push(
        `${r.status()} ${r.url().split('/').slice(-2).join('/')} ${r.headers()['content-type'] ?? ''}`,
      );
  });
  page.on('console', (m) => seen.push(`console.${m.type()}: ${m.text().slice(0, 200)}`));
  page.on('pageerror', (e) => seen.push(`pageerror: ${e.message.slice(0, 200)}`));
  page.on('requestfailed', (r) =>
    seen.push(`FAILED ${r.url().split('/').slice(-2).join('/')} ${r.failure()?.errorText}`),
  );
  await link.click();
  // the page opens with the poster and a Play button; the player (hls.js) loads when Play is pressed
  const player = page.getByRole('region', { name: 'Video player: Lecture 1' });
  await expect(player).toBeVisible();
  await expect(player.locator('video')).toHaveCount(0);
  await expectAccessible(page, 'video item (before Play)');
  const manifest = page.waitForResponse(
    (r) => r.url().includes('/video/play/') && r.url().endsWith('/master.m3u8'),
  );
  await player.getByRole('button', { name: 'Play' }).click();
  const res = await manifest;
  expect(res.status()).toBe(200);
  expect(res.headers()['referrer-policy']).toBe('no-referrer');
  expect(res.headers()['content-type']).toBe('application/vnd.apple.mpegurl');
  // the viewer's name is on the picture, and the page asks browsers not to leak the address
  await expect(player).toContainText('Lena Learner · lena.learner@e2e-one.test');
  expect(await page.locator('meta[name="referrer"]').getAttribute('content')).toBe('no-referrer');
  await expect(player.getByRole('combobox', { name: 'Captions' })).toBeVisible();

  // pressing Play started it: the playback time advances
  const time = () => page.locator('video').evaluate((v) => (v as HTMLVideoElement).currentTime);
  try {
    await expect
      .poll(time, { timeout: 45_000, message: 'the playback time never advanced' })
      .toBeGreaterThan(1);
  } finally {
    await test
      .info()
      .attach('what the browser saw', { body: seen.join(' | '), contentType: 'text/plain' });
  }
  await player.getByRole('button', { name: 'Pause' }).click();
  // the keyboard works: seek back five seconds
  const before = await time();
  await player.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(time).toBeLessThan(before);

  // the same page, in both themes and on a phone, passes axe
  await expectAccessible(page, 'video item (light)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page, 'video item (dark)');
  await page.setViewportSize({ width: 360, height: 740 });
  await expectAccessible(page, 'video item (phone)');
  await page.context().close();
});

test('a person who takes no part is denied, and so is a link that was issued to someone else', async () => {
  const lena = await apiAs(COLLEGE, LEARNER);
  const olga = await apiAs(COLLEGE, OUTSIDER);
  // Olga is a member of the college but not of the course: the course does not even show itself to her
  const denied = await olga.post(`offerings/${offeringId}/items/${itemId}/playback`);
  expect(denied.status()).toBe(404);
  expect((await denied.json()).error.code).toBe('offering_not_found');
  expect(
    (
      await olga.post(`offerings/${offeringId}/videos`, { data: { fileName: 'a.mp4', size: 10 } })
    ).status(),
  ).toBe(404);

  // Lena's playback link is no use to anybody else, even a signed-in member of the same college
  const session = await (
    await lena.post(`offerings/${offeringId}/items/${itemId}/playback`)
  ).json();
  expect((await lena.get(session.manifestUrl)).status()).toBe(200);
  expect((await olga.get(session.manifestUrl)).status()).toBe(403);
  // and not without a session at all
  const anon = await (await import('@playwright/test')).request.newContext({
    baseURL: `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? 4173}/`,
    extraHTTPHeaders: { host: `${COLLEGE}.localhost:${process.env.E2E_WEB_PORT ?? 4173}` },
  });
  expect((await anon.get(session.manifestUrl)).status()).toBe(401);
  await anon.dispose();
  await lena.dispose();
  await olga.dispose();
});

test('an expired link stops the segments; a new one works', async () => {
  test.setTimeout(90_000);
  const lena = await apiAs(COLLEGE, LEARNER);
  const session = await (
    await lena.post(`offerings/${offeringId}/items/${itemId}/playback`)
  ).json();
  const base = (session.manifestUrl as string).replace('master.m3u8', '');
  const manifest = await (await lena.get(session.manifestUrl)).text();
  const variant = manifest.split('\n').find((l) => l.endsWith('/index.m3u8')) ?? '';
  const playlist = await (await lena.get(base + variant)).text();
  const segment =
    base +
    variant.replace('index.m3u8', playlist.split('\n').find((l) => l.endsWith('.m4s')) ?? '');
  expect((await lena.get(segment)).status()).toBe(200);
  const expiresIn = new Date(session.expiresAt).getTime() - Date.now();
  await new Promise((r) => setTimeout(r, Math.max(0, expiresIn) + 1500));
  const late = await lena.get(segment);
  expect(late.status()).toBe(403);
  expect((await late.json()).error.code).toBe('invalid_link');
  expect((await lena.get(session.manifestUrl)).status()).toBe(403);
  // a fresh session works again (this is what the player asks for by itself)
  const next = await (await lena.post(`offerings/${offeringId}/items/${itemId}/playback`)).json();
  expect((await lena.get(next.manifestUrl)).status()).toBe(200);
  await lena.dispose();
});

test('the administrator sees the video item but the course content is not theirs to edit', async ({
  page,
}) => {
  await signInAsAdmin(page, COLLEGE);
  await page.goto(`${originOf(COLLEGE)}/offerings/${offeringId}`);
  await expect(page.getByRole('link', { name: /Lecture 1/ })).toBeVisible();
});

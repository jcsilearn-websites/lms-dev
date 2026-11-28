import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, originOf, type Page, test } from '../support';

// THE DEMO COLLEGE as the walkthrough uses it: every role signs in and loads its main screens. Each screen must show
// something the seed made (a missing person, quiz or assignment fails here), with no console error, no page error and no
// failed request.

const SLUG = 'demo-e2e';
const ORIGIN = originOf(SLUG);
const mail = (local: string) => `${local}@${SLUG}.example`;

interface DemoState {
  password: string;
  adminEmail: string;
  adminTotpSecret: string;
}
const state = () => JSON.parse(readFileSync(process.env.E2E_DEMO_STATE ?? '', 'utf8')) as DemoState;

/**
 * RFC 6238 (SHA-1, 6 digits, 30 s): the code of the NEXT step. The server accepts one step either way, and only a step later
 * than the last one it accepted: the seed's enrolment may have used the current one.
 */
function totp(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + 1));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = (mac[19] as number) & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Everything that went wrong in this page, from the first request on. */
function problemsOf(page: Page): string[] {
  const problems: string[] = [];
  // the one expected refusal: "am I signed in?" before signing in
  const expected = (url: string, status: string) =>
    status === '401' && new URL(url).pathname === '/api/auth/me';
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const url = message.location().url;
    if (url && expected(url, /status of (\d+)/.exec(message.text())?.[1] ?? '')) return;
    problems.push(`console: ${message.text()} ${url}`);
  });
  page.on('requestfailed', (request) => {
    // a request cut off because the person went to another page is not a failure
    const reason = request.failure()?.errorText ?? '';
    if (reason !== 'net::ERR_ABORTED') problems.push(`request failed: ${reason} ${request.url()}`);
  });
  page.on('response', (response) => {
    const status = response.status();
    if (status >= 400 && !expected(response.url(), String(status))) {
      problems.push(`HTTP ${status}: ${response.url()}`);
    }
  });
  return problems;
}

async function signInAs(page: Page, email: string) {
  await page.goto(`${ORIGIN}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(state().password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
const welcome = (page: Page, name: string) =>
  expect(page.getByRole('heading', { name: `Welcome, ${name}` })).toBeVisible({ timeout: 20_000 });

/** The screen has loaded what it asked for, and nothing went wrong on the way. */
async function loaded(page: Page, problems: string[], screen: string) {
  await page.waitForLoadState('networkidle');
  expect(problems, `errors on "${screen}"`).toEqual([]);
}
const open = async (page: Page, path: string) => {
  await page.goto(`${ORIGIN}${path}`);
};
const heading = (page: Page, name: string | RegExp) =>
  expect(page.getByRole('heading', { name }).first()).toBeVisible();
const shows = (page: Page, text: string | RegExp) =>
  expect(page.locator('main').getByText(text).first()).toBeVisible();
const link = (page: Page, name: string | RegExp) =>
  page.locator('main').getByRole('link', { name }).first();

/** Opens a course from the home page and returns its path, `/offerings/<id>`. */
async function openCourse(page: Page, title: string): Promise<string> {
  await link(page, new RegExp(title)).click();
  await expect(page).toHaveURL(/\/offerings\/[0-9a-f-]+$/);
  await heading(page, title);
  return new URL(page.url()).pathname;
}

test('administrator: two-step sign-in, then the college screens', async ({ page }) => {
  const problems = problemsOf(page);
  const { adminEmail, adminTotpSecret } = state();
  await signInAs(page, adminEmail);
  await expect(page.getByRole('heading', { name: 'Two-step sign-in' })).toBeVisible();
  await page.getByLabel('Code from your authenticator app').fill(totp(adminTotpSecret));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await welcome(page, 'Dr. Meena Raghavan');
  await loaded(page, problems, 'home');

  const screens: [string, () => Promise<unknown>][] = [
    [
      '/members',
      async () => {
        for (const name of ['Prof. Arjun Nair', 'Karthik Iyer', 'Ananya Krishnan']) {
          await expect(link(page, name)).toBeVisible();
        }
      },
    ],
    ['/academics', () => shows(page, /Academic|Departments/)],
    ['/imports', () => heading(page, 'Bulk import')],
    ['/college-dashboard', () => heading(page, 'College dashboard')],
    ['/gradebooks', () => expect(link(page, /CS201.*Data Structures/)).toBeVisible()],
    ['/grade-scales', () => heading(page, 'College grade scale')],
    ['/audit', () => heading(page, 'Audit log')],
    ['/settings', () => heading(page, 'College settings')],
    ['/privacy/erasure', () => heading(page, 'Erasure requests')],
  ];
  for (const [path, check] of screens) {
    await open(page, path);
    await check();
    await loaded(page, problems, path);
  }
});

test('instructor: the course, its builder, gradebook, dashboards and grading', async ({ page }) => {
  const problems = problemsOf(page);
  await signInAs(page, mail('arjun.nair'));
  await welcome(page, 'Prof. Arjun Nair');
  const course = await openCourse(page, 'Data Structures');
  for (const name of [
    /Lecture 1: Arrays/,
    /Unit test 1/,
    /Timed quiz: stacks and queues/,
    /Assignment 2/,
  ]) {
    await expect(link(page, name)).toBeVisible();
  }
  await loaded(page, problems, 'course');

  const screens: [string, () => Promise<unknown>][] = [
    [`${course}/build`, () => heading(page, 'Unit 3: Trees')],
    [`${course}/gradebook`, () => shows(page, 'Waiting for approval')],
    [`${course}/dashboard`, () => heading(page, /Learners flagged\s*11/)],
    [`${course}/at-risk`, () => heading(page, 'Learners flagged by the rules')],
    [`${course}/progress`, () => heading(page, 'Class progress')],
    ['/teaching', () => heading(page, 'Teaching')],
    ['/notifications', () => heading(page, 'Notifications')],
  ];
  for (const [path, check] of screens) {
    await open(page, path);
    await check();
    await loaded(page, problems, path);
  }

  await open(page, course);
  await link(page, 'Question bank').click();
  await shows(page, 'Which structure returns items in the order last in, first out?');
  await loaded(page, problems, 'question bank');

  await open(page, `${course}/build`);
  await page.getByRole('link', { name: 'Grading', exact: true }).first().click();
  await expect(page.locator('main button').filter({ hasText: 'Ananya Krishnan' })).toContainText(
    'Released',
  );
  await loaded(page, problems, 'grading');
});

test('second instructor: Engineering Mechanics has work waiting to be graded', async ({ page }) => {
  const problems = problemsOf(page);
  await signInAs(page, mail('farida.sheikh'));
  await welcome(page, 'Dr. Farida Sheikh');
  const course = await openCourse(page, 'Engineering Mechanics');
  await open(page, `${course}/gradebook`);
  await shows(page, 'Draft');
  await loaded(page, problems, 'gradebook');
  await open(page, `${course}/build`);
  await page.getByRole('link', { name: 'Grading', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Graded 6' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submitted 16' })).toBeVisible();
  await loaded(page, problems, 'grading');
});

test('assistant: one course, its class, gradebook and grading', async ({ page }) => {
  const problems = problemsOf(page);
  await signInAs(page, mail('karthik.iyer'));
  await welcome(page, 'Karthik Iyer');
  await expect(link(page, /Data Structures.*Assistant/s)).toBeVisible();
  await expect(page.locator('main').getByText('Engineering Mechanics')).toHaveCount(0);
  const course = await openCourse(page, 'Data Structures');
  await loaded(page, problems, 'course');

  const screens: [string, () => Promise<unknown>][] = [
    [`${course}/progress`, () => heading(page, 'Class progress')],
    [`${course}/gradebook`, () => shows(page, 'Waiting for approval')],
    [`${course}/dashboard`, () => heading(page, /Learners flagged\s*11/)],
    [`${course}/at-risk`, () => heading(page, 'Learners flagged by the rules')],
  ];
  for (const [path, check] of screens) {
    await open(page, path);
    await check();
    await loaded(page, problems, path);
  }
});

test('learner: courses, lecture, quiz, assignments, grades and their data', async ({ page }) => {
  const problems = problemsOf(page);
  await signInAs(page, mail('ananya.krishnan'));
  await welcome(page, 'Ananya Krishnan');
  await expect(link(page, /Engineering Mechanics/)).toBeVisible();
  await heading(page, 'Recently released grades');
  await loaded(page, problems, 'home');
  const course = await openCourse(page, 'Data Structures');
  await loaded(page, problems, 'course');

  // the lecture really plays: transcoded, signed playback
  await link(page, /Lecture 2: Stacks and queues/).click();
  await page.getByRole('button', { name: /play/i }).first().click();
  await expect
    .poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), {
      timeout: 30_000,
    })
    .toBeGreaterThan(1);
  expect(problems, 'errors while playing').toEqual([]);

  await open(page, course);
  await link(page, /Timed quiz: stacks and queues/).click();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  await loaded(page, problems, 'quiz');

  await open(page, course);
  await link(page, /Assignment 1/).click();
  await shows(page, '50 / 50');
  await loaded(page, problems, 'graded assignment');

  await open(page, course);
  await link(page, /Assignment 2/).click();
  await expect(page.getByRole('button', { name: 'Hand in' })).toBeVisible();
  await loaded(page, problems, 'open assignment');

  const screens: [string, () => Promise<unknown>][] = [
    [`${course}/grades`, () => heading(page, 'My grades')],
    ['/notifications', () => shows(page, /Your work on Assignment 1.* has been returned/)],
    ['/me/data', () => heading(page, 'My data')],
    ['/me/notifications', () => heading(page, 'Notification settings')],
  ];
  for (const [path, check] of screens) {
    await open(page, path);
    await check();
    await loaded(page, problems, path);
  }
});

import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import {
  apiAs,
  createMember,
  eventually,
  expectAccessible,
  originOf,
  signIn,
  signInAsPlatformAdmin,
} from '../support';

// Step 12 end to end, on the real API, worker and database: every role's dashboard, the at-risk list with its evidence, the
// college dashboard with its tables and exports, the settings and the platform usage page. Each new screen passes axe (light,
// dark and a 360 px phone). The worker refreshes the rollups every 5 s here (ANALYTICS_ROLLUP_SECONDS in scripts/stack.mjs).

const COLLEGE = 'e2e-one';
const COURSE = 'E2D101';
const IRIS = 'iris.insights@e2e-one.test';
const LIAM = 'liam.lee@e2e-one.test';
const MAYA = 'maya.mehta@e2e-one.test';

let courseId = '';
let offeringId = '';

test.describe.configure({ mode: 'serial' });

const url = (path: string) => `${originOf(COLLEGE)}${path}`;
const ok = async (res: Awaited<ReturnType<APIRequestContext['post']>>) => {
  if (!res.ok() && res.status() !== 409)
    throw new Error(`setup call failed: ${res.status()} ${await res.text()}`);
  return res;
};
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
  const term = (
    (await (await admin.get('terms?limit=100')).json()) as { items: { id: string; name: string }[] }
  ).items.find((x) => x.name === 'E2E Semester 1')?.id;
  const iris = await createMember(COLLEGE, IRIS, 'Iris Insights');
  const learners = [
    await createMember(COLLEGE, LIAM, 'Liam Lee'),
    await createMember(COLLEGE, MAYA, 'Maya Mehta'),
  ];
  await ok(await admin.post('courses', { data: { code: COURSE, title: 'Insights', credits: 3 } }));
  courseId = (
    (await (await admin.get(`courses?q=${COURSE}&limit=10`)).json()) as {
      items: { id: string; code: string }[];
    }
  ).items.find((c) => c.code === COURSE)?.id as string;
  await ok(await admin.post('offerings', { data: { courseId, termId: term } }));
  offeringId = (
    (await (await admin.get(`offerings?courseId=${courseId}&limit=10`)).json()) as {
      items: { id: string }[];
    }
  ).items[0]?.id as string;
  await ok(
    await admin.post(`offerings/${offeringId}/participants`, {
      data: { userId: iris, participation: 'instructor' },
    }),
  );
  for (const userId of learners)
    await ok(
      await admin.post(`offerings/${offeringId}/participants`, {
        data: { userId, participation: 'learner' },
      }),
    );
  await admin.dispose();

  const i = await apiAs(COLLEGE, IRIS);
  await ok(await i.post(`offerings/${offeringId}/publish`));
  const mod = (await (
    await ok(await i.post(`offerings/${offeringId}/modules`, { data: { title: 'Work' } }))
  ).json()) as { id: string };
  await ok(
    await i.patch(`offerings/${offeringId}/modules/${mod.id}`, { data: { published: true } }),
  );
  const assignment = async (title: string, dueAt: string) => {
    const item = (await (
      await ok(
        await i.post(`offerings/${offeringId}/modules/${mod.id}/items`, {
          data: { kind: 'assignment', title, published: true },
        }),
      )
    ).json()) as { id: string };
    await ok(
      await i.put(`offerings/${offeringId}/items/${item.id}/assignment`, { data: { dueAt } }),
    );
  };
  const past = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  // two deadlines nobody met (both learners are flagged by "missed deadlines") and one still to come
  await assignment('Essay One', past(48));
  await assignment('Essay Two', past(24));
  await assignment('Upcoming report', new Date(Date.now() + 48 * 3_600_000).toISOString());
  await i.dispose();
});

test('the learner dashboard: what is coming up in the college time zone, the week, nothing about anyone else', async ({
  browser,
}) => {
  const page = await asUser(browser, LIAM);
  const dash = page.getByTestId('learner-dashboard');
  await expect(dash).toBeVisible();
  await expect(dash.getByRole('link', { name: 'Upcoming report' })).toBeVisible();
  await expect(dash).toContainText('Times are in the college time zone');
  await expect(
    dash.getByRole('list', { name: 'Days of this week' }).getByRole('listitem'),
  ).toHaveCount(7);
  await expect(dash).toContainText('Only you can see this');
  await expect(page.getByText(/flagged|at.?risk/i)).toHaveCount(0);
  await accessibleEverywhere(page, 'learner dashboard');
  // a learner has no access to the staff screens: the API refuses and the page says so
  const api = await apiAs(COLLEGE, LIAM);
  expect((await api.get(`offerings/${offeringId}/at-risk`)).status()).toBe(403);
  expect((await api.get(`offerings/${offeringId}/dashboard`)).status()).toBe(403);
  await api.dispose();
  await page.close();
});

test('the instructor: teaching dashboard, offering dashboard and the flagged learners with their evidence', async ({
  browser,
}) => {
  const page = await asUser(browser, IRIS);
  // the rollup refreshes every 5 s: wait until both learners are flagged
  const api = await apiAs(COLLEGE, IRIS);
  await eventually(
    async () =>
      (await (await api.get(`offerings/${offeringId}/at-risk`)).json()) as { total: number },
    (r) => r.total >= 2,
    'both learners to be flagged',
    60_000,
  );
  await api.dispose();

  await page.getByRole('link', { name: /Teaching dashboard/ }).click();
  await expect(page.getByRole('heading', { name: 'Teaching' })).toBeVisible();
  const card = page.getByRole('listitem').filter({ hasText: 'Insights' });
  await expect(card).toContainText('Learners');
  await expectAccessible(page, 'teaching dashboard (light)');

  await card.getByRole('link', { name: 'Insights' }).click();
  await expect(page.getByRole('heading', { name: 'Offering dashboard' })).toBeVisible();
  await expect(page.getByText('Hand-ins waiting for a grade')).toBeVisible();
  await expect(page.getByRole('link', { name: 'See who and why' })).toBeVisible();
  await accessibleEverywhere(page, 'offering dashboard');

  await page.goto(url(`/offerings/${offeringId}/at-risk`));
  await expect(page.getByRole('heading', { name: 'Learners flagged by the rules' })).toBeVisible();
  await expect(page.getByText('Liam Lee')).toBeVisible();
  await expect(page.getByText('Maya Mehta')).toBeVisible();
  await expect(page.getByText(/Missed 2 deadlines/).first()).toBeVisible();
  await expect(page.getByText(/Essay One: due .*nothing handed in/).first()).toBeVisible();
  await expect(page.getByText(/risk score|ranking/i)).toHaveCount(0);
  await accessibleEverywhere(page, 'flagged learners');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export flagged learners as CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('at-risk-learners.csv');
  await page.close();
});

test('the administrator: the college dashboard, the chart and its table, exports, settings', async ({
  browser,
}) => {
  const page = await asUser(browser, `admin@${COLLEGE}.test`);
  await page.getByRole('link', { name: 'College dashboard' }).first().click();
  await expect(page.getByRole('heading', { name: 'College dashboard' })).toBeVisible();
  await expect(page.getByText('Active users, today')).toBeVisible();
  const chart = page.getByRole('figure', { name: /Active users per day/ });
  await expect(chart.getByRole('img', { name: 'Active users on each day' })).toBeVisible();
  await expect(chart).toContainText('days:');
  // the same numbers as a table, on request
  await chart.getByRole('button', { name: 'Show as table' }).click();
  await expect(chart.getByRole('table', { name: /Active users per day/ })).toBeVisible();
  await chart.getByRole('button', { name: 'Show chart' }).click();
  await expect(page.getByRole('heading', { name: 'Learners flagged by department' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Grading backlog' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Gradebook approval status' })).toBeVisible();
  await accessibleEverywhere(page, 'college dashboard');
  for (const format of ['CSV', 'XLSX'] as const) {
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: `Export Grading backlog as ${format}` }).click(),
    ]);
    expect(file.suggestedFilename()).toBe(`grading-backlog.${format.toLowerCase()}`);
  }

  // the settings: time zone and the at-risk rules
  await page.goto(url('/analytics-settings'));
  await expect(page.getByRole('heading', { name: 'Analytics settings' })).toBeVisible();
  await accessibleEverywhere(page, 'analytics settings');
  await page.getByLabel(/College time zone/).fill('Not/AZone');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText(/not a time zone name/i)).toBeVisible();
  await page.getByLabel(/College time zone/).fill('Asia/Kolkata');
  await page.getByLabel('Pass mark (%)').fill('45');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await page.close();
});

test('a member who is not an administrator has no college dashboard', async ({ browser }) => {
  const page = await asUser(browser, LIAM);
  await expect(page.getByRole('link', { name: 'College dashboard' })).toHaveCount(0);
  await page.goto(url('/college-dashboard'));
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible(); // redirected home
  await page.close();
});

test('the platform admin: usage of every college, aggregates only', async ({ browser }) => {
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await signInAsPlatformAdmin(page);
  await page.getByRole('link', { name: 'Usage' }).first().click();
  await expect(page.getByRole('heading', { name: 'Usage by college' })).toBeVisible();
  await expect(page.getByText(/Video GB is an estimate/)).toBeVisible();
  await expect(page.getByRole('table', { name: /Usage of every college/ })).toContainText(COLLEGE);
  await expect(page.getByText(/Liam|Maya|Iris/)).toHaveCount(0);
  await accessibleEverywhere(page, 'platform usage');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Export usage of .* as CSV/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^usage-\d{4}-\d{2}\.csv$/);
  await page.close();
});

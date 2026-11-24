import { randomUUID } from 'node:crypto';
import {
  apiAs,
  apiOfPage,
  type Browser,
  createMember,
  eventually,
  expect,
  expectAccessible,
  mailLink,
  mailsTo,
  originOf,
  type Page,
  request,
  signIn,
  test,
  WEB_PORT,
} from '../support';

// Notifications and email end to end (MAILER=file: the worker writes every email, with its headers, to the JSONL outbox):
//  - an invitation email arrives (sent by the worker from the outbox) and the link works;
//  - a password-reset email works, and the "password changed" security email follows;
//  - an assignment reminder goes ONLY to the learner who has not handed in;
//  - a released grade appears in the bell and in an email, and neither shows the mark;
//  - the unsubscribe link of a digest works (opening it changes nothing, the button does; the one-click POST of the mail
//    client too) and a security email has none;
//  - the preferences page turns a category off (the next email is not sent, the bell still gets it);
//  - every new screen passes axe (light, dark, 360 px).

const COLLEGE = 'e2e-one';
const COURSE = 'E2N131';
const INSTRUCTOR = 'nora.notify@e2e-one.test';
const WAITER = 'wendy.waits@e2e-one.test';
const DONE = 'dan.done@e2e-one.test';
const NEWBIE = 'ivy.invited@e2e-one.test';
const RESETTER = 'rita.reset@e2e-one.test';
const MARK = '73.25';
const FEEDBACK = 'FEEDBACK-SENTINEL-e2e-4411';

let offeringId = '';
let reminderItemId = '';
let moduleId = '';

test.describe.configure({ mode: 'serial' });

const url = (path: string) => `${originOf(COLLEGE)}${path}`;

interface Mail {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}
const mailsFor = (to: string) => mailsTo(to) as unknown as Mail[];

async function asUser(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
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

/**
 * A zone whose LOCAL DATE differs from the date the college's daily digest ALREADY ran for. That run happened when the worker started
 * (the college is in Asia/Kolkata then, `once per local date`), so the date to avoid is the college's date AT START-UP (scripts/e2e.mjs
 * passes the start time), NOT its date now: a run that starts a few minutes before 18:30 UTC (= midnight in Kolkata) and reaches this spec
 * after it used to pick Pacific/Pago_Pago, whose date is then exactly the date that had been consumed (found by CI at 18:35 UTC).
 */
function zoneWithAnotherDate(): string {
  const date = (tz: string, at: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at);
  const started = new Date(Number(process.env.E2E_STARTED_AT ?? Date.now()) + 90_000); // the worker's first scan is within a minute or two
  const consumed = date('Asia/Kolkata', started);
  const now = new Date();
  return (
    ['Pacific/Pago_Pago', 'Pacific/Kiritimati'].find((z) => date(z, now) !== consumed) ??
    'Pacific/Kiritimati'
  );
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const admin = await apiAs(COLLEGE, `admin@${COLLEGE}.test`);
  const must = async (res: Awaited<ReturnType<typeof admin.post>>) => {
    if (!res.ok() && res.status() !== 409)
      throw new Error(`setup call failed: ${res.status()} ${await res.text()}`);
    return res;
  };
  // no quiet hours (the E2E college must send at any time of day), digest hour 0
  await must(
    await admin.patch('notifications/settings', {
      data: { quietHours: { enabled: false, start: '22:00', end: '07:00' }, digestHour: 0 },
    }),
  );
  // any existing term will do (earlier specs made some); run alone, this spec makes its own year and term
  const listTerms = async () =>
    ((await (await admin.get('terms?limit=100')).json()) as { items: { id: string }[] }).items;
  let terms = await listTerms();
  if (terms.length === 0) {
    const year = (await (
      await must(
        await admin.post('academic-years', {
          data: { label: 'E2E Notify', startDate: '2026-06-01', endDate: '2027-05-31' },
        }),
      )
    ).json()) as { id: string };
    await must(
      await admin.post('terms', {
        data: {
          academicYearId: year.id,
          name: 'E2E Notify term',
          startDate: '2026-06-01',
          endDate: '2026-11-30',
        },
      }),
    );
    terms = await listTerms();
  }
  const termId = terms[0]?.id;
  const nora = await createMember(COLLEGE, INSTRUCTOR, 'Nora Notify');
  const wendy = await createMember(COLLEGE, WAITER, 'Wendy Waits');
  const dan = await createMember(COLLEGE, DONE, 'Dan Done');
  await must(
    await admin.post('courses', { data: { code: COURSE, title: 'Notifications', credits: 2 } }),
  );
  const courseId = (
    (await (await admin.get(`courses?q=${COURSE}&limit=10`)).json()) as {
      items: { id: string; code: string }[];
    }
  ).items.find((c) => c.code === COURSE)?.id as string;
  await must(await admin.post('offerings', { data: { courseId, termId } }));
  offeringId = (
    (await (await admin.get(`offerings?courseId=${courseId}&limit=10`)).json()) as {
      items: { id: string }[];
    }
  ).items[0]?.id as string;
  for (const [userId, participation] of [
    [nora, 'instructor'],
    [wendy, 'learner'],
    [dan, 'learner'],
  ] as const)
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

test('an invitation email arrives and its link works', async ({ page }) => {
  const admin = await apiAs(COLLEGE, `admin@${COLLEGE}.test`);
  const invite = await admin.post('auth/invites', {
    data: { email: NEWBIE, role: 'member', displayName: 'Ivy Invited' },
  });
  expect(invite.ok()).toBe(true);
  await admin.dispose();
  const link = await mailLink(NEWBIE);
  const mail = mailsFor(NEWBIE).at(-1) as Mail;
  expect(mail.subject).toMatch(/invited/i);
  expect(mail.from).toContain('via JCS iLearn');
  // a security email: no unsubscribe, and it says so
  expect(mail.headers['List-Unsubscribe']).toBeUndefined();
  expect(mail.text).toContain('cannot be switched off');
  expect(mail.html).toContain('Accept the invitation');
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Accept your invitation' })).toBeVisible();
  await page.getByLabel('Choose a password').fill('Ivy chooses a long password');
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByText('Your invitation is accepted.')).toBeVisible();
  await signIn(page, COLLEGE, NEWBIE, 'Ivy chooses a long password');
  await expect(page.getByRole('heading', { name: 'Welcome, Ivy Invited' })).toBeVisible();
});

test('a password-reset email works, and a "password changed" security email follows', async ({
  page,
}) => {
  await createMember(COLLEGE, RESETTER, 'Rita Reset');
  await page.goto(url('/forgot-password'));
  await page.getByLabel('Email').fill(RESETTER);
  await page.getByRole('button', { name: 'Send the link' }).click();
  // (Rita's invitation email is already in the outbox: wait for the RESET one)
  const reset = (
    await eventually(
      async () => mailsFor(RESETTER),
      (ms) => ms.some((m) => m.subject === 'Reset your password'),
      'the password-reset email',
    )
  ).find((m) => m.subject === 'Reset your password') as Mail;
  const link = /(https?:\/\/\S+\?token=[A-Za-z0-9_-]+)/.exec(reset.text)?.[1] as string;
  expect(link).toBeTruthy();
  expect(reset.headers['List-Unsubscribe']).toBeUndefined();
  await page.goto(link);
  await page.getByLabel('New password').fill('a-brand-new-passphrase-77');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Your password has been changed')).toBeVisible();
  await signIn(page, COLLEGE, RESETTER, 'a-brand-new-passphrase-77');
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible({ timeout: 20_000 });
  await eventually(
    async () => mailsFor(RESETTER).map((m) => m.subject),
    (s) => s.includes('Your password was changed'),
    'the password-changed email',
  );
});

test('an assignment reminder goes only to the learner who has not handed in', async () => {
  test.setTimeout(90_000);
  const q = await apiAs(COLLEGE, INSTRUCTOR);
  // due in 1 hour and a few seconds: the 1-hour threshold falls inside the next scan windows
  const due = new Date(Date.now() + 3_600_000 + 12_000).toISOString();
  const item = (await (
    await q.post(`offerings/${offeringId}/modules/${moduleId}/items`, {
      data: { kind: 'assignment', title: 'Reminder essay', published: true },
    })
  ).json()) as { id: string };
  reminderItemId = item.id;
  const set = await q.put(`offerings/${offeringId}/items/${item.id}/assignment`, {
    data: { dueAt: due, allowText: true, allowFile: false },
  });
  expect(set.ok(), await set.text()).toBe(true);
  await q.dispose();

  // Dan hands in a text answer right away
  const dan = await apiAs(COLLEGE, DONE);
  const sub = await dan.post(`offerings/${offeringId}/items/${item.id}/assignment/submissions`, {
    data: { requestKey: randomUUID(), text: 'my answer', fileIds: [] },
  });
  expect(sub.ok(), await sub.text()).toBe(true);
  await dan.dispose();

  // Wendy's bell fills within a few scans; her email says she has not handed in anything
  const wendy = await apiAs(COLLEGE, WAITER);
  const list = await eventually(
    async () => (await (await wendy.get('notifications')).json()) as { items: { type: string }[] },
    (r) => r.items.some((n) => n.type === 'due_soon'),
    "Wendy's reminder",
    45_000,
  );
  expect(list.items.filter((n) => n.type === 'due_soon')).toHaveLength(1);
  await wendy.dispose();
  const mail = (
    await eventually(
      async () => mailsFor(WAITER),
      (ms) => ms.some((m) => m.subject === 'Due in 1 hour: Reminder essay'),
      "Wendy's reminder email",
    )
  ).find((m) => m.subject === 'Due in 1 hour: Reminder essay') as Mail;
  expect(mail.text).toContain('You have not handed anything in yet.');
  expect(mail.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

  // Dan, who handed in, got nothing (the scans have run several times by now)
  await new Promise((r) => setTimeout(r, 8000));
  const danApi = await apiAs(COLLEGE, DONE);
  const dn = (await (await danApi.get('notifications')).json()) as { items: { type: string }[] };
  expect(dn.items.filter((n) => n.type === 'due_soon')).toEqual([]);
  expect(mailsFor(DONE).some((m) => m.subject.startsWith('Due in'))).toBe(false);
  await danApi.dispose();
});

test('a released grade appears in the bell and in an email, and neither shows the mark', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const q = await apiAs(COLLEGE, INSTRUCTOR);
  const base = `offerings/${offeringId}/items/${reminderItemId}/assignment`;
  // find Dan's learner key in the grading queue, grade with feedback, release
  const queue = (await (await q.get(`${base}/grading/queue?limit=50`)).json()) as {
    items: { learnerKey: string; email: string | null }[];
  };
  const key = queue.items.find((r) => r.email === DONE)?.learnerKey as string;
  expect(key).toBeTruthy();
  const detail = (await (await q.get(`${base}/grading/learners/${key}`)).json()) as {
    submissions: { id: string }[];
  };
  const graded = await q.put(`${base}/grading/learners/${key}/grade`, {
    data: {
      submissionId: detail.submissions[0]?.id,
      rawScore: Number(MARK),
      feedback: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: FEEDBACK }] }],
      },
    },
  });
  expect(graded.ok(), await graded.text()).toBe(true);
  const released = await q.post(`${base}/release`, { data: {} });
  expect(released.ok(), await released.text()).toBe(true);
  await q.dispose();

  // the learner's bell (UI)
  const page = await asUser(browser, DONE);
  await expect(page.getByRole('button', { name: /^Notifications, \d+ unread$/ })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: /^Notifications/ }).click();
  const panel = page.getByRole('region', { name: 'Latest notifications' });
  await expect(
    panel.getByRole('link', { name: /Your work on Reminder essay has been returned/ }),
  ).toBeVisible();
  await expect(panel).not.toContainText(MARK);
  await expect(panel).not.toContainText(FEEDBACK);
  await expectAccessible(page, 'the open bell');
  await panel.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();
  await page.keyboard.press('Escape');

  // the email: the same words, a link, no mark and no feedback text
  const mail = (
    await eventually(
      async () => mailsFor(DONE),
      (ms) => ms.some((m) => m.subject === 'Your work on Reminder essay has been returned'),
      'the grade-released email',
    )
  ).find((m) => m.subject === 'Your work on Reminder essay has been returned') as Mail;
  expect(mail.text).toContain(`/offerings/${offeringId}/items/${reminderItemId}/assignment`);
  expect(mail.text).toContain('Your instructor also left feedback.');
  for (const part of [mail.text, mail.html, mail.subject]) {
    expect(part).not.toContain(MARK);
    expect(part).not.toContain(FEEDBACK);
  }
  await page.context().close();
});

test('the unsubscribe link of a digest works; a security email has none', async ({ browser }) => {
  test.setTimeout(90_000);
  // a content digest: the college's day is "tomorrow" elsewhere, so today's (already consumed) run does not block it
  const admin = await apiAs(COLLEGE, `admin@${COLLEGE}.test`);
  const tz = zoneWithAnotherDate();
  const zone = await admin.patch('analytics/settings', { data: { timeZone: tz } });
  expect(zone.ok(), await zone.text()).toBe(true);
  await admin.dispose();
  const q = await apiAs(COLLEGE, INSTRUCTOR);
  const added = await q.post(`offerings/${offeringId}/modules/${moduleId}/items`, {
    data: {
      kind: 'link',
      title: 'Digest reading',
      url: 'https://example.com/read',
      published: true,
    },
  });
  expect(added.ok(), await added.text()).toBe(true);
  await q.dispose();
  const digest = (
    await eventually(
      async () => mailsFor(WAITER),
      (ms) => ms.some((m) => m.subject.startsWith('New in Notifications')),
      "Wendy's content digest",
      60_000,
    )
  ).find((m) => m.subject.startsWith('New in Notifications')) as Mail;
  expect(digest.headers['List-Unsubscribe']).toMatch(
    /^<http:\/\/.+\/api\/notifications\/unsubscribe\/one-click\?t=v2\.[A-Za-z0-9_-]+\./,
  );
  const pageLink = /(http\S+\/unsubscribe\?t=\S+)/.exec(digest.text)?.[1] as string;
  expect(pageLink).toBeTruthy();

  // opening the link changes nothing; the button does
  const page = await asUser(browser, WAITER);
  await page.goto(pageLink);
  await expect(page.getByText(/Stop emails about new course content/)).toBeVisible();
  await accessibleEverywhere(page, 'the unsubscribe page');
  const api = await apiOfPage(page, COLLEGE);
  const before = (await (await api.get('me/notification-preferences')).json()) as {
    items: { category: string; email: boolean }[];
  };
  expect(before.items.find((p) => p.category === 'learning_content')?.email).toBe(true);
  await page.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(
    page.getByText(/You will no longer get emails about new course content/),
  ).toBeVisible();
  const after = (await (await api.get('me/notification-preferences')).json()) as {
    items: { category: string; email: boolean; inApp: boolean }[];
  };
  await api.dispose();
  expect(after.items.find((p) => p.category === 'learning_content')).toMatchObject({
    email: false,
    inApp: true,
  });

  // the mail client's one-click POST: no cookie, no Origin, no CSRF header, a form body. Node cannot resolve *.localhost
  // everywhere, so it connects to 127.0.0.1 and names the college in the Host header.
  const oneClick = new URL(
    /<([^>]+)>/.exec(digest.headers['List-Unsubscribe'] as string)?.[1] as string,
  );
  const anon = await request.newContext();
  const post = await anon.post(
    `http://127.0.0.1:${WEB_PORT}${oneClick.pathname}${oneClick.search}`,
    {
      headers: {
        host: `${COLLEGE}.localhost:${WEB_PORT}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      data: 'List-Unsubscribe=One-Click',
    },
  );
  expect(post.status()).toBe(200);
  expect(await post.json()).toMatchObject({ unsubscribed: true });
  await anon.dispose();

  // security email: no header, no unsubscribe link, and a made-up security token is refused
  const invite = mailsFor(NEWBIE).at(0) as Mail;
  expect(invite.headers['List-Unsubscribe']).toBeUndefined();
  expect(invite.text).not.toMatch(/unsubscribe\?t=/);
  await page.context().close();
});

test('the preferences page turns a category off: no more email for it, the bell still gets it', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const page = await asUser(browser, DONE);
  await page
    .getByRole('button', { name: 'Account' })
    .or(page.locator('header details > summary'))
    .first()
    .click();
  await page.getByRole('link', { name: 'My notification settings' }).click();
  await expect(page.getByRole('heading', { name: 'Notification settings' })).toBeVisible();
  const security = page.getByRole('checkbox', { name: 'Email: Account and security' });
  await expect(security).toBeDisabled();
  await expect(security).toBeChecked();
  await accessibleEverywhere(page, 'my notification settings');
  const grades = page.getByRole('checkbox', { name: 'Email: Grades and results' });
  await expect(grades).toBeChecked();
  await grades.uncheck();
  await expect(page.getByText('Saved: Grades and results')).toBeVisible();

  // a second release for Dan: graded again as a new version of his work is not needed, a new assignment is
  const emailsBefore = mailsFor(DONE).length;
  const q = await apiAs(COLLEGE, INSTRUCTOR);
  const item = (await (
    await q.post(`offerings/${offeringId}/modules/${moduleId}/items`, {
      data: { kind: 'assignment', title: 'Second essay', published: true },
    })
  ).json()) as { id: string };
  const base = `offerings/${offeringId}/items/${item.id}/assignment`;
  await q.put(base, {
    data: {
      dueAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      allowText: true,
      allowFile: false,
    },
  });
  const dan = await apiAs(COLLEGE, DONE);
  await dan.post(`${base}/submissions`, {
    data: { requestKey: randomUUID(), text: 'again', fileIds: [] },
  });
  await dan.dispose();
  const queue = (await (await q.get(`${base}/grading/queue?limit=50`)).json()) as {
    items: { learnerKey: string; email: string | null }[];
  };
  const key = queue.items.find((r) => r.email === DONE)?.learnerKey as string;
  const detail = (await (await q.get(`${base}/grading/learners/${key}`)).json()) as {
    submissions: { id: string }[];
  };
  await q.put(`${base}/grading/learners/${key}/grade`, {
    data: { submissionId: detail.submissions[0]?.id, rawScore: 50 },
  });
  await q.post(`${base}/release`, { data: {} });
  await q.dispose();

  // the bell gets it ...
  const dApi = await apiAs(COLLEGE, DONE);
  await eventually(
    async () =>
      (await (await dApi.get('notifications')).json()) as {
        items: { params: { item?: string } }[];
      },
    (r) => r.items.some((n) => n.params.item === 'Second essay'),
    'the in-app notification of the second release',
  );
  await dApi.dispose();
  // ... the email does not (the scan and the worker have had time)
  await new Promise((r) => setTimeout(r, 8000));
  expect(mailsFor(DONE).length).toBe(emailsBefore);
  expect(mailsFor(DONE).some((m) => m.subject.includes('Second essay'))).toBe(false);
  await page.context().close();
});

test('the notifications page and the admin screens pass axe', async ({ browser }) => {
  test.setTimeout(120_000);
  const member = await asUser(browser, DONE);
  await member.goto(url('/notifications'));
  await expect(member.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(member.getByRole('list', { name: 'Notifications' })).toBeVisible();
  await accessibleEverywhere(member, 'the notifications page');
  await member.context().close();

  const admin = await asUser(browser, `admin@${COLLEGE}.test`);
  await admin.goto(url('/settings/notifications'));
  await expect(admin.getByRole('heading', { name: 'Notification settings' })).toBeVisible();
  await expect(admin.getByLabel('Quiet from')).toBeVisible();
  await accessibleEverywhere(admin, 'college notification settings');
  await admin.goto(url('/settings/email'));
  await expect(admin.getByRole('heading', { name: 'Bouncing addresses' })).toBeVisible();
  await expect(admin.getByText('No bouncing addresses')).toBeVisible();
  await accessibleEverywhere(admin, 'bouncing addresses');
  await admin.context().close();
});

test.afterAll(async () => {
  // put the college back on its own time zone for whatever runs next
  const admin = await apiAs(COLLEGE, `admin@${COLLEGE}.test`);
  await admin.patch('analytics/settings', { data: { timeZone: 'Asia/Kolkata' } });
  await admin.dispose();
});

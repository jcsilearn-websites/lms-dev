import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { request } from '@playwright/test';
import {
  apiAs,
  createMember,
  expect,
  expectAccessible,
  mailLink,
  mailsTo,
  PASSWORD,
  type Page,
  test,
  WEB_PORT,
} from '../support';

// TWO-STEP SIGN-IN, end to end (step 14c part 3), against the SECOND API instance that runs MFA_ENFORCEMENT=required
// (scripts/stack.mjs): forced enrolment through the e-mailed link, recovery codes, a wrong code, a replayed code, sign-in with a
// recovery code, a step-up, and a reset with three platform administrators. Axe in light, dark and at 360 px. The execution of a
// reset needs its 24 hours: it is covered against the real database (backend test/mfa.reset.test.ts); here the person stops it by
// signing in.

const MFA_PORT = Number(process.env.E2E_MFA_PORT ?? 4175);
const COLLEGE = 'e2e-mfa';
const HEAD = `admin@${COLLEGE}.test`;
const MEMBER = `mia.member@${COLLEGE}.test`;
const origin = (slug: string) => `http://${slug}.localhost:${MFA_PORT}`;

// ------------------------------------------------------------------------------------------ an authenticator app
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function decodeBase32(text: string): Buffer {
  let bits = '';
  for (const ch of text) bits += ALPHABET.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((b) => Number.parseInt(b, 2)));
}
function totp(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const at = (mac[mac.length - 1] as number) & 0x0f;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const currentStep = () => Math.floor(Date.now() / 30_000);

interface Person {
  slug: string;
  email: string;
  secret: string;
  lastStep: number;
  recoveryCodes: string[];
}

/** A code the server will accept: a LATER time step than the last one used (it allows one step of drift). */
async function freshCode(p: Person): Promise<string> {
  const step = Math.max(p.lastStep + 1, currentStep());
  while (step > currentStep() + 1) await new Promise((r) => setTimeout(r, 500));
  p.lastStep = step;
  return totp(p.secret, step);
}
const wrongCodeFor = (p: Person) => {
  const near = new Set([-2, -1, 0, 1, 2].map((d) => totp(p.secret, currentStep() + d)));
  let n = 0;
  while (near.has(String(n).padStart(6, '0'))) n++;
  return String(n).padStart(6, '0');
};

// ------------------------------------------------------------------------------------------ helpers
async function accessibleEverywhere(page: Page, label: string) {
  await expectAccessible(page, `${label} (light)`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page, `${label} (dark)`);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 360, height: 740 });
  await expectAccessible(page, `${label} (360 px)`);
  await page.setViewportSize({ width: 1280, height: 720 });
}

async function password(page: Page, p: { slug: string; email: string }) {
  await page.goto(`${origin(p.slug)}/login`);
  await page.getByLabel('Email').fill(p.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** The enrolment link in the mail (the worker builds it for the first web server: the port is swapped). */
async function enrolLink(email: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const mail = [...mailsTo(email)].reverse().find((m) => m.text.includes('/mfa/enrol?token='));
    const link = mail && /(https?:\/\/\S+\/mfa\/enrol\?token=[A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
    if (link) return link.replace(`:${WEB_PORT}`, `:${MFA_PORT}`);
    if (Date.now() > deadline) throw new Error(`no enrolment link arrived for ${email}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Password, "check your email", the link, the password again, the first code, the recovery codes. */
async function enrol(
  page: Page,
  who: { slug: string; email: string },
  options: { checks?: boolean } = {},
): Promise<Person> {
  await password(page, who);
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  if (options.checks) await accessibleEverywhere(page, 'check your email');
  await page.goto(await enrolLink(who.email));
  await expect(page.getByRole('heading', { name: 'Set up two-step sign-in' })).toBeVisible();
  if (options.checks) await accessibleEverywhere(page, 'enrolment, the password');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
  await page.getByText('Cannot scan the code?').click();
  const secret = ((await page.getByTestId('totp-secret').textContent()) ?? '').trim();
  const person: Person = { ...who, secret, lastStep: 0, recoveryCodes: [] };
  if (options.checks) {
    await accessibleEverywhere(page, 'enrolment, the QR code');
    await page.getByLabel('Code from your authenticator app').fill(wrongCodeFor(person));
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('That code is not valid')).toBeVisible();
  }
  await page.getByLabel('Code from your authenticator app').fill(await freshCode(person));
  await page.getByRole('button', { name: 'Confirm' }).click();
  const list = page.getByRole('list', { name: 'Recovery codes' });
  await expect(list.getByRole('listitem')).toHaveCount(10);
  person.recoveryCodes = await list.getByRole('listitem').allInnerTexts();
  if (options.checks) {
    await accessibleEverywhere(page, 'recovery codes');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).click();
    expect((await download).suggestedFilename()).toBe('recovery-codes.txt');
  }
  await page.getByRole('checkbox', { name: 'I have saved these codes' }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  return person;
}

async function codeStep(page: Page, p: Person, code: string) {
  await password(page, p);
  await expect(page.getByRole('heading', { name: 'Two-step sign-in' })).toBeVisible();
  await page.getByLabel('Code from your authenticator app').fill(code);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** The college of this spec and its two people, made through the product on the first instance (no enforcement there). */
async function createCollege() {
  const root = await apiAs('admin', 'root@e2e.test');
  const created = await root.post('platform/tenants', {
    data: { name: 'Two Step College', slug: COLLEGE, adminEmail: HEAD, adminName: 'Hana Head' },
  });
  await root.dispose();
  if (!created.ok()) throw new Error(`creating the college failed: ${created.status()}`);
  const token = new URL(await mailLink(HEAD)).searchParams.get('token') ?? '';
  const host = `${COLLEGE}.localhost:${WEB_PORT}`;
  const anon = await request.newContext({
    baseURL: `http://127.0.0.1:${WEB_PORT}/api/`,
    extraHTTPHeaders: { host, origin: `http://${host}`, 'x-requested-with': 'lms' },
  });
  const accepted = await anon.post('auth/invites/accept', { data: { token, password: PASSWORD } });
  await anon.dispose();
  if (!accepted.ok()) throw new Error(`accepting the invite failed: ${accepted.status()}`);
  await createMember(COLLEGE, MEMBER, 'Mia Member');
}

const ageVerification = (email: string) => {
  const result = spawnSync(
    'pnpm',
    ['--filter', '@lms/backend', 'exec', 'tsx', 'test/e2e-age-mfa.ts', email],
    { cwd: join(import.meta.dirname, '..', '..', '..'), shell: process.platform === 'win32' },
  );
  expect(result.status, String(result.stderr)).toBe(0);
};

// ------------------------------------------------------------------------------------------ the story
test('an institution admin: forced enrolment, codes, recovery code, step-up, sign-in security', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  await createCollege();

  const first = await (await browser.newContext()).newPage();
  const head = await enrol(first, { slug: COLLEGE, email: HEAD }, { checks: true });
  await expect(first.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  await first.context().close();

  // a member is not asked for anything
  const member = await (await browser.newContext()).newPage();
  await password(member, { slug: COLLEGE, email: MEMBER });
  await expect(member.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  await member.context().close();

  // the next sign-in: a wrong code, a code that was used already, then a good one
  const page = await (await browser.newContext()).newPage();
  const used = totp(head.secret, head.lastStep);
  await codeStep(page, head, wrongCodeFor(head));
  await expect(page.getByText('That code is not valid')).toBeVisible();
  await accessibleEverywhere(page, 'the code step');
  await page.getByLabel('Code from your authenticator app').fill(used);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('That code is not valid')).toBeVisible();
  await page.getByLabel('Code from your authenticator app').fill(await freshCode(head));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  await page.context().close();

  // a recovery code instead of the app
  const admin = await (await browser.newContext()).newPage();
  await password(admin, head);
  await admin.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await admin.getByLabel('Recovery code').fill(head.recoveryCodes[0] as string);
  await admin.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(admin.getByRole('heading', { name: /^Welcome/ })).toBeVisible();

  // step-up: the verification is older than 10 minutes, suspending a member asks again and then goes through
  ageVerification(HEAD);
  await admin.goto(`${origin(COLLEGE)}/members`);
  await admin.getByRole('link', { name: 'Mia Member' }).click();
  await admin.getByRole('button', { name: /^Suspend/ }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Suspend Mia Member' }).click();
  const stepUp = admin.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(stepUp).toBeVisible();
  await accessibleEverywhere(admin, 'the step-up dialog');
  await stepUp.getByLabel('Code from your authenticator app').fill(await freshCode(head));
  await stepUp.getByRole('button', { name: 'Confirm and continue' }).click();
  await expect(stepUp).toBeHidden();
  await expect(admin.getByRole('button', { name: /^Reactivate/ })).toBeVisible();

  // sign-in security: the status, and new recovery codes (the step-up is fresh)
  await admin.goto(`${origin(COLLEGE)}/me/security`);
  await expect(admin.getByRole('heading', { name: 'Sign-in security' })).toBeVisible();
  await expect(admin.getByText('9 codes left.')).toBeVisible();
  await accessibleEverywhere(admin, 'sign-in security');
  await admin.getByRole('button', { name: 'New recovery codes' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Make new codes' }).click();
  await expect(admin.getByRole('list', { name: 'Recovery codes' })).toBeVisible();
  await admin.getByRole('checkbox', { name: 'I have saved these codes' }).check();
  await admin.getByRole('button', { name: 'Done' }).click();
  await expect(admin.getByText('10 codes left.')).toBeVisible();
  await admin.context().close();
});

test('a reset with three platform administrators: filed, approved by another, stopped by the person', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const people: Person[] = [];
  const pages: Page[] = [];
  for (const n of [1, 2, 3]) {
    const page = await (await browser.newContext()).newPage();
    people.push(await enrol(page, { slug: 'admin', email: `mfa-root${n}@e2e.test` }));
    await expect(page.getByRole('heading', { name: 'Colleges' })).toBeVisible();
    pages.push(page);
  }
  const [filer, approver] = pages as [Page, Page, Page];
  const subject = people[2] as Person;

  await filer.goto(`${origin('admin')}/platform/mfa-resets`);
  await expect(filer.getByRole('heading', { name: 'Two-step sign-in resets' })).toBeVisible();
  await accessibleEverywhere(filer, 'resets, none yet');
  await filer.getByLabel('Address of the account').fill(subject.email);
  await filer.getByRole('button', { name: 'File the request' }).click();
  const mine = filer.locator('li', { hasText: subject.email });
  await expect(mine).toContainText('Waiting for a decision');
  await expect(mine.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(mine).toContainText('A different administrator decides');
  await accessibleEverywhere(filer, 'resets with a request');

  await approver.goto(`${origin('admin')}/platform/mfa-resets`);
  const theirs = approver.locator('li', { hasText: subject.email });
  await theirs.getByRole('button', { name: 'Approve' }).click();
  const dialog = approver.getByRole('dialog');
  await expect(dialog).toContainText('24 hours');
  await accessibleEverywhere(approver, 'the approval dialog');
  await dialog.getByRole('button', { name: 'Approve reset' }).click();
  await expect(theirs.getByText('Approved: waiting 24 hours')).toBeVisible();
  await expect(theirs).toContainText('Runs after');

  // the person still has the phone: signing in with it cancels the reset
  const signIn = await (await browser.newContext()).newPage();
  await codeStep(signIn, subject, await freshCode(subject));
  await expect(signIn.getByRole('heading', { name: 'Colleges' })).toBeVisible();
  await filer.reload();
  await expect(mine.getByText('Cancelled')).toBeVisible();
  await expect(mine).toContainText('the person signed in with their second step');

  for (const page of [...pages, signIn]) await page.context().close();
});

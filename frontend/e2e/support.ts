import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Page, request } from '@playwright/test';

export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4173);
export const PASSWORD = process.env.E2E_PASSWORD ?? 'correct-horse-battery-staple';
const MAIL_FILE = process.env.E2E_MAIL_FILE ?? '';

/** http://<host>.localhost:4173 - a college (slug) or the platform area ("admin"). */
export const originOf = (slug: string) => `http://${slug}.localhost:${WEB_PORT}`;

// ------------------------------------------------------------------------------------------ signing in
export async function signIn(page: Page, slug: string, email: string, password = PASSWORD) {
  await page.goto(`${originOf(slug)}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Platform admin on admin.localhost: waits until the colleges list is showing. */
export async function signInAsPlatformAdmin(page: Page) {
  await signIn(page, 'admin', 'root@e2e.test');
  await expect(page.getByRole('heading', { name: 'Colleges' })).toBeVisible();
}

export async function signInAsAdmin(page: Page, slug = 'e2e-one') {
  await signIn(page, slug, `admin@${slug}.test`);
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
}

// ------------------------------------------------------------------------------------------ mail outbox
interface Mail {
  to: string;
  subject: string;
  text: string;
}

function readOutbox(): Mail[] {
  try {
    return readFileSync(MAIL_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Mail);
  } catch {
    return [];
  }
}

/** The link in the newest email sent to `to` (invite or password reset), waiting for it to arrive. */
export async function mailLink(to: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const mail = [...readOutbox()].reverse().find((m) => m.to === to);
    const link = mail && /(https?:\/\/\S+\?token=[A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
    if (link) return link;
    if (Date.now() > deadline) throw new Error(`no email with a link arrived for ${to}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export const mailsTo = (to: string) => readOutbox().filter((m) => m.to === to);

// ------------------------------------------------------------------------------------------ API helper
/**
 * An API client for set-up work that is not part of the flow under test. Node cannot resolve
 * *.localhost on every machine, so it connects to 127.0.0.1 and names the college in the Host header
 * (that is all the backend looks at), exactly what the browser's request looks like after the proxy.
 */
export async function apiAs(slug: string, email: string): Promise<APIRequestContext> {
  const host = `${slug}.localhost:${WEB_PORT}`;
  const ctx = await request.newContext({
    // trailing slash + relative paths: a leading slash would replace the /api part
    baseURL: `http://127.0.0.1:${WEB_PORT}/api/`,
    extraHTTPHeaders: { host, origin: `http://${host}`, 'x-requested-with': 'lms' },
  });
  const res = await ctx.post('auth/login', { data: { email, password: PASSWORD } });
  if (!res.ok()) throw new Error(`API sign-in as ${email} failed: ${res.status()}`);
  return ctx;
}

// ------------------------------------------------------------------------------------------ accessibility
/**
 * axe-core on the current page: WCAG 2.0/2.1 A and AA rules. Fails on any serious or critical
 * violation and prints what and where, so a failure is directly actionable.
 */
export async function expectAccessible(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = bad
    .map(
      (v) =>
        `${v.impact} ${v.id}: ${v.help}\n` +
        v.nodes
          .slice(0, 3)
          .map((n) => `    ${n.target.join(' ')}  ${n.failureSummary?.split('\n')[1] ?? ''}`)
          .join('\n'),
    )
    .join('\n');
  expect(bad, `accessibility violations on "${label}":\n${report}`).toEqual([]);
}

/** Opens the "Account" menu and signs out. */
export async function signOut(page: Page) {
  await page.locator('header details > summary').click();
  await page.getByRole('button', { name: 'Sign out' }).click();
}

// ------------------------------------------------------------------------------------------ people
/** The token inside an invitation link. */
const tokenOf = (link: string) => new URL(link).searchParams.get('token') ?? '';

/**
 * A new active member with a known password, created the way a real one is: the administrator invites them,
 * the email link carries a token, the person accepts it (all through the API; the invite UI has its own test).
 * Returns the user id. Idempotent for a person created by an earlier run of the same suite.
 */
export async function createMember(
  slug: string,
  email: string,
  displayName: string,
): Promise<string> {
  const admin = await apiAs(slug, `admin@${slug}.test`);
  try {
    const existing = await (
      await admin.get('members', { params: { q: email.split('@')[0] ?? email } })
    ).json();
    const found = (existing.items as { userId: string; email: string }[]).find(
      (m) => m.email === email,
    );
    if (found) return found.userId;
    const invite = await admin.post('auth/invites', {
      data: { email, role: 'member', displayName },
    });
    if (!invite.ok()) throw new Error(`invite of ${email} failed: ${invite.status()}`);
    const token = tokenOf(await mailLink(email));
    const host = `${slug}.localhost:${WEB_PORT}`;
    const anon = await request.newContext({
      baseURL: `http://127.0.0.1:${WEB_PORT}/api/`,
      extraHTTPHeaders: { host, origin: `http://${host}`, 'x-requested-with': 'lms' },
    });
    const accepted = await anon.post('auth/invites/accept', {
      data: { token, password: PASSWORD },
    });
    if (!accepted.ok())
      throw new Error(`accepting the invite of ${email} failed: ${accepted.status()}`);
    await anon.dispose();
    const list = await (
      await admin.get('members', { params: { q: email.split('@')[0] ?? email } })
    ).json();
    const me = (list.items as { userId: string; email: string }[]).find((m) => m.email === email);
    if (!me) throw new Error(`${email} not found after the invitation`);
    return me.userId;
  } finally {
    await admin.dispose();
  }
}

/** Polls `read` until `ok(value)`; the enrolment sync runs in the worker a moment after a change. */
export async function eventually<T>(
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

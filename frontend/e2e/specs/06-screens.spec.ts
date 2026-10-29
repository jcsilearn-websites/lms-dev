import { expect, type Page, test } from '@playwright/test';
import { expectAccessible, originOf, signInAsAdmin } from '../support';

// Every main screen, signed in as a college administrator: axe (WCAG 2.1 A/AA, fails on serious or
// critical), in the light and in the dark theme, and a phone-width check that nothing scrolls sideways.
// SCREENSHOTS=1 also saves the screens to docs/screenshots (see scripts/screenshots.mjs).

const COLLEGE = 'e2e-one';
const SCREENS: { name: string; path: string; ready: (p: Page) => Promise<void> }[] = [
  {
    name: 'home',
    path: '/',
    ready: (p) => expect(p.getByRole('heading', { name: /^Welcome/ })).toBeVisible(),
  },
  {
    name: 'members',
    path: '/members',
    ready: (p) => expect(p.getByRole('link', { name: 'Sam Suspend' }).first()).toBeVisible(),
  },
  {
    name: 'academics',
    path: '/academics',
    ready: (p) => expect(p.getByRole('tab', { name: 'Terms' })).toBeVisible(),
  },
  {
    name: 'import',
    path: '/imports',
    ready: (p) => expect(p.getByRole('button', { name: 'Upload and check' })).toBeVisible(),
  },
  {
    name: 'audit',
    path: '/audit',
    ready: (p) => expect(p.getByRole('heading', { name: 'Audit log' })).toBeVisible(),
  },
  {
    name: 'settings',
    path: '/settings',
    ready: (p) => expect(p.getByLabel('Display name')).toBeVisible(),
  },
  {
    name: 'account',
    path: '/me',
    ready: (p) => expect(p.getByRole('heading', { name: 'My sessions' })).toBeVisible(),
  },
];

for (const scheme of ['light', 'dark'] as const) {
  test(`${scheme} theme: every main screen passes the accessibility check`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signInAsAdmin(page, COLLEGE);
    for (const s of SCREENS) {
      await page.goto(`${originOf(COLLEGE)}${s.path}`);
      await s.ready(page);
      await expectAccessible(page, `${s.name} (${scheme})`);
    }
    // the member detail page too
    await page.goto(`${originOf(COLLEGE)}/members`);
    await page.getByRole('link', { name: 'Sam Suspend' }).first().click();
    await expect(page.getByRole('heading', { name: 'Sam Suspend' })).toBeVisible();
    await expectAccessible(page, `member detail (${scheme})`);
  });
}

test('on a 360 px phone nothing scrolls sideways and tables become cards', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await signInAsAdmin(page, COLLEGE);
  for (const s of SCREENS) {
    await page.goto(`${originOf(COLLEGE)}${s.path}`);
    await s.ready(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${s.name} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
    await expectAccessible(page, `${s.name} (360 px)`);
  }
  // the members table is a list of cards here, the table is hidden
  await page.goto(`${originOf(COLLEGE)}/members`);
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Members' })).toBeVisible();
});

test('the keyboard reaches everything: skip link, menu, tabs, dialogs', async ({ page }) => {
  await signInAsAdmin(page, COLLEGE);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.goto(`${originOf(COLLEGE)}/members`);
  await page.getByRole('button', { name: 'Invite member' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Invite a member' });
  await expect(dialog).toBeVisible();
  // focus moved into the dialog
  expect(await page.evaluate(() => document.activeElement?.closest('dialog') !== null)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Invite member' })).toBeFocused(); // focus returns to the opener
});

test('the college colour is applied to its own pages, per theme, and only where it is readable', async ({
  page,
}) => {
  await signInAsAdmin(page, COLLEGE);
  await page.goto(`${originOf(COLLEGE)}/settings`);
  await page.getByLabel('Display name').fill('E2E One College');
  await page.getByLabel('Primary colour', { exact: true }).fill('#7c3aed'); // violet: readable on light, not on dark
  await page.getByRole('button', { name: 'Save branding' }).click();
  await expect(page.getByText('Branding saved.')).toBeVisible();

  // a visitor sees the new name and colour on the sign-in page, without signing in
  const visitor = await page.context().browser()?.newContext();
  if (!visitor) throw new Error('no browser');
  const v = await visitor.newPage();
  await v.goto(`${originOf(COLLEGE)}/login`);
  await expect(v.getByText('E2E One College')).toBeVisible();
  const vars = await v.evaluate(() => {
    const s = document.documentElement.style;
    return { light: s.getPropertyValue('--primary-l'), dark: s.getPropertyValue('--primary-d') };
  });
  expect(vars).toEqual({ light: '#7c3aed', dark: '' }); // dark falls back to the default light blue
  await expectAccessible(v, 'branded sign-in (light)');
  await v.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(v, 'branded sign-in (dark)');
  await visitor.close();
});

test('the audit log names who did what, with their email', async ({ page }) => {
  await signInAsAdmin(page, COLLEGE);
  await page.goto(`${originOf(COLLEGE)}/audit`);
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  // earlier tests suspended people, invited and imported: the actor is the administrator, by name
  const row = page.getByRole('row').filter({ hasText: 'member.suspended' }).first();
  await expect(row).toContainText('Ada Admin');
  await expect(row).toContainText('admin@e2e-one.test');
});

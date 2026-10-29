import { expect, test } from '@playwright/test';
import { expectAccessible, mailLink, originOf, signIn, signInAsAdmin, signOut } from '../support';

test.describe('sign in and out', () => {
  test('signs in, lands on the home page, signs out and is sent back to the sign-in page', async ({
    page,
  }) => {
    await page.goto(`${originOf('e2e-one')}/login`);
    // the college name is the branding served by GET /tenant/info
    await expect(page.getByText('Tenant e2e-one')).toBeVisible();
    await expectAccessible(page, 'login');

    await signIn(page, 'e2e-one', 'admin@e2e-one.test');
    await expect(page.getByRole('heading', { name: 'Welcome, Ada Admin' })).toBeVisible();
    await expect(page.getByText('Your courses will appear here')).toBeVisible();

    await signOut(page);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    // the session is really gone: a protected page now sends us to the sign-in page again
    await page.goto(`${originOf('e2e-one')}/members`);
    await expect(page).toHaveURL(/\/login\?redirect=%2Fmembers/);
  });

  test('says "Wrong email or password." and does not reveal which part was wrong', async ({
    page,
  }) => {
    await signIn(page, 'e2e-one', 'admin@e2e-one.test', 'definitely-not-the-password');
    await expect(page.getByRole('alert')).toHaveText('Wrong email or password.');
    await signIn(page, 'e2e-one', 'nobody@e2e-one.test', 'definitely-not-the-password');
    await expect(page.getByRole('alert')).toHaveText('Wrong email or password.');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('tells empty fields apart before asking the server', async ({ page }) => {
    await page.goto(`${originOf('e2e-one')}/login`);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Email is required.')).toBeVisible();
    await expect(page.getByText('Password is required.')).toBeVisible();
    await expectAccessible(page, 'login with validation errors');
  });

  test('returns to the page that was asked for after signing in', async ({ page }) => {
    await page.goto(`${originOf('e2e-one')}/audit`);
    await expect(page).toHaveURL(/\/login\?redirect=%2Faudit/);
    await page.getByLabel('Email').fill('admin@e2e-one.test');
    await page.getByLabel('Password').fill(process.env.E2E_PASSWORD ?? '');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    await expect(page).toHaveURL(/\/audit$/);
  });
});

test.describe('colleges are isolated in the UI', () => {
  test('a session of e2e-one does not work on e2e-two', async ({ page }) => {
    await signInAsAdmin(page, 'e2e-one');
    await page.goto(`${originOf('e2e-one')}/members`);
    await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();

    // same browser, other college: the cookie belongs to the other host, so we are signed out there
    await page.goto(`${originOf('e2e-two')}/members`);
    await expect(page).toHaveURL(/\/login\?redirect=%2Fmembers/);
    await expect(page.getByText('Tenant e2e-two')).toBeVisible();
    await expect(page.getByText('Tenant e2e-one')).toHaveCount(0);

    // and the other college's admin sees only that college's people
    await signIn(page, 'e2e-two', 'admin@e2e-two.test');
    await page.goto(`${originOf('e2e-two')}/members`);
    await expect(page.getByRole('link', { name: 'Sam Suspend' })).toHaveCount(0);
  });

  test('a college that does not exist gets a friendly page', async ({ page }) => {
    await page.goto(`${originOf('no-such-college')}/login`);
    await expect(
      page.getByRole('heading', { name: 'We could not find this college' }),
    ).toBeVisible();
    await expectAccessible(page, 'unknown college');
  });
});

test.describe('password reset', () => {
  test('the emailed link lets a person choose a new password and sign in with it', async ({
    page,
  }) => {
    await page.goto(`${originOf('e2e-two')}/forgot-password`);
    await expectAccessible(page, 'forgot password');
    await page.getByLabel('Email').fill('member@e2e-two.test');
    await page.getByRole('button', { name: 'Send the link' }).click();
    await expect(page.getByText(/we have sent a link/)).toBeVisible();

    await page.goto(await mailLink('member@e2e-two.test'));
    await expectAccessible(page, 'reset password');
    await page.getByLabel('New password').fill('a brand new password 2026');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Your password has been changed')).toBeVisible();

    await signIn(page, 'e2e-two', 'member@e2e-two.test', 'a brand new password 2026');
    await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  });
});

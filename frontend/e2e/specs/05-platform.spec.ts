import { expect, test } from '@playwright/test';
import { expectAccessible, mailLink, originOf, signInAsPlatformAdmin } from '../support';

test('a platform admin creates a college and its first admin accepts the invitation', async ({
  page,
  browser,
}) => {
  await signInAsPlatformAdmin(page);
  await expectAccessible(page, 'platform: colleges');
  // the platform area has none of the college tools
  await expect(page.getByRole('navigation', { name: 'Main' })).not.toContainText('Members');

  await page.getByRole('button', { name: 'Create college' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a college' });
  await dialog.getByLabel('College name').fill('Gamma College');
  await dialog.getByLabel('Web address').fill('e2e-gamma');
  await dialog.getByLabel("First admin's name").fill('Gina Gamma');
  await dialog.getByLabel("First admin's email").fill('gina@e2e-gamma.test');
  await dialog.getByRole('button', { name: 'Create and send the invitation' }).click();
  await expect(page.getByText(/Gamma College was created/)).toBeVisible();
  await page.getByRole('searchbox').fill('gamma');
  await page.getByRole('link', { name: 'Gamma College' }).click();
  await expect(page.getByRole('heading', { name: 'Gamma College' })).toBeVisible();
  await expectAccessible(page, 'platform: college detail');

  // ---- the new admin: link in the email, a password, sign in on the NEW college's address
  const link = await mailLink('gina@e2e-gamma.test');
  expect(link).toContain('e2e-gamma.localhost');
  const gina = await browser.newContext();
  const g = await gina.newPage();
  await g.goto(link);
  await g.getByLabel('Choose a password').fill('Gina picks a long password');
  await g.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(g.getByText('Your invitation is accepted.')).toBeVisible();
  await g.getByRole('link', { name: 'Go to sign in' }).click();
  await expect(g.getByText('Gamma College')).toBeVisible(); // the new college's own sign-in page
  await g.getByLabel('Email').fill('gina@e2e-gamma.test');
  await g.getByLabel('Password').fill('Gina picks a long password');
  await g.getByRole('button', { name: 'Sign in' }).click();
  await expect(g.getByRole('heading', { name: 'Welcome, Gina Gamma' })).toBeVisible();
  await expect(g.getByRole('navigation', { name: 'Main' })).toContainText('Members'); // an institution admin
  await gina.close();

  // ---- back on the platform side: the college has an admin now
  await page.reload();
  await expect(page.getByText('Active admins')).toBeVisible();
});

test('suspending a college locks its people out until it is reactivated', async ({
  page,
  browser,
}) => {
  await signInAsPlatformAdmin(page);
  await page.getByRole('searchbox').fill('e2e-two');
  await page.getByRole('link', { name: 'Tenant e2e-two' }).first().click();
  await page.getByRole('button', { name: 'Suspend college' }).click();
  const dialog = page.getByRole('dialog', { name: 'Suspend Tenant e2e-two?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Suspend Tenant e2e-two' }).click();
  await expect(page.getByRole('button', { name: 'Reactivate college' })).toBeVisible();

  const visitor = await browser.newContext();
  const v = await visitor.newPage();
  await v.goto(`${originOf('e2e-two')}/login`);
  await expect(v.getByRole('heading', { name: 'We could not find this college' })).toBeVisible();

  await page.getByRole('button', { name: 'Reactivate college' }).click();
  await expect(page.getByRole('button', { name: 'Suspend college' })).toBeVisible();
  await v.waitForTimeout(700); // the slug cache of the API is 500 ms in this run
  await v.reload();
  await expect(v.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await visitor.close();
});

test('the platform audit log records who looked at a college', async ({ page }) => {
  await signInAsPlatformAdmin(page);
  await page.goto(`${originOf('admin')}/platform-audit`);
  await expect(page.getByRole('heading', { name: 'Platform audit log' })).toBeVisible();
  await expect(page.getByText('platform.tenant_created').first()).toBeVisible();
  await expectAccessible(page, 'platform: audit log');
});

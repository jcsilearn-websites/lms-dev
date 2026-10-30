import { expect, test } from '@playwright/test';
import { expectAccessible, mailLink, originOf, signIn, signInAsAdmin } from '../support';

const COLLEGE = 'e2e-one';

test.describe('invite, accept, sign in', () => {
  test('an admin invites a person, who accepts from the email and signs in', async ({ page }) => {
    await signInAsAdmin(page, COLLEGE);
    await page.getByRole('link', { name: 'Members' }).first().click();
    await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
    await expectAccessible(page, 'members list');

    await page.getByRole('button', { name: 'Invite member' }).click();
    const dialog = page.getByRole('dialog', { name: 'Invite a member' });
    await expectAccessible(page, 'invite dialog');
    await dialog.getByLabel('Email').fill('nia.new@e2e-one.test');
    await dialog.getByLabel('Name (optional)').fill('Nia New');
    await dialog.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByText('Invitation sent to nia.new@e2e-one.test.')).toBeVisible();

    // the new person: follows the link in the email, chooses a password
    const link = await mailLink('nia.new@e2e-one.test');
    expect(link).toContain(`${COLLEGE}.localhost`);
    const person = await page.context().browser()?.newContext();
    if (!person) throw new Error('no browser');
    const p = await person.newPage();
    await p.goto(link);
    await expect(p.getByRole('heading', { name: 'Accept your invitation' })).toBeVisible();
    await expectAccessible(p, 'accept invitation');
    await p.getByLabel('Choose a password').fill('Nia chooses a long password');
    await p.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(p.getByText('Your invitation is accepted.')).toBeVisible();
    await p.getByRole('link', { name: 'Go to sign in' }).click();

    await p.getByLabel('Email').fill('nia.new@e2e-one.test');
    await p.getByLabel('Password').fill('Nia chooses a long password');
    await p.getByRole('button', { name: 'Sign in' }).click();
    await expect(p.getByRole('heading', { name: 'Welcome, Nia New' })).toBeVisible();
    // a plain member sees no admin tools
    await expect(
      p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Members' }),
    ).toHaveCount(0);
    await p.goto(`${originOf(COLLEGE)}/members`);
    await expect(p.getByText('You are not in any course yet')).toBeVisible(); // bounced home
    await person.close();

    // back in the admin's list the person is there (pending until the first sign-in is recorded, or active)
    await page.getByRole('searchbox').fill('nia');
    await expect(page.getByRole('link', { name: 'Nia New' }).first()).toBeVisible();
  });

  test('a link without a token explains what to do', async ({ page }) => {
    await page.goto(`${originOf(COLLEGE)}/accept-invite`);
    await expect(page.getByText('This link is incomplete.')).toBeVisible();
  });
});

test.describe('suspend and reactivate', () => {
  test('suspending needs a confirmation, locks the person out, and reactivating lets them back in', async ({
    page,
    browser,
  }) => {
    await signInAsAdmin(page, COLLEGE);
    await page.goto(`${originOf(COLLEGE)}/members`);
    await page.getByRole('searchbox').fill('sam');
    await page.getByRole('link', { name: 'Sam Suspend' }).first().click();
    await expect(page.getByRole('heading', { name: 'Sam Suspend' })).toBeVisible();
    await expectAccessible(page, 'member detail');

    // cancel keeps everything as it was
    await page.getByRole('button', { name: 'Suspend', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Suspend Sam Suspend?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('active', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Suspend', exact: true }).click();
    await page.getByRole('button', { name: 'Suspend Sam Suspend' }).click();
    await expect(page.getByText('Sam Suspend is suspended.')).toBeVisible();
    await expect(page.getByText('suspended', { exact: true })).toBeVisible();

    // Sam cannot sign in now
    const sam = await browser.newContext();
    const s = await sam.newPage();
    await signIn(s, COLLEGE, 'sam.suspend@e2e-one.test');
    await expect(s.getByRole('alert')).toHaveText('Wrong email or password.');

    await page.getByRole('button', { name: 'Reactivate' }).click();
    await expect(page.getByText('Sam Suspend is active again.')).toBeVisible();
    await signIn(s, COLLEGE, 'sam.suspend@e2e-one.test');
    await expect(s.getByRole('heading', { name: 'Welcome, Sam Suspend' })).toBeVisible();
    await sam.close();

    // the list shows the new state without a reload
    await page.getByRole('link', { name: 'Back to members' }).click();
    await expect(page.getByRole('link', { name: 'Sam Suspend' }).first()).toBeVisible();
  });
});

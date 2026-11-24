import {
  createMember,
  expect,
  expectAccessible,
  originOf,
  PASSWORD,
  signIn,
  signInAsAdmin,
  test,
} from '../support';

// Erasure inside a college, end to end (step 14b-1): the member reads what is removed and what is kept (and for how long), asks with the
// password, an ADMINISTRATOR decides (approve names the member and the 7 days; reject), the member can cancel during the grace period.
// The execution itself needs the 7 days to pass: it is covered against the real database (backend test/privacy.erasure*.test.ts) and
// by the worker test; here the screens are the subject, with axe in light, dark and at 360 px.

const COLLEGE = 'e2e-one';
const EMAIL = 'erin.erase@e2e-one.test';
const NAME = 'Erin Erase';

test('a member asks to be erased, an administrator decides, the member cancels', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  await createMember(COLLEGE, EMAIL, NAME);
  const member = await (await browser.newContext()).newPage();
  await signIn(member, COLLEGE, EMAIL);
  await expect(member.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  await member.goto(`${originOf(COLLEGE)}/me/data`);
  await expect(member.getByRole('heading', { name: 'Erase me from this college' })).toBeVisible();

  // plain words about what is removed and what is kept, and for how long
  const body = member.locator('main');
  for (const phrase of [
    'What will be removed',
    'Your academic record',
    'Approved gradebooks',
    'legal counsel',
    'The audit trail',
    'Backups',
    'up to 30 days',
    '7 days in which you',
  ])
    await expect(body).toContainText(phrase);

  await expectAccessible(member, 'erasure section (light)');
  await member.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(member, 'erasure section (dark)');
  await member.emulateMedia({ colorScheme: 'light' });
  await member.setViewportSize({ width: 360, height: 740 });
  await expectAccessible(member, 'erasure section (360 px)');
  await member.setViewportSize({ width: 1280, height: 720 });

  // the password is asked again: a wrong one is refused
  await member.getByLabel('Password to confirm').fill('not my password at all');
  await member.getByRole('checkbox', { name: /I understand what is removed/ }).check();
  await member.getByRole('button', { name: 'Ask to be erased' }).click();
  await expect(member.getByText(/current password is incorrect/i)).toBeVisible();
  await member.getByLabel('Password to confirm').fill(PASSWORD);
  await member.getByRole('button', { name: 'Ask to be erased' }).click();
  await expect(member.getByText('Your request is open.')).toBeVisible();
  await expect(member.getByText('Waiting for an administrator')).toBeVisible();

  // an administrator (not the member) decides
  const adminPage = await (await browser.newContext()).newPage();
  await signInAsAdmin(adminPage, COLLEGE);
  await adminPage.goto(`${originOf(COLLEGE)}/privacy/erasure`);
  await expect(adminPage.getByRole('heading', { name: 'Erasure requests' })).toBeVisible();
  const row = adminPage.locator('li', { hasText: NAME });
  await expect(row).toBeVisible();
  await expectAccessible(adminPage, 'erasure requests (light)');
  await adminPage.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(adminPage, 'erasure requests (dark)');
  await adminPage.emulateMedia({ colorScheme: 'light' });
  await adminPage.setViewportSize({ width: 360, height: 740 });
  await expectAccessible(adminPage, 'erasure requests (360 px)');
  await adminPage.setViewportSize({ width: 1280, height: 720 });
  await row.getByRole('button', { name: 'Approve' }).click();
  const dialog = adminPage.getByRole('dialog');
  await expect(dialog.getByText(`Approve the request of ${NAME}?`)).toBeVisible();
  await expect(dialog).toContainText('7 days');
  await expect(dialog).toContainText('cannot be undone');
  await expectAccessible(adminPage, 'the approval dialog');
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(row.getByText('Approved: grace period running')).toBeVisible();

  // the member sees it, and withdraws during the grace period
  await member.reload();
  await expect(member.getByText('Approved', { exact: true })).toBeVisible();
  await expect(member.getByText(/It will be carried out on/)).toBeVisible();
  await member.getByRole('button', { name: 'Cancel my request' }).click();
  await expect(member.getByRole('button', { name: 'Ask to be erased' })).toBeVisible();

  // asks again; this time the administrator rejects
  await member.getByLabel('Password to confirm').fill(PASSWORD);
  await member.getByRole('checkbox', { name: /I understand what is removed/ }).check();
  await member.getByRole('button', { name: 'Ask to be erased' }).click();
  await expect(member.getByText('Your request is open.')).toBeVisible();
  await adminPage.reload();
  const again = adminPage
    .locator('li', { hasText: NAME })
    .filter({ hasText: 'Waiting for a decision' });
  await again.getByRole('button', { name: 'Reject' }).click();
  await adminPage.getByRole('dialog').getByRole('button', { name: 'Reject' }).click();
  await expect(
    adminPage.locator('li', { hasText: NAME }).filter({ hasText: 'Rejected' }),
  ).toBeVisible();
  await member.reload();
  await expect(member.getByRole('button', { name: 'Ask to be erased' })).toBeVisible();
});

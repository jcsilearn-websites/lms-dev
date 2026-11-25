import {
  apiAs,
  createMember,
  expect,
  expectAccessible,
  originOf,
  PASSWORD,
  signIn,
  signInAsAdmin,
  test,
} from '../support';

// Erasure of the whole ACCOUNT, end to end (step 14b-1 part 4): a member of exactly one college asks for it on "My data" (password again), the
// college's administrator sees that the whole account goes with the request and approves it; a platform administrator files the erasure of a
// person who is no longer a member of any college and a DIFFERENT platform administrator approves it. The execution needs the 7 days to pass:
// it is covered against the real database (backend test/privacy.account-erasure*.test.ts); here the screens are the subject, with axe in
// light, dark and at 360 px.

const COLLEGE = 'e2e-one';
const EMAIL = 'ada.account@e2e-one.test';
const NAME = 'Ada Account';
const GONE_EMAIL = 'gus.gone@e2e-one.test';
const GONE_NAME = 'Gus Gone';

test('a member asks to erase the whole account, the administrator sees it and approves', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  await createMember(COLLEGE, EMAIL, NAME);
  const member = await (await browser.newContext()).newPage();
  await signIn(member, COLLEGE, EMAIL);
  await expect(member.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  await member.goto(`${originOf(COLLEGE)}/me/data`);
  await expect(member.getByRole('heading', { name: 'Erase my whole account' })).toBeVisible();
  await expectAccessible(member, 'account erasure card (light)');
  await member.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(member, 'account erasure card (dark)');
  await member.emulateMedia({ colorScheme: 'light' });
  await member.setViewportSize({ width: 360, height: 740 });
  await expectAccessible(member, 'account erasure card (360 px)');
  await member.setViewportSize({ width: 1280, height: 720 });

  // the password is asked again: a wrong one is refused, the right one files the request
  const pw = member.getByLabel('Password to confirm your account erasure');
  await pw.fill('not my password at all');
  await member.getByRole('checkbox', { name: /I understand that my whole account/ }).check();
  await member.getByRole('button', { name: 'Ask to erase my whole account' }).click();
  await expect(member.getByText(/current password is incorrect/i)).toBeVisible();
  await pw.fill(PASSWORD);
  await member.getByRole('button', { name: 'Ask to erase my whole account' }).click();
  await expect(member.getByText('You asked to erase your whole account.')).toBeVisible();
  await expect(member.getByText('Waiting for the college')).toBeVisible();
  // the college half is the request of the card above
  await member.reload();
  await expect(member.getByText('Your request is open.')).toBeVisible();

  // the administrator is told that the whole account goes with it
  const adminPage = await (await browser.newContext()).newPage();
  await signInAsAdmin(adminPage, COLLEGE);
  await adminPage.goto(`${originOf(COLLEGE)}/privacy/erasure`);
  const row = adminPage.locator('li', { hasText: NAME });
  await expect(row).toContainText('and their whole account');
  await expectAccessible(adminPage, 'erasure requests with an account (light)');
  await adminPage.setViewportSize({ width: 360, height: 740 });
  await expectAccessible(adminPage, 'erasure requests with an account (360 px)');
  await adminPage.setViewportSize({ width: 1280, height: 720 });
  await row.getByRole('button', { name: 'Approve' }).click();
  const dialog = adminPage.getByRole('dialog');
  await expect(dialog).toContainText('whole account');
  await expect(dialog).toContainText('7 days');
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(row.getByText('Approved: grace period running')).toBeVisible();

  // the member sees "Approved" in the account card too, and withdraws (cancelling the college half ends the account half with it)
  await member.reload();
  await expect(member.getByText('Approved', { exact: true }).first()).toBeVisible();
  await member.getByRole('button', { name: 'Cancel my request' }).click();
  await expect(member.getByRole('button', { name: 'Ask to be erased' })).toBeVisible();
});

test('platform administrators: one files the erasure of a person with no membership, a DIFFERENT one approves it', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  // a person who is no longer a member of any college (removed by the college's administrator)
  const goneId = await createMember(COLLEGE, GONE_EMAIL, GONE_NAME);
  const collegeAdmin = await apiAs(COLLEGE, `admin@${COLLEGE}.test`);
  try {
    await collegeAdmin.delete(`members/${goneId}`);
  } finally {
    await collegeAdmin.dispose();
  }

  const root = await (await browser.newContext()).newPage();
  await signIn(root, 'admin', 'root@e2e.test');
  await expect(root.getByRole('heading', { name: 'Colleges' })).toBeVisible();
  await root.goto(`${originOf('admin')}/account-erasures`);
  await expect(root.getByRole('heading', { name: 'Account erasures' })).toBeVisible();
  await expectAccessible(root, 'account erasures (light)');
  await root.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(root, 'account erasures (dark)');
  await root.emulateMedia({ colorScheme: 'light' });
  await root.setViewportSize({ width: 360, height: 740 });
  await expectAccessible(root, 'account erasures (360 px)');
  await root.setViewportSize({ width: 1280, height: 720 });

  // an address nobody has, then a member who is still in a college: both are refused in words
  await root.getByLabel('Address of the account').fill('nobody.at.all@e2e.test');
  await root.getByRole('button', { name: 'File the request' }).click();
  await expect(root.getByText('No account has this address')).toBeVisible();
  await root.getByLabel('Address of the account').fill('admin@e2e-one.test');
  await root.getByRole('button', { name: 'File the request' }).click();
  await expect(root.getByText(/still a member of a college/)).toBeVisible();

  // the right one is filed; the one who filed it cannot approve it
  await root.getByLabel('Address of the account').fill(GONE_EMAIL);
  await root.getByRole('button', { name: 'File the request' }).click();
  const mine = root.locator('li', { hasText: GONE_NAME });
  await expect(mine).toContainText('Waiting for a decision');
  await expect(mine.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(mine).toContainText('A different administrator decides');
  await expectAccessible(root, 'account erasures with a request (light)');

  // the other platform administrator approves, naming the person and the 7 days
  const root2 = await (await browser.newContext()).newPage();
  await signIn(root2, 'admin', 'root2@e2e.test');
  await expect(root2.getByRole('heading', { name: 'Colleges' })).toBeVisible();
  await root2.goto(`${originOf('admin')}/account-erasures`);
  const theirs = root2.locator('li', { hasText: GONE_NAME });
  await expect(theirs).toBeVisible();
  await theirs.getByRole('button', { name: 'Approve' }).click();
  const dialog = root2.getByRole('dialog');
  await expect(dialog.getByText(`the account of ${GONE_NAME}`)).toBeVisible();
  await expect(dialog).toContainText('7 days');
  await expect(dialog).toContainText('cannot be undone');
  await expectAccessible(root2, 'the account erasure approval dialog');
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(theirs.getByText('Approved: grace period running')).toBeVisible();

  // either of them can still cancel during the grace period (nothing is erased)
  await theirs.getByRole('button', { name: 'Cancel' }).click();
  // (the dialog has a dismiss button named Cancel too: the confirming one is the last)
  await root2.getByRole('dialog').getByRole('button', { name: 'Cancel' }).last().click();
  await expect(theirs.getByText('Cancelled')).toBeVisible();
});

import { readFile } from 'node:fs/promises';
import {
  createMember,
  expect,
  expectAccessible,
  originOf,
  PASSWORD,
  signIn,
  test,
} from '../support';

// "My data" end to end (step 14b-1): the member asks for the archive of their own data, the password is asked again (a wrong one is
// refused), the worker prepares it, the page shows it ready, the download is a real ZIP that holds the member's own account and
// not a trace of anybody else; the screen passes axe (light, dark, 360 px).

const COLLEGE = 'e2e-one';
const EMAIL = 'mia.mydata@e2e-one.test';
const NAME = 'Mia Mydata';

test('a member downloads their own data, after entering the password again', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  await createMember(COLLEGE, EMAIL, NAME);
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await signIn(page, COLLEGE, EMAIL);
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  await page.goto(`${originOf(COLLEGE)}/me/data`);
  await expect(page.getByRole('heading', { name: 'My data', level: 1 })).toBeVisible();
  await expect(page.getByText('No requests yet')).toBeVisible();

  // accessible in the three modes, with the form and the empty list
  await expectAccessible(page, 'my data (light)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page, 'my data (dark)');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 360, height: 740 });
  await expectAccessible(page, 'my data (360 px)');
  await page.setViewportSize({ width: 1280, height: 720 });

  // a wrong password is refused and makes no request
  await page.getByLabel('Your password').fill('not my password at all');
  await page.getByRole('button', { name: 'Prepare my data' }).click();
  await expect(page.getByText(/current password is incorrect/i)).toBeVisible();
  await expect(page.getByText('No requests yet')).toBeVisible();

  // the right one: the worker prepares the archive and the page follows it to "Ready"
  await page.getByLabel('Your password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Prepare my data' }).click();
  await expect(page.getByText('Ready to download').first()).toBeVisible({ timeout: 60_000 });
  await expectAccessible(page, 'my data with a ready archive');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('my-data.zip');
  const path = await file.path();
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  const text = bytes.toString('latin1');
  expect(text).toContain('README.txt');
  expect(text).toContain('account.json');
  expect(text).toContain(EMAIL); // the member's own address is in their account file (the archive is stored, not compressed)
  expect(text).not.toContain('admin@e2e-one.test'); // nobody else's
});

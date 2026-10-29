import { expect, test } from '@playwright/test';
import { apiAs, expectAccessible, mailsTo, originOf, signInAsAdmin } from '../support';

const COLLEGE = 'e2e-one';

// the structure the file refers to (set up through the API: the academic UI has its own test)
test.beforeAll(async () => {
  const api = await apiAs(COLLEGE, `admin@${COLLEGE}.test`);
  // Idempotent: Playwright runs this again when it restarts the worker after a failed test.
  const ok = async (res: Awaited<ReturnType<typeof api.post>>, find?: string) => {
    if (res.status() === 409 && find) {
      const list = await (await api.get(find)).json();
      return list.items[0] as { id: string };
    }
    if (!res.ok()) throw new Error(`setup call failed: ${res.status()} ${await res.text()}`);
    return (await res.json()) as { id: string };
  };
  const dept = await ok(
    await api.post('departments', { data: { code: 'CSE', name: 'Computer Science' } }),
    'departments?limit=1&archived=false',
  );
  const prog = await ok(
    await api.post('programs', {
      data: { departmentId: dept.id, code: 'BTECH', name: 'B.Tech', durationYears: 4 },
    }),
    `programs?departmentId=${dept.id}&limit=1`,
  );
  const batch = await ok(
    await api.post('batches', {
      data: { programId: prog.id, admissionYear: 2023, graduationYear: 2027 },
    }),
    `batches?programId=${prog.id}&limit=1`,
  );
  await ok(
    await api.post('sections', { data: { batchId: batch.id, code: 'A' } }),
    `sections?batchId=${batch.id}&limit=1`,
  );
  await api.dispose();
});

const CSV = [
  'email,full_name,register_number,department_code,program_code,batch,section',
  'import.one@e2e-one.test,Import One,CSE-001,CSE,BTECH,2023-2027,A',
  'import.two@e2e-one.test,Import Two,CSE-002,CSE,BTECH,2023-2027,A',
  'not-an-email,Import Bad,CSE-003,CSE,BTECH,2023-2027,A',
  '',
].join('\r\n');

test('uploads a file with one bad row, sees the error, skips it, watches the import finish', async ({
  page,
}) => {
  await signInAsAdmin(page, COLLEGE);
  await page.goto(`${originOf(COLLEGE)}/imports`);
  await expect(page.getByRole('heading', { name: 'Bulk import' })).toBeVisible();
  await expectAccessible(page, 'import: start');

  // the template can be downloaded
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /download the students template/ }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('students-template.csv');

  // ---- upload
  await page.getByLabel('CSV file').setInputFiles({
    name: 'students.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV),
  });
  await page.getByRole('button', { name: 'Upload and check' }).click();

  // ---- review: the bad row is reported with its reason
  await expect(page.getByRole('heading', { name: 'students.csv' })).toBeVisible();
  await expect(page.getByText('1 row has problems and will not be imported.')).toBeVisible();
  await expect(page.getByText('is not a valid email address').first()).toBeVisible();
  await expectAccessible(page, 'import: review');

  // the error report downloads as CSV
  const [report] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download the error report (CSV)' }).click(),
  ]);
  expect(report.suggestedFilename()).toMatch(/errors\.csv$/);

  // ---- confirm: blocked until the invalid row is explicitly skipped
  const importButton = page.getByRole('button', { name: 'Import 2 people' });
  await expect(importButton).toBeDisabled();
  await page.getByLabel(/Skip the 1 rows with problems/).check();
  await expect(importButton).toBeEnabled();
  await importButton.click();

  // ---- progress, then the summary
  await expect(page.getByText('New members', { exact: true })).toBeVisible({ timeout: 30_000 });
  const created = page
    .locator('div', { has: page.getByText('New members', { exact: true }) })
    .last();
  await expect(created).toContainText('2');
  await expect(page.getByText('Skipped', { exact: true })).toBeVisible();
  await expectAccessible(page, 'import: summary');

  // the new people exist (pending, invited) and the invitations went out through the queue
  await page.goto(`${originOf(COLLEGE)}/members?q=import`);
  await expect(page.getByRole('link', { name: 'Import One' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Import Two' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Import Bad' })).toHaveCount(0);
  await expect
    .poll(() => mailsTo('import.one@e2e-one.test').length, { timeout: 20_000 })
    .toBeGreaterThan(0);
});

test('cancelling an import asks first, names the file, and saves nothing', async ({ page }) => {
  await signInAsAdmin(page, COLLEGE);
  await page.goto(`${originOf(COLLEGE)}/imports`);
  await page.getByLabel('CSV file').setInputFiles({
    name: 'to-cancel.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [
        'email,full_name,register_number,department_code,program_code,batch,section',
        'cancel.me@e2e-one.test,Cancel Me,CSE-100,CSE,BTECH,2023-2027,A',
        '',
      ].join('\r\n'),
    ),
  });
  await page.getByRole('button', { name: 'Upload and check' }).click();
  await page.getByRole('button', { name: 'Cancel this import' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel the import of to-cancel.csv?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel to-cancel.csv' }).click();
  await expect(page.getByText('This import was cancelled. Nothing was saved.')).toBeVisible();

  await page.goto(`${originOf(COLLEGE)}/members?q=cancel`);
  await expect(page.getByText('No members found')).toBeVisible();
});

test('the profile of an imported student opens with the whole chain prefilled', async ({
  page,
}) => {
  await signInAsAdmin(page, COLLEGE);
  await page.goto(`${originOf(COLLEGE)}/members?q=import`);
  await page.getByRole('link', { name: 'Import One' }).first().click();
  await expect(page.getByRole('heading', { name: 'Import One' })).toBeVisible();
  await expect(page.getByText('B.Tech (BTECH)')).toBeVisible(); // program, derived through the batch
  await page.getByRole('button', { name: 'Edit profile' }).click();
  const chosen = (label: string) =>
    page.getByLabel(label, { exact: true }).locator('option:checked');
  await expect(chosen('Department')).toHaveText('CSE - Computer Science');
  await expect(chosen('Program')).toHaveText('BTECH');
  await expect(chosen('Batch')).toHaveText('2023-2027');
  await expect(chosen('Section')).toHaveText('A');
  await expectAccessible(page, 'member detail: profile edit');
});

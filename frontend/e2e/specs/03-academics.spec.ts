import { expect, type Page, test } from '@playwright/test';
import { expectAccessible, originOf, signInAsAdmin } from '../support';

const COLLEGE = 'e2e-one';

async function tab(page: Page, name: string) {
  await page.getByRole('tab', { name, exact: true }).click();
}

test('sets up a department, a program, a batch and a section, in that order', async ({ page }) => {
  await signInAsAdmin(page, COLLEGE);
  await page.goto(`${originOf(COLLEGE)}/academics`);
  await expect(page.getByRole('heading', { name: 'Academic setup' })).toBeVisible();
  await expectAccessible(page, 'academic setup');

  // ---- department
  await tab(page, 'Departments');
  await expect(page.getByText('No departments yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add department' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add department' });
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText('Code is required.')).toBeVisible(); // validated from the contract
  await dialog.getByLabel('Code').fill('ECE');
  await dialog.getByLabel('Name').fill('Electronics and Communication');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('ECE - Electronics and Communication added.')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'ECE', exact: true })).toBeVisible();

  // ---- program of that department
  await tab(page, 'Programs');
  await expect(page.getByText('Choose a department to see its programs.')).toBeVisible();
  await page
    .getByLabel('Department')
    .selectOption({ label: 'ECE - Electronics and Communication' });
  await page.getByRole('button', { name: 'Add program' }).click();
  dialog = page.getByRole('dialog', { name: 'Add program' });
  await dialog.getByLabel('Code').fill('BE');
  await dialog.getByLabel('Name').fill('Bachelor of Engineering');
  await dialog.getByLabel('Duration (years)').fill('4');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'BE', exact: true })).toBeVisible();

  // ---- batch of that program
  await tab(page, 'Batches');
  await page
    .getByLabel('Department')
    .selectOption({ label: 'ECE - Electronics and Communication' });
  await page.getByLabel('Program').selectOption({ label: 'BE' });
  await page.getByRole('button', { name: 'Add batch' }).click();
  dialog = page.getByRole('dialog', { name: 'Add batch' });
  await dialog.getByLabel('Admission year').fill('2024');
  await dialog.getByLabel('Graduation year').fill('2028');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: '2024-2028', exact: true })).toBeVisible();

  // ---- section of that batch
  await tab(page, 'Sections');
  await page
    .getByLabel('Department')
    .selectOption({ label: 'ECE - Electronics and Communication' });
  await page.getByLabel('Program').selectOption({ label: 'BE' });
  await page.getByLabel('Batch').selectOption({ label: '2024-2028' });
  await page.getByRole('button', { name: 'Add section' }).click();
  dialog = page.getByRole('dialog', { name: 'Add section' });
  await dialog.getByLabel('Code').fill('A');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'A', exact: true })).toBeVisible();
  await expectAccessible(page, 'sections tab');

  // ---- it is all really saved: a reload shows the same
  await page.reload();
  await tab(page, 'Departments');
  await expect(page.getByRole('cell', { name: 'ECE', exact: true })).toBeVisible();
});

test('a conflict is explained, not hidden: a department with an active program cannot be archived', async ({
  page,
}) => {
  await signInAsAdmin(page, COLLEGE);
  await page.goto(`${originOf(COLLEGE)}/academics`);
  await tab(page, 'Departments');
  await page.getByRole('button', { name: 'Archive' }).first().click();
  const dialog = page.getByRole('dialog', { name: /^Archive ECE/ });
  // the confirmation names exactly what is about to be archived
  await expect(dialog).toContainText('ECE - Electronics and Communication');
  await dialog.getByRole('button', { name: /^Archive ECE/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: /./ }).first()).toBeVisible();
  // still listed: nothing changed
  await expect(page.getByRole('cell', { name: 'ECE', exact: true })).toBeVisible();
});

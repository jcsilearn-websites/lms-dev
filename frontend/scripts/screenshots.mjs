#!/usr/bin/env node
// Saves screenshots of the main screens to docs/screenshots/<screen>-<theme>-<viewport>.png:
// light and dark, desktop (1280x800) and phone (390x844). Runs against the real stack with some demo
// data (a department/program/batch/section, a small import with one bad row, 40 members).
//
//   pnpm --filter @lms/frontend run screenshots

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, request } from '@playwright/test';
import { ROOT, withStack } from './stack.mjs';

const OUT = join(ROOT, 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
};

await withStack(
  async ({ webPort, password }) => {
    const origin = (slug) => `http://${slug}.localhost:${webPort}`;

    // ---- demo data through the API (Host header names the college; see e2e/support.ts)
    const host = `e2e-one.localhost:${webPort}`;
    const api = await request.newContext({
      baseURL: `http://127.0.0.1:${webPort}/api/`,
      extraHTTPHeaders: { host, origin: `http://${host}`, 'x-requested-with': 'lms' },
    });
    const must = async (res) => {
      if (!res.ok()) throw new Error(`demo data call failed: ${res.status()} ${await res.text()}`);
      return res.json();
    };
    await must(await api.post('auth/login', { data: { email: 'admin@e2e-one.test', password } }));
    const dept = await must(
      await api.post('departments', { data: { code: 'CSE', name: 'Computer Science' } }),
    );
    await must(await api.post('departments', { data: { code: 'ECE', name: 'Electronics' } }));
    const prog = await must(
      await api.post('programs', {
        data: {
          departmentId: dept.id,
          code: 'BE',
          name: 'Bachelor of Engineering',
          durationYears: 4,
        },
      }),
    );
    const batch = await must(
      await api.post('batches', {
        data: { programId: prog.id, admissionYear: 2023, graduationYear: 2027 },
      }),
    );
    await must(await api.post('sections', { data: { batchId: batch.id, code: 'A' } }));
    await api.dispose();

    const csv = [
      'email,full_name,register_number,department_code,program_code,batch,section',
      'asha.rao@e2e-one.test,Asha Rao,CSE-001,CSE,BE,2023-2027,A',
      'ben.joseph@e2e-one.test,Ben Joseph,CSE-002,CSE,BE,2023-2027,A',
      'not-an-email,Chitra Nair,CSE-003,CSE,BE,2023-2027,A',
      '',
    ].join('\r\n');

    const browser = await chromium.launch();
    let reviewUrl = null;
    try {
      for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
        for (const scheme of ['light', 'dark']) {
          const ctx = await browser.newContext({
            viewport,
            colorScheme: scheme,
            deviceScaleFactor: 1,
          });
          const page = await ctx.newPage();
          const shot = async (name) => {
            await page.waitForTimeout(400); // fonts, skeleton fade
            await page.screenshot({ path: join(OUT, `${name}-${scheme}-${vpName}.png`) });
            console.log(`  ${name}-${scheme}-${vpName}.png`);
          };

          // sign-in page (not signed in)
          await page.goto(`${origin('e2e-one')}/login`);
          await page.getByText('Tenant e2e-one').waitFor();
          await shot('login');

          await page.getByLabel('Email').fill('admin@e2e-one.test');
          await page.getByLabel('Password').fill(password);
          await page.getByRole('button', { name: 'Sign in' }).click();
          await page.getByRole('heading', { name: /^Welcome/ }).waitFor();
          await shot('home');

          await page.goto(`${origin('e2e-one')}/members`);
          await page.getByRole('link', { name: 'Sam Suspend' }).first().waitFor();
          await shot('members');

          await page.getByRole('link', { name: 'Sam Suspend' }).first().click();
          await page.getByRole('heading', { name: 'Sam Suspend' }).waitFor();
          await shot('member-detail');

          await page.goto(`${origin('e2e-one')}/academics`);
          await page.getByRole('tab', { name: 'Departments', exact: true }).click();
          await page
            .getByRole('cell', { name: 'CSE', exact: true })
            .or(page.getByText('CSE').first())
            .first()
            .waitFor();
          await shot('academics');

          // an import with one bad row, up to the review step (one per colour scheme and size)
          await page.goto(`${origin('e2e-one')}/imports`);
          await page.getByLabel('CSV file').setInputFiles({
            name: `students-${scheme}-${vpName}.csv`,
            mimeType: 'text/csv',
            buffer: Buffer.from(csv),
          });
          await page.getByRole('button', { name: 'Upload and check' }).click();
          await page.getByText('is not a valid email address').first().waitFor();
          await shot('import-review');
          reviewUrl = page.url();
          await page.getByRole('button', { name: 'Cancel this import' }).click();
          await page.getByRole('button', { name: /^Cancel students-/ }).click();
          await page.getByText('This import was cancelled').waitFor();

          await page.goto(`${origin('e2e-one')}/audit`);
          await page.getByRole('heading', { name: 'Audit log' }).waitFor();
          await shot('audit');

          await page.goto(`${origin('e2e-one')}/settings`);
          await page.getByLabel('Display name').waitFor();
          await shot('settings');
          await ctx.close();

          // platform area (admin host)
          const pctx = await browser.newContext({ viewport, colorScheme: scheme });
          const p = await pctx.newPage();
          await p.goto(`${origin('admin')}/login`);
          await p.getByLabel('Email').fill('root@e2e.test');
          await p.getByLabel('Password').fill(password);
          await p.getByRole('button', { name: 'Sign in' }).click();
          await p.getByRole('heading', { name: 'Colleges' }).waitFor();
          await p.getByRole('link', { name: 'Tenant e2e-one' }).first().waitFor();
          await p.waitForTimeout(400);
          await p.screenshot({ path: join(OUT, `platform-colleges-${scheme}-${vpName}.png`) });
          console.log(`  platform-colleges-${scheme}-${vpName}.png`);
          await pctx.close();
        }
      }
    } finally {
      await browser.close();
    }
    return reviewUrl;
  },
  { extraMembers: 40 },
);
console.log(`Screenshots saved to ${OUT}`);
process.exit(0);

#!/usr/bin/env node
// Saves screenshots of the main screens to docs/screenshots/<screen>-<theme>-<viewport>.png:
// light and dark, desktop (1280x800) and phone (390x844). Runs against the real stack with some demo
// data (a department/program/batch/section, a small import with one bad row, 40 members).
//
//   pnpm --filter @lms/frontend run screenshots

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, request } from '@playwright/test';
import { COURSE_TITLE, seedCourseDemo } from './demo-courses.mjs';
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
    // a course with content, an instructor and a learner (the course screens)
    const demo = await seedCourseDemo({ webPort, password });

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

          // ---- the course screens: administrator, instructor, learner
          const signedIn = async (email) => {
            const c = await browser.newContext({
              viewport,
              colorScheme: scheme,
              deviceScaleFactor: 1,
            });
            const pg = await c.newPage();
            await pg.goto(`${origin('e2e-one')}/login`);
            await pg.getByLabel('Email').fill(email);
            await pg.getByLabel('Password').fill(password);
            await pg.getByRole('button', { name: 'Sign in' }).click();
            await pg.getByRole('heading', { name: /^Welcome/ }).waitFor();
            const snap = async (name) => {
              await pg.waitForTimeout(400);
              await pg.screenshot({ path: join(OUT, `${name}-${scheme}-${vpName}.png`) });
              console.log(`  ${name}-${scheme}-${vpName}.png`);
            };
            return { c, pg, snap };
          };
          {
            const a = await signedIn('admin@e2e-one.test');
            await a.pg.goto(`${origin('e2e-one')}/courses`);
            await a.pg.getByText('Photography (elective)').waitFor();
            await a.snap('courses');
            await a.pg.goto(`${origin('e2e-one')}/offerings`);
            await a.pg
              .getByRole('link', { name: new RegExp(COURSE_TITLE) })
              .first()
              .waitFor();
            await a.snap('offerings');
            await a.pg.goto(`${origin('e2e-one')}/offerings/${demo.offeringId}/people`);
            await a.pg.getByText('Lena Learner').first().waitFor();
            await a.snap('course-people');
            await a.c.close();

            const t = await signedIn(demo.instructorEmail);
            await t.pg.goto(`${origin('e2e-one')}/offerings/${demo.offeringId}/build`);
            await t.pg.getByRole('heading', { name: /Week 1/ }).waitFor();
            await t.snap('course-builder');
            await t.pg.getByRole('button', { name: 'Add text' }).first().click();
            await t.pg.getByRole('textbox', { name: 'Text of this item' }).waitFor();
            await t.pg.getByRole('textbox', { name: 'Text of this item' }).click();
            await t.pg.keyboard.type('Welcome to the course. Read the syllabus first.');
            await t.snap('course-editor');
            // the video item of the demo course: its dialog (ready, with its renditions and the captions panel)
            await t.pg.goto(`${origin('e2e-one')}/offerings/${demo.offeringId}/build`);
            await t.pg.getByRole('button', { name: /^Edit Lecture: welcome/ }).click();
            await t.pg
              .getByRole('dialog', { name: 'Edit video' })
              .getByText('Ready')
              .first()
              .waitFor();
            await t.snap('video-dialog');
            await t.c.close();

            const l = await signedIn(demo.learnerEmail);
            await l.pg.getByRole('link', { name: new RegExp(COURSE_TITLE) }).waitFor();
            await l.snap('my-courses');
            await l.pg.goto(`${origin('e2e-one')}/offerings/${demo.offeringId}`);
            await l.pg.getByText(/Available from/).waitFor();
            await l.snap('course-learner');
            await l.pg
              .getByRole('link', { name: /reading 1/ })
              .first()
              .click();
            await l.pg.getByText('Read this carefully before the lab.').waitFor();
            await l.snap('course-item');
            // the video item: the poster with its Play button, then the player while it plays
            await l.pg.goto(
              `${origin('e2e-one')}/offerings/${demo.offeringId}/items/${demo.videoItemId}`,
            );
            const player = l.pg.getByRole('region', { name: /Video player/ });
            await player.getByRole('button', { name: 'Play' }).waitFor();
            await l.pg.waitForTimeout(600); // the poster
            await l.snap('video-poster');
            await player.getByRole('button', { name: 'Play' }).click();
            await l.pg.waitForFunction(
              () => (document.querySelector('video')?.currentTime ?? 0) > 1.5,
            );
            await l.snap('video-playing');
            await l.c.close();
          }

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

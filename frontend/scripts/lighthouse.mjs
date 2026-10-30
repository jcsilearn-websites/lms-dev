#!/usr/bin/env node

// Lighthouse (mobile preset: emulated phone, simulated slow 4G and 4x CPU slowdown) on the login page,
// the members list (signed in, 200 members) and a learner's course page (6 modules, 35 items), against the real stack served by scripts/serve.mjs
// (compression, long caching). Each page is measured 3 times; the MEDIAN scores are reported.
//
//   node scripts/lighthouse.mjs            prints the table
//   node scripts/lighthouse.mjs --assert   also exits 1 when a budget is missed (CI)
//
// Budgets: Performance >= 90, Accessibility >= 95 on every page.
// The browser is Playwright's Chromium (pnpm exec playwright install chromium).

import { writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { seedCourseDemo } from './demo-courses.mjs';
import { FRONTEND, withStack } from './stack.mjs';

const RUNS = Number(process.env.LH_RUNS ?? 3);
const PERF_BUDGET = 90;
const A11Y_BUDGET = 95;
const assertBudgets = process.argv.includes('--assert');

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Signs in through the web server (the Host header names the college) and returns the session cookie. */
function signIn(webPort, password, email = 'admin@e2e-one.test') {
  const host = `e2e-one.localhost:${webPort}`;
  const body = JSON.stringify({ email, password });
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: webPort,
        path: '/api/auth/login',
        method: 'POST',
        headers: {
          host,
          origin: `http://${host}`,
          'x-requested-with': 'lms',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        const cookie = (res.headers['set-cookie'] ?? [])[0]?.split(';')[0];
        if (res.statusCode === 200 && cookie) resolve(cookie);
        else reject(new Error(`sign-in for Lighthouse failed (${res.statusCode})`));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function measure(url, cookie) {
  const chrome = await chromeLauncher.launch({
    chromePath: chromium.executablePath(),
    chromeFlags: ['--headless=new', '--disable-gpu', '--no-first-run'],
  });
  try {
    const result = await lighthouse(
      url,
      {
        port: chrome.port,
        output: 'json',
        logLevel: 'error',
        onlyCategories: ['performance', 'accessibility'],
        ...(cookie ? { extraHeaders: { Cookie: cookie } } : {}),
      },
      undefined,
    );
    const lhr = result?.lhr;
    if (!lhr) throw new Error('Lighthouse returned no result');
    const a = lhr.audits;
    return {
      performance: Math.round((lhr.categories.performance?.score ?? 0) * 100),
      accessibility: Math.round((lhr.categories.accessibility?.score ?? 0) * 100),
      fcp: a['first-contentful-paint']?.numericValue ?? 0,
      lcp: a['largest-contentful-paint']?.numericValue ?? 0,
      tbt: a['total-blocking-time']?.numericValue ?? 0,
      cls: a['cumulative-layout-shift']?.numericValue ?? 0,
      si: a['speed-index']?.numericValue ?? 0,
      // every accessibility audit that did not pass completely in THIS run, with what it found
      // for a run below 100: every accessibility audit that errored or scored below 1, plus warnings
      detail:
        (lhr.categories.accessibility?.score ?? 1) < 1
          ? JSON.stringify({
              runtimeError: lhr.runtimeError?.code,
              warnings: lhr.runWarnings,
              audits: (lhr.categories.accessibility?.auditRefs ?? [])
                .map((ref) => lhr.audits[ref.id])
                .filter(
                  (x) => x && (x.scoreDisplayMode === 'error' || (x.score !== null && x.score < 1)),
                )
                .map((x) => `${x.id}:${x.scoreDisplayMode}:${x.score}:${x.errorMessage ?? ''}`),
            }).slice(0, 400)
          : '',
      failedA11y: (lhr.categories.accessibility?.auditRefs ?? [])
        .map((ref) => lhr.audits[ref.id])
        .filter((x) => x && x.score !== null && x.score < 1)
        .map(
          (x) =>
            `${x.id} (${(x.details?.items ?? [])
              .slice(0, 2)
              .map((it) => it.node?.snippet ?? '')
              .join(' | ')
              .slice(0, 160)})`,
        ),
    };
  } finally {
    await chrome.kill();
  }
}

const rows = await withStack(
  async ({ webPort, password }) => {
    const cookie = await signIn(webPort, password);
    // a course with 6 modules x 5-7 items, and a learner who can see it
    const demo = await seedCourseDemo({ webPort, password });
    const learnerCookie = await signIn(webPort, password, demo.learnerEmail);
    const pages = [
      { name: 'Login page', url: `http://e2e-one.localhost:${webPort}/login`, cookie: undefined },
      { name: 'Members list', url: `http://e2e-one.localhost:${webPort}/members`, cookie },
      {
        name: 'Course (learner)',
        url: `http://e2e-one.localhost:${webPort}/offerings/${demo.offeringId}`,
        cookie: learnerCookie,
      },
    ];
    const out = [];
    for (const p of pages) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) runs.push(await measure(p.url, p.cookie));
      out.push({
        page: p.name,
        runs: runs.map((r) => ({ performance: r.performance, accessibility: r.accessibility })),
        performance: median(runs.map((r) => r.performance)),
        accessibility: median(runs.map((r) => r.accessibility)),
        fcpMs: Math.round(median(runs.map((r) => r.fcp))),
        lcpMs: Math.round(median(runs.map((r) => r.lcp))),
        tbtMs: Math.round(median(runs.map((r) => r.tbt))),
        cls: Number(median(runs.map((r) => r.cls)).toFixed(3)),
        speedIndexMs: Math.round(median(runs.map((r) => r.si))),
        failedAccessibilityAudits: [...new Set(runs.flatMap((r) => r.failedA11y))],
        details: runs.map((r) => r.detail).filter(Boolean),
      });
    }
    return out;
  },
  { extraMembers: 200 },
);

console.log(`\nLighthouse, mobile preset, median of ${RUNS} runs`);
console.log('page            perf  a11y  FCP ms  LCP ms  TBT ms  CLS    runs (perf/a11y)');
for (const r of rows) {
  console.log(
    `${r.page.padEnd(15)} ${String(r.performance).padEnd(5)} ${String(r.accessibility).padEnd(5)} ${String(r.fcpMs).padEnd(7)} ${String(r.lcpMs).padEnd(7)} ${String(r.tbtMs).padEnd(7)} ${String(r.cls).padEnd(6)} ${r.runs.map((x) => `${x.performance}/${x.accessibility}`).join(' ')}`,
  );
  if (r.failedAccessibilityAudits.length)
    console.log(`   failed accessibility audits: ${r.failedAccessibilityAudits.join(', ')}`);
}
writeFileSync(join(FRONTEND, 'lighthouse-summary.json'), JSON.stringify(rows, null, 2));

const misses = rows.flatMap((r) => [
  ...(r.performance < PERF_BUDGET
    ? [`${r.page}: performance ${r.performance} < ${PERF_BUDGET}`]
    : []),
  ...(r.accessibility < A11Y_BUDGET
    ? [`${r.page}: accessibility ${r.accessibility} < ${A11Y_BUDGET}`]
    : []),
]);
if (misses.length) {
  console.error(`\nBudgets missed:\n  - ${misses.join('\n  - ')}`);
  if (assertBudgets) process.exit(1);
} else {
  console.log('\nLighthouse budgets met (performance >= 90, accessibility >= 95)');
}
process.exit(0);

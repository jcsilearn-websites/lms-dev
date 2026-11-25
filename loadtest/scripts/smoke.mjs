#!/usr/bin/env node
// A TINY-scale run of all six scenarios on the real E2E stack (API, worker and PostgreSQL in the database lms_e2e: the same stack `pnpm e2e` uses, started
// by frontend/scripts/stack.mjs with its relaxed rate limits). It proves the harness works end to end: the seed, every scenario's flow through the real
// API, the result files. It measures nothing worth quoting. Run it with:  pnpm loadtest:smoke   (E2E_SKIP_BUILD=1 reuses frontend/dist)

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withStack } from '../../frontend/scripts/stack.mjs';
import { OPTION_DEFS, resolveConfig } from '../src/config.mjs';
import { runScenarios } from '../src/run.mjs';
import { seed } from '../src/seed.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));

// The stack's database is lms_e2e on the machine's own PostgreSQL: the owner connection of the TEST server with that database name
// (backend/test/e2e-database.ts refuses anything else). Never the development database.
function e2eOwnerUrl() {
  const base = process.env.TEST_DATABASE_URL;
  if (!base)
    throw new Error(
      'TEST_DATABASE_URL is not set (the smoke run uses the same server as the E2E suite)',
    );
  const u = new URL(base);
  u.pathname = '/lms_e2e';
  return u.toString();
}

const defaults = Object.fromEntries(
  Object.entries(OPTION_DEFS)
    .filter(([, d]) => d.default !== undefined)
    .map(([k, d]) => [k, d.default]),
);
const tiny = resolveConfig({
  ...defaults,
  learners: '12',
  viewers: '6',
  browsers: '6',
  graders: '2',
  'file-kb': '64',
  'time-scale': '0.02',
  'cadence-scale': '0.02',
  'login-rate': '50',
  'max-error-rate': '0.0',
});

const out = mkdtempSync(join(tmpdir(), 'lms-loadtest-smoke-'));
const failures = [];
try {
  await withStack(async ({ apiPort, password }) => {
    process.env.LOADTEST_DATABASE_URL = e2eOwnerUrl();
    process.env.DB_SSL = process.env.DB_SSL ?? 'off';
    const api = `http://127.0.0.1:${apiPort}`;
    const slug = 'bench-lt-smoke';
    const host = `${slug}.localhost:${apiPort}`;
    const { state } = await seed({
      api,
      host,
      slug,
      learners: 12,
      instructors: 2,
      password: `${password}-Lt1`.slice(0, 40),
      videoSeconds: 24,
      noVideo: false,
    });
    const { results } = await runScenarios({
      state,
      api,
      host,
      names: ['all'],
      config: tiny,
      outDir: out,
      enforce: true,
    });

    const note = (name) => results.find((r) => r.scenario === name);
    const expect = (name, ok, what) => {
      if (!ok) failures.push(`${name}: ${what}`);
    };
    for (const r of results) {
      expect(r.scenario, !r.crashed, `crashed: ${r.crashed}`);
      expect(r.scenario, !r.skipped, `skipped: ${r.skipped}`);
    }
    const n = (name, re) => Number(re.exec(note(name)?.notes?.[0] ?? '')?.[1] ?? Number.NaN);
    expect(
      'login-wave',
      n('login-wave', /^(\d+) of/) === 12,
      `all 12 learners should sign in (${note('login-wave')?.notes?.[0]})`,
    );
    expect(
      'exam',
      n('exam', /(\d+) of \d+ exams started/) === 12 && n('exam', /, (\d+) submitted/) === 12,
      `all 12 should start and submit (${note('exam')?.notes?.[0]})`,
    );
    expect(
      'assignment',
      n('assignment', /^(\d+) of/) === 12,
      `all 12 should hand in (${note('assignment')?.notes?.[0]})`,
    );
    expect(
      'video',
      n('video', /^(\d+) of/) === 6,
      `all 6 viewers should play (${note('video')?.notes?.[0]})`,
    );
    expect(
      'grading',
      n('grading', /^(\d+) grades/) >= 1,
      `at least one grade (${note('grading')?.notes?.[0]})`,
    );
    expect(
      'browsing',
      n('browsing', /^(\d+) page views/) >= 6,
      `page views (${note('browsing')?.notes?.[0]})`,
    );
    // the results must hold what each scenario did: a run whose clients record into the wrong recorder looks perfect (0 failures of 0 requests)
    // and says nothing, which is exactly what the first version of this harness did
    const mustHave = {
      'login-wave': ['POST /api/auth/login', 'GET /api/me/dashboard'],
      exam: [
        'POST /api/offerings/:id/items/:id/attempts',
        'PUT /api/offerings/:id/attempts/:id/answers',
        'POST /api/offerings/:id/attempts/:id/submit',
      ],
      assignment: [
        'PUT (signed upload URL)',
        'POST /api/offerings/:id/items/:id/assignment/submissions',
      ],
      video: [
        'POST /api/offerings/:id/items/:id/playback',
        'GET segment',
        'POST /api/offerings/:id/items/:id/progress/heartbeat',
      ],
      grading: [
        'PUT /grading/learners/:key/grade',
        'GET /api/offerings/:id/items/:id/assignment/grading/queue',
      ],
      browsing: ['GET /api/notifications/unread-count', 'GET /api/offerings/:id/outline'],
    };
    for (const [name, labels] of Object.entries(mustHave)) {
      const routes = note(name)?.routes ?? [];
      expect(name, routes.length > 0, 'the results hold no route at all');
      for (const label of labels) {
        const row = routes.find((x) => x.label === label || x.label.startsWith(`${label}?`));
        expect(
          name,
          row && row.count > 0,
          `no recorded calls for "${label}" (recorded: ${routes.map((x) => x.label).join(', ') || 'nothing'})`,
        );
      }
    }
    for (const r of results)
      for (const v of r.verdicts ?? []) expect(r.scenario, v.ok, `${v.name}: ${v.detail}`);
    const files = readdirSync(out).filter((f) => f.endsWith('.json'));
    expect('result files', files.length === 6, `${files.length} result files, expected 6`);
    for (const f of files) JSON.parse(readFileSync(join(out, f), 'utf8'));
  });
} finally {
  rmSync(out, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`\nsmoke run FAILED:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nsmoke run passed: six scenarios, tiny scale, real stack');

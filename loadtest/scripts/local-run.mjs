#!/usr/bin/env node
// A REDUCED-scale run of the scenarios on the local E2E stack (API, worker and PostgreSQL 17 on THIS machine, the database lms_e2e, relaxed rate limits),
// for the numbers recorded in docs/benchmarks.md ("Step 14b"). Everything except the scenario flags is fixed:
//   pnpm loadtest:local -- --scale 0.1 --time-scale 0.1 [--scenario exam,video] [--with-browsing 50]
// `--scale` and `--time-scale` with the SAME value keep the arrival rates of full scale (fewer people, shorter windows); the per-person cadences stay real.
// The generator, the API, the worker and the database share one machine here: the numbers say what THIS laptop does, never what Cloud Run and Cloud SQL do.

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { withStack } from '../../frontend/scripts/stack.mjs';
import { OPTION_DEFS, resolveConfig } from '../src/config.mjs';
import { runScenarios } from '../src/run.mjs';
import { seed } from '../src/seed.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));

const { values } = parseArgs({
  options: OPTION_DEFS,
  strict: true,
  args: process.argv.slice(2).filter((a) => a !== '--'),
});
const config = resolveConfig(values);
const names = values.scenario.split(',').map((s) => s.trim());

function e2eOwnerUrl() {
  const base = process.env.TEST_DATABASE_URL;
  if (!base)
    throw new Error(
      'TEST_DATABASE_URL is not set (the local run uses the same server as the E2E suite)',
    );
  const u = new URL(base);
  u.pathname = '/lms_e2e';
  return u.toString();
}

const outDir = values.out ?? join(ROOT, 'loadtest', 'results');
mkdirSync(outDir, { recursive: true });
let failed = false;
// the production lifetime of a playback session (the E2E stack shortens it to 20 s so that its expiry test is quick)
process.env.E2E_VIDEO_TTL ??= '7200';
await withStack(async ({ apiPort, password }) => {
  process.env.LOADTEST_DATABASE_URL = e2eOwnerUrl();
  process.env.DB_SSL = process.env.DB_SSL ?? 'off';
  const api = `http://127.0.0.1:${apiPort}`;
  const slug = 'bench-lt-local';
  const host = `${slug}.localhost:${apiPort}`;
  const people = Math.max(config.learners, config.viewers, config.browsers);
  const { state } = await seed({
    api,
    host,
    slug,
    learners: people,
    instructors: Math.max(2, config.graders),
    password: `${password}-Lt1`.slice(0, 40),
    videoSeconds: 120,
    noVideo: false,
  });
  const run = await runScenarios({
    state,
    api,
    host,
    names,
    config,
    outDir,
    enforce: values.enforce,
  });
  failed = run.failed;
});
process.exit(failed ? 1 : 0);

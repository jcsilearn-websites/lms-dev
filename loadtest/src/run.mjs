// node loadtest/src/run.mjs --state <slug> --api <url> [--host <Host header>] [--scenario all|login-wave,exam,assignment,video,grading,browsing]
//                           [--scale 0.1] [--time-scale 0.05] [--with-browsing 200] [--out loadtest/results] [--enforce]
// Runs the scenarios one after the other against the college the seed made, prints one table per scenario and writes a JSON file per scenario.
// It refuses a production environment and any host that is not on the allowlist (src/guard.mjs). Exit code 0 unless a scenario crashed, or --enforce is
// given and a verdict failed.

import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createTarget } from './client.mjs';
import { OPTION_DEFS, resolveConfig } from './config.mjs';
import assignment from './scenarios/assignment.mjs';
import browsing from './scenarios/browsing.mjs';
import { loadState } from './scenarios/common.mjs';
import exam from './scenarios/exam.mjs';
import grading from './scenarios/grading.mjs';
import loginWave from './scenarios/login-wave.mjs';
import video from './scenarios/video.mjs';
import { mulberry32 } from './schedule.mjs';
import { formatTable, Recorder, verdicts } from './stats.mjs';

export const SCENARIOS = [loginWave, exam, assignment, video, grading, browsing];
const ROOT = join(import.meta.dirname, '..', '..');

const round = (x, d = 1) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

export async function runScenarios({
  state,
  api,
  host,
  names,
  config,
  outDir,
  log = (m) => console.log(m),
  enforce = false,
}) {
  const target = createTarget({ baseUrl: api, host, connections: config.connections });
  const chosen = names.includes('all')
    ? SCENARIOS
    : names.map(
        (n) =>
          SCENARIOS.find((s) => s.name === n) ??
          (() => {
            throw new Error(`unknown scenario "${n}" (${SCENARIOS.map((s) => s.name).join(', ')})`);
          })(),
      );
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const results = [];
  let failed = false;
  try {
    for (const sc of chosen) {
      log(`\n== ${sc.name}: ${sc.describe}`);
      const prep = new Recorder({ seed: config.seed });
      const rng = mulberry32(config.seed);
      const ctx = { config, state, target, prep, rng, log };
      const loop = monitorEventLoopDelay({ resolution: 10 });
      loop.enable();
      const load0 = loadavg();
      const t0 = performance.now();
      let outcome;
      try {
        // optional background browsing during the scenario: the realistic mix (a hand-in burst while others read)
        const bg =
          config.withBrowsing > 0 && sc.name !== 'browsing'
            ? browsing.run({
                ...ctx,
                config: { ...config, browsers: config.withBrowsing },
                rng: mulberry32(config.seed + 1),
              })
            : null;
        outcome = await sc.run(ctx);
        const background = bg ? await bg : null;
        if (background?.recorder) outcome.background = background.recorder.summary();
      } catch (err) {
        failed = true;
        log(`! ${sc.name} crashed: ${err.message}`);
        results.push({ scenario: sc.name, crashed: err.message });
        loop.disable();
        continue;
      }
      loop.disable();
      const seconds = (performance.now() - t0) / 1000;
      if (outcome.skipped) {
        log(`  skipped: ${outcome.skipped}`);
        results.push({ scenario: sc.name, skipped: outcome.skipped });
        continue;
      }
      const rows = outcome.recorder.summary();
      const gen = {
        eventLoopDelayP99Ms: round(loop.percentile(99) / 1e6, 1),
        eventLoopDelayMaxMs: round(loop.max / 1e6, 1),
      };
      const lag = outcome.lag?.count ? outcome.lag : undefined;
      const checks = verdicts(rows, {
        lag,
        maxErrorRate: config.maxErrorRate,
        ignoreLabels: outcome.ignoreLabels,
      });
      log(formatTable(rows));
      for (const n of outcome.notes ?? []) log(`  ${n}`);
      if (outcome.background)
        log(
          `  (background browsing: ${outcome.background.reduce((s, r) => s + r.count, 0)} requests, ${outcome.background.reduce((s, r) => s + r.failed, 0)} failed)`,
        );
      log(
        `  generator: event-loop delay p99 ${gen.eventLoopDelayP99Ms} ms${lag ? `, start lag p95 ${round(lag.p95, 0)} ms` : ''}`,
      );
      for (const c of checks) log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
      if (checks.some((c) => !c.ok) && enforce) failed = true;
      const result = {
        scenario: sc.name,
        seconds: round(seconds, 1),
        config: { ...config },
        notes: outcome.notes ?? [],
        routes: rows,
        background: outcome.background,
        lag,
        generator: {
          ...gen,
          cpus: cpus().length,
          loadavgStart: load0.map((x) => round(x, 2)),
          loadavgEnd: loadavg().map((x) => round(x, 2)),
          node: process.version,
          os: `${platform()} ${release()}`,
        },
        preparation: prep
          .summary()
          .map(({ label, count, p50, p95, failed: f }) => ({ label, count, p50, p95, failed: f })),
        verdicts: checks,
      };
      results.push(result);
      writeFileSync(
        join(outDir, `${stamp}-${sc.name}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    }
  } finally {
    await target.close();
  }
  return { results, failed };
}

async function main() {
  const { values } = parseArgs({ options: OPTION_DEFS, strict: true });
  if (process.env.NODE_ENV === 'production') throw new Error('refusing: NODE_ENV is production');
  if (!values.state)
    throw new Error(
      '--state <slug or path of the seed state file> is required (run loadtest/src/seed.mjs first)',
    );
  const state = loadState(values.state);
  const config = resolveConfig(values);
  const api = values.api ?? state.api;
  const host = values.host ?? state.host;
  const { results, failed } = await runScenarios({
    state,
    api,
    host,
    names: values.scenario.split(',').map((s) => s.trim()),
    config,
    outDir: values.out ?? join(ROOT, 'loadtest', 'results'),
    enforce: values.enforce,
  });
  console.log(`\n${results.length} scenario(s) done${failed ? ' - with failures' : ''}`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'the load run failed');
    process.exit(1);
  });
}

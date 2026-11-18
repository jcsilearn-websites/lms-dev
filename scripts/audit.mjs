#!/usr/bin/env node
// Dependency audit gate (step 14a, docs/dependency-policy.md):  node scripts/audit.mjs [--level high|critical|moderate]
// Runs `pnpm audit` against the PUBLIC npm registry (the project's mirror has no audit endpoint) and fails on any advisory at or above
// the level that has no unexpired, reviewed exception in audit-allowlist.json. The policy itself is backend/src/cli/audit-policy.ts.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { advisoriesOf, evaluateAudit } from '../backend/src/cli/audit-policy.ts';

const levelArg = process.argv.indexOf('--level');
const threshold = levelArg === -1 ? 'high' : process.argv[levelArg + 1];
const registry = process.env.AUDIT_REGISTRY ?? 'https://registry.npmjs.org';
const isWindows = process.platform === 'win32';

const run = spawnSync(
  isWindows ? 'pnpm.cmd' : 'pnpm',
  ['audit', '--registry', registry, '--json'],
  {
    encoding: 'utf8',
    shell: isWindows,
    maxBuffer: 64 * 1024 * 1024,
  },
);
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error(
    'could not read the output of `pnpm audit --json`:',
    (run.stdout || run.stderr || '').slice(0, 400),
  );
  process.exit(2);
}
if (report.error) {
  console.error(`pnpm audit failed: ${report.error.message ?? JSON.stringify(report.error)}`);
  process.exit(2);
}

const exceptions =
  JSON.parse(readFileSync(new URL('../audit-allowlist.json', import.meta.url), 'utf8'))
    .exceptions ?? [];
const verdict = evaluateAudit({ advisories: advisoriesOf(report), exceptions, threshold });

const line = (a) =>
  `${a.severity.toUpperCase().padEnd(8)} ${a.package} ${a.vulnerableVersions}  ${a.id}  ${a.title}\n           via ${a.path}`;
for (const a of verdict.failing) console.error(`FAIL  ${line(a)}`);
for (const p of verdict.exceptionProblems) console.error(`FAIL  ${p}`);
for (const { advisory, exception } of verdict.excepted)
  console.log(
    `ok    excepted until ${exception.expires}: ${advisory.package} ${advisory.id} (${exception.reason.slice(0, 80)})`,
  );
for (const e of verdict.stale)
  console.warn(
    `warn  stale exception (no such advisory any more): ${e.id} ${e.package}: remove it`,
  );
for (const a of verdict.belowThreshold)
  console.log(`info  below ${threshold}: ${a.severity} ${a.package} ${a.id}`);
console.log(
  verdict.ok ? `dependency audit passed (threshold: ${threshold})` : 'dependency audit FAILED',
);
process.exit(verdict.ok ? 0 : 1);

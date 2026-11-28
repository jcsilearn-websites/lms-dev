#!/usr/bin/env node
// The DEMO COLLEGE in a real browser (docs/demo-walkthrough.md): a freshly reset lms_e2e database, `pnpm demo:seed` run while
// nothing else is running (a worker would take the administrator's set-up e-mail), then the stack, and every demo role signs in
// and loads its main screens (e2e/demo). All of them use the instance where two-step sign-in is REQUIRED, as the demo does.
// Usage: node scripts/e2e-demo.mjs   (E2E_SKIP_BUILD=1 reuses dist/)
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { FRONTEND, MFA_WEB_PORT, run, withStack } from './stack.mjs';

const isWindows = process.platform === 'win32';
const SLUG = 'demo-e2e';
const STATE_DIR = join(FRONTEND, '.e2e-tmp', 'demo');

function seed(serviceEnv) {
  console.log('> seeding the demo college');
  rmSync(STATE_DIR, { recursive: true, force: true });
  const done = run(
    'pnpm',
    ['--filter', '@lms/backend', 'exec', 'tsx', 'src/cli/demo.ts', 'seed', '--slug', SLUG],
    { env: { ...serviceEnv, MFA_ENFORCEMENT: 'required', DEMO_STATE_DIR: STATE_DIR } },
  );
  // the command prints the sign-in secrets: they stay out of the log
  if (done.status !== 0) {
    process.stderr.write(done.stderr ?? '');
    throw new Error('the demo seed failed');
  }
}

let code = 1;
try {
  code = await withStack(
    () => {
      console.log('> running Playwright (demo)');
      const result = spawnSync(
        isWindows ? 'npx.cmd' : 'npx',
        ['playwright', 'test', '--config', 'playwright.demo.config.ts', ...process.argv.slice(2)],
        {
          cwd: FRONTEND,
          stdio: 'inherit',
          shell: isWindows,
          env: {
            ...process.env,
            E2E_WEB_PORT: String(MFA_WEB_PORT),
            E2E_DEMO_STATE: join(STATE_DIR, `${SLUG}.json`),
          },
        },
      );
      return result.status ?? 1;
    },
    { mfa: true, prepare: seed },
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
}
process.exit(code);

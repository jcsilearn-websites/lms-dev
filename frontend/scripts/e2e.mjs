#!/usr/bin/env node
// Runs the Playwright end-to-end suite against the REAL stack (see scripts/stack.mjs).
// Usage: node scripts/e2e.mjs [playwright args...]     (E2E_SKIP_BUILD=1 reuses dist/)
import { spawnSync } from 'node:child_process';
import { FRONTEND, withStack } from './stack.mjs';

const isWindows = process.platform === 'win32';
let code = 1;
const startedAt = Date.now();
try {
  code = await withStack(({ webPort, apiPort, mailFile, password }) => {
    console.log('> running Playwright');
    const result = spawnSync(
      isWindows ? 'npx.cmd' : 'npx',
      ['playwright', 'test', ...process.argv.slice(2)],
      {
        cwd: FRONTEND,
        stdio: 'inherit',
        shell: isWindows,
        env: {
          ...process.env,
          E2E_WEB_PORT: String(webPort),
          E2E_API_PORT: String(apiPort),
          E2E_MAIL_FILE: mailFile,
          E2E_PASSWORD: password,
          // when the stack was started: the worker's first notification scan consumes the daily digest of THAT local date (spec 14)
          E2E_STARTED_AT: String(startedAt),
        },
      },
    );
    return result.status ?? 1;
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
}
process.exit(code);

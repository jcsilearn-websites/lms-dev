#!/usr/bin/env node
// The real stack on local PostgreSQL, for the E2E suite, Lighthouse and the screenshots:
//   1. prepare the dedicated database lms_e2e (guarded; created, migrated, TRUNCATEd and seeded
//      before every run; it is never lms_dev or a unit-test database),
//   2. build the SPA and serve it with scripts/serve.mjs (compression, SPA fallback, /api proxy),
//   3. start the API and the worker on their own ports with MAILER=file (the invite and reset links go
//      to a git-ignored JSONL outbox the tests read),
//   4. call `run(info)`, then stop everything.
// Ports differ from the dev servers (web 4173, API 3100): a running `pnpm dev` is not disturbed.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FRONTEND = join(import.meta.dirname, '..');
export const ROOT = join(FRONTEND, '..');
export const WEB_PORT = 4173;
export const API_PORT = 3100;
export const MAIL_FILE = join(ROOT, '.mail', 'e2e-outbox.jsonl');
const isWindows = process.platform === 'win32';

export function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, shell: isWindows, encoding: 'utf8', ...opts });
}

/** Starts the stack, runs `fn({ webPort, apiPort, mailFile, password })`, stops the stack. Returns fn's result. */
export async function withStack(fn, { extraMembers = 0 } = {}) {
  // ---- 1. database
  console.log('> preparing the E2E database (lms_e2e)');
  const prep = run('pnpm', ['--filter', '@lms/backend', 'exec', 'tsx', 'test/e2e-prepare.ts'], {
    env: { ...process.env, E2E_EXTRA_MEMBERS: String(extraMembers) },
  });
  process.stdout.write((prep.stdout ?? '').replace(/^E2E_ENV .*$/m, ''));
  if (prep.status !== 0) {
    process.stderr.write(prep.stderr ?? '');
    console.error('E2E database preparation failed (the guard refuses unsafe databases)');
    process.exit(1);
  }
  const line = (prep.stdout ?? '').split('\n').find((l) => l.startsWith('E2E_ENV '));
  if (!line) throw new Error('e2e-prepare printed no E2E_ENV line');
  const db = JSON.parse(line.slice('E2E_ENV '.length));

  // ---- mail outbox: empty before every run
  mkdirSync(join(ROOT, '.mail'), { recursive: true });
  writeFileSync(MAIL_FILE, '');

  // ---- 2. build
  if (!process.env.E2E_SKIP_BUILD) {
    console.log('> building the SPA');
    const build = run('pnpm', ['--filter', '@lms/frontend', 'exec', 'vite', 'build'], {
      stdio: 'inherit',
    });
    if (build.status !== 0) process.exit(1);
  }

  // ---- 3. services
  const serviceEnv = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(API_PORT),
    HOST: '127.0.0.1',
    DATABASE_URL: db.ownerUrl,
    DATABASE_APP_URL: db.appUrl,
    DB_SSL: db.ssl,
    APP_BASE_DOMAIN: 'localhost',
    APP_PUBLIC_PORT: String(WEB_PORT),
    MAILER: 'file',
    MAIL_FILE,
    LOG_LEVEL: 'warn',
    // one machine, one IP, many sign-ins: the in-memory limits would otherwise get in the way
    RATE_LIMIT_MAX: '100000',
    RATE_LIMIT_LOGIN_PER_IP: '1000',
    RATE_LIMIT_LOGIN_PER_EMAIL: '1000',
    TENANT_CACHE_TTL_MS: '500',
    // the worker polls fast so the import test does not wait for the idle back-off
    JOB_POLL_INTERVAL_MS: '200',
    JOB_POLL_MAX_INTERVAL_MS: '500',
    INVITE_RATE_PER_SECOND: '50',
    // course files: a throwaway directory next to the mail outbox, a fake signing key (the API and the worker share both)
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: join(FRONTEND, '.e2e-tmp', 'storage'),
    STORAGE_SIGNING_SECRET: 'e2e-only-signing-secret-0123456789abcdef',
    // video lessons: ffmpeg from the PATH (development and CI only), a scratch directory, small chunks so even a
    // short clip is uploaded in several requests, and playback links that expire quickly (the expiry test waits)
    VIDEO_PROVIDER: 'local',
    VIDEO_WORK_DIR: join(FRONTEND, '.e2e-tmp', 'video-work'),
    VIDEO_UPLOAD_CHUNK_BYTES: '65536',
    VIDEO_PLAYBACK_TTL_SECONDS: '20',
  };
  const children = [];
  function start(name, cmd, args, shell = isWindows) {
    // shell:false for node itself: its path may contain spaces (C:\Program Files\nodejs)
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: serviceEnv,
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
    children.push(child);
    return child;
  }
  function stopAll() {
    for (const c of children) {
      if (!c.pid) continue;
      if (isWindows)
        spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      else c.kill('SIGTERM');
    }
  }
  process.on('SIGINT', () => {
    stopAll();
    process.exit(130);
  });

  async function waitFor(url, label, ms = 60_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      try {
        const res = await fetch(url);
        if (res.status < 500) return;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`${label} did not start within ${ms / 1000}s`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  let result;
  try {
    console.log('> starting the API, the worker and the web server');
    start('api', 'pnpm', ['--filter', '@lms/backend', 'exec', 'tsx', 'src/server.ts']);
    start('worker', 'pnpm', ['--filter', '@lms/backend', 'exec', 'tsx', 'src/worker.ts']);
    start(
      'web',
      process.execPath,
      [
        join(FRONTEND, 'scripts', 'serve.mjs'),
        '--port',
        String(WEB_PORT),
        '--api',
        `http://127.0.0.1:${API_PORT}`,
      ],
      false,
    );
    await waitFor(`http://127.0.0.1:${API_PORT}/health/live`, 'the API');
    await waitFor(`http://127.0.0.1:${WEB_PORT}/`, 'the web server');
    await new Promise((r) => setTimeout(r, 1500)); // the worker has no port: give it a moment

    result = await fn({
      webPort: WEB_PORT,
      apiPort: API_PORT,
      mailFile: MAIL_FILE,
      password: db.password,
    });
  } catch (err) {
    stopAll();
    throw err;
  }
  stopAll();
  return result;
}

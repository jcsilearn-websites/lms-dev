import { defineConfig } from 'vitest/config';
import { dbWorkerCount, isRemoteDb } from './test/workers';

// Three projects:
//   unit    fast tests with fakes, no database
//   db      tests against a real PostgreSQL: run IN PARALLEL, one database per Vitest worker
//           (<TEST_DATABASE_URL name>_1 ... _N, created and migrated once by test/global-setup.ts; every
//           test file starts with a TRUNCATE of its worker's database)
//   serial  the few files that must run ALONE, after the parallel run (see SERIAL_FILES)
//
// `pnpm test` runs  (unit + db, parallel)  and then  (serial, one worker).
// Profiles: local PostgreSQL (default): 10 s per test, N = CPU cores - 1 workers (TEST_DB_WORKERS overrides).
// REMOTE_DB=1: a slow remote database: 120 s per test, ONE worker on the single given database.
const remote = isRemoteDb();

/** Files that cannot share the machine with parallel workers, and why. */
export const SERIAL_FILES = [
  // runs the migration runner itself: the only code that can ALTER ROLE lms_app (cluster-wide), plus
  // advisory locks, copied migration folders and a deliberately broken migration
  'test/migrate.test.ts',
  // spawns a real server process and delivers SIGTERM: process-level state and wall-clock timing
  'test/shutdown.test.ts',
  // wall-clock timing: 3 s leases, adaptive poll intervals, multi-second jobs and grace periods
  'test/jobs.test.ts',
  'test/worker.test.ts',
  // a 10,000-row import with lease heartbeats; its throughput is only meaningful on an idle machine
  'test/imports.scale.test.ts',
  // real ffmpeg transcodes: every encoder thread the machine has, and multi-second wall-clock work
  'test/video.test.ts',
  'test/video.shutdown.test.ts',
];

export default defineConfig({
  test: {
    maxWorkers: remote ? 1 : dbWorkerCount(),
    fileParallelism: !remote,
    testTimeout: remote ? 120_000 : 10_000,
    hookTimeout: remote ? 60_000 : 30_000,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.unit.test.ts', 'test/**/*.unit.test.ts'],
        },
      },
      {
        test: {
          name: 'db',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['**/*.unit.test.ts', '**/node_modules/**', ...SERIAL_FILES],
          globalSetup: ['./test/global-setup.ts'],
          setupFiles: ['./test/setup.ts'],
        },
      },
      {
        test: {
          name: 'serial',
          include: SERIAL_FILES,
          globalSetup: ['./test/global-setup.ts'],
          setupFiles: ['./test/setup.ts'],
        },
      },
    ],
  },
});

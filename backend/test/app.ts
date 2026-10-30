import { Writable } from 'node:stream';
import { buildApp } from '../src/app';
import { type ApiEnv, apiEnvSchema, parseEnv } from '../src/config/env';
import { createLogger } from '../src/config/logger';
import { createCapturingMailer } from '../src/core/mailer';
import { createDb, type Database } from '../src/db/client';
import { getTestDatabases, testAppDbOptions } from './support';

export function testEnv(overrides: Record<string, string> = {}): ApiEnv {
  const dbs = getTestDatabases();
  // parseEnv (not parseApiEnv): the production-mode tests need no-verify TLS with NODE_ENV=production.
  return parseEnv(apiEnvSchema, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_APP_URL: dbs.appUrl,
    DB_SSL: dbs.ssl,
    // remote test DB: generous readiness timeout so latency cannot make tests flaky
    READY_TIMEOUT_MS: '20000',
    // the dedicated rate-limit tests lower these; everything else logs in many times from one IP
    RATE_LIMIT_LOGIN_PER_IP: '1000',
    RATE_LIMIT_LOGIN_PER_EMAIL: '1000',
    RATE_LIMIT_MAX: '100000',
    // a fake key for the local storage driver (the tests write to a throwaway directory)
    STORAGE_SIGNING_SECRET: 'test-only-signing-secret-0123456789abcdef',
    STORAGE_LOCAL_DIR: process.env.TEST_STORAGE_DIR ?? '.storage-test',
    ...overrides,
  });
}

/** Collects pino JSON lines so tests can assert on what gets logged. */
export function logCapture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      cb();
    },
  });
  return { lines, stream };
}

/** Counts statements sent to Postgres (= network round trips) so tests can enforce query budgets. */
export function statementCounter() {
  let statements: string[] = [];
  return {
    record: (text: string) => statements.push(text),
    reset: () => {
      statements = [];
    },
    get count() {
      return statements.length;
    },
    get statements() {
      return [...statements];
    },
  };
}

export interface TestApp {
  app: ReturnType<typeof buildApp>;
  db: Database;
  /** Round trips since the last reset(). */
  statements: ReturnType<typeof statementCounter>;
  /** Captures every email the app would send (invite and reset links live here). */
  mailer: ReturnType<typeof createCapturingMailer>;
  logs: Record<string, unknown>[];
  close(): Promise<void>;
}

export function makeApp(
  opts: { env?: Record<string, string>; db?: Database; logLevel?: string } = {},
): TestApp {
  const env = testEnv({ ...(opts.logLevel ? { LOG_LEVEL: opts.logLevel } : {}), ...opts.env });
  const statements = statementCounter();
  const db = opts.db ?? createDb({ ...testAppDbOptions(2), onStatement: statements.record });
  const { lines, stream } = logCapture();
  const mailer = createCapturingMailer();
  const app = buildApp({ env, db, logger: createLogger(env, stream), mailer });
  return {
    app,
    db,
    mailer,
    statements,
    logs: lines,
    async close() {
      await app.modules.background.drain();
      await app.close();
      await db.close();
    },
  };
}

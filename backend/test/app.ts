import { Writable } from 'node:stream';
import { buildApp } from '../src/app';
import { type ApiEnv, apiEnvSchema, parseEnv } from '../src/config/env';
import { createLogger } from '../src/config/logger';
import { createCapturingProvider } from '../src/core/mail';
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
    // video: throwaway scratch directory, small chunks so even tiny clips are sent in several requests
    VIDEO_WORK_DIR: process.env.TEST_VIDEO_DIR ?? '.video-work-test',
    VIDEO_UPLOAD_CHUNK_BYTES: '32768',
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

const isInfrastructure = (s: string) =>
  s.includes('lms.activity_touch') || s.includes('lms.rate_limit_hit');

/** Counts statements sent to Postgres (= network round trips) so tests can enforce query budgets. */
export function statementCounter() {
  let statements: string[] = [];
  return {
    record: (text: string) => statements.push(text),
    reset: () => {
      statements = [];
    },
    // The budgets of steps 1-11 are steady-state budgets: the ONE background `activity_touch` of a user's first request of the day
    // (step 12, at most once per user and local day) is not part of them. `raw` has everything; the activity budget test uses it.
    // Likewise the shared rate limiter's autocommit statement (step 14a, `lms.rate_limit_hit`): infrastructure with its own pinned
    // budget (test/rate-limit.shared.test.ts), so the endpoint budgets keep their steady-state numbers.
    get count() {
      return statements.filter((s) => !isInfrastructure(s)).length;
    },
    get statements() {
      return statements.filter((s) => !isInfrastructure(s));
    },
    /** the limiter's statements only */
    get limiter() {
      return statements.filter((s) => s.includes('lms.rate_limit_hit'));
    },
    get raw() {
      return [...statements];
    },
  };
}

export interface TestApp {
  app: ReturnType<typeof buildApp>;
  db: Database;
  /** Round trips since the last reset(). */
  statements: ReturnType<typeof statementCounter>;
  /**
   * Captures every email the app's outbox delivered (invite and reset links live here). Mail is queued in the outbox and
   * sent by the `email.send` job: call deliverEmails(t) (test/client.ts) to run the queued jobs before reading this.
   */
  mailer: ReturnType<typeof createCapturingProvider>;
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
  const mailer = createCapturingProvider();
  const app = buildApp({ env, db, logger: createLogger(env, stream), emailProvider: mailer });
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

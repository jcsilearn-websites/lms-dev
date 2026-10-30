import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Static, type TSchema, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { hostOf, isLocalHost } from './local';
import { DB_SSL_MODES, type DbSsl } from './ssl';

export class EnvError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvError';
  }
}

/**
 * Validate env vars against a TypeBox schema. Error messages name the variable and the
 * problem but NEVER echo the value (values may be secrets).
 */
export function parseEnv<T extends TSchema>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): Static<T> {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') input[key] = value;
  }
  const prepared = Value.Convert(schema, Value.Default(schema, Value.Clean(schema, input)));
  if (!Value.Check(schema, prepared)) {
    const issues = [...Value.Errors(schema, prepared)].map(
      (e) => `${e.path.replace(/^\//, '') || '(root)'}: ${e.message}`,
    );
    throw new EnvError(issues);
  }
  return prepared as Static<T>;
}

/** Load <repo-root>/.env into process.env (never overrides variables already set). */
export function loadDotEnv(startDir: string = process.cwd()): void {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      const file = join(dir, '.env');
      if (existsSync(file)) process.loadEnvFile(file);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

const nodeEnv = Type.Union(
  [Type.Literal('development'), Type.Literal('test'), Type.Literal('production')],
  { default: 'development' },
);
const logLevel = Type.Union(
  ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].map((l) => Type.Literal(l)),
  { default: 'info' },
);
const pgUrl = Type.String({ pattern: '^postgres(ql)?://\\S+$', description: 'PostgreSQL URL' });

const dbSsl = Type.Union(
  DB_SSL_MODES.map((m) => Type.Literal(m)),
  { default: 'off' },
);

const dbAppFields = {
  DATABASE_APP_URL: pgUrl,
  DB_POOL_MAX: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  DB_SSL: dbSsl,
  DB_SSL_CA: Type.Optional(Type.String({ minLength: 1, description: 'Path to CA certificate' })),
};

/** Authentication settings, shared by the API and the worker (all have safe defaults). */
const authFields = {
  APP_BASE_DOMAIN: Type.String({
    default: 'localhost',
    pattern: '^[a-z0-9.-]+$',
    description:
      'Tenant hosts are <slug>.<APP_BASE_DOMAIN>; the admin area is admin.<APP_BASE_DOMAIN>',
  }),
  COOKIE_SECURE: Type.Optional(Type.Boolean()),
  SESSION_IDLE_DAYS: Type.Number({ minimum: 0.01, default: 7 }),
  SESSION_ABSOLUTE_DAYS: Type.Number({ minimum: 0.01, default: 30 }),
  LOGIN_MAX_ATTEMPTS: Type.Integer({ minimum: 3, default: 10 }),
  LOCKOUT_BASE_SECONDS: Type.Integer({ minimum: 1, default: 60 }),
  LOCKOUT_MAX_SECONDS: Type.Integer({ minimum: 1, default: 900 }),
  RATE_LIMIT_LOGIN_PER_IP: Type.Integer({ minimum: 1, default: 10 }),
  RATE_LIMIT_LOGIN_PER_EMAIL: Type.Integer({ minimum: 1, default: 5 }),
  RATE_LIMIT_AUTH_WINDOW_MS: Type.Integer({ minimum: 1000, default: 60_000 }),
  PASSWORD_HASH_CONCURRENCY: Type.Integer({ minimum: 1, maximum: 8, default: 2 }),
  TENANT_CACHE_TTL_MS: Type.Integer({ minimum: 0, default: 60_000 }),
  TENANT_CACHE_MAX: Type.Integer({ minimum: 1, default: 1000 }),
  MAILER: Type.Union([Type.Literal('console'), Type.Literal('file'), Type.Literal('none')], {
    default: 'console',
  }),
  // MAILER=file: the JSONL outbox (dev / E2E only). Git-ignored location by convention: .mail/outbox.jsonl
  MAIL_FILE: Type.Optional(Type.String({ minLength: 1 })),
  // cleanup of dead sessions and used/expired tokens (run by the worker)
  PURGE_RETENTION_DAYS: Type.Integer({ minimum: 0, default: 30 }),
  PURGE_INTERVAL_SECONDS: Type.Integer({ minimum: 1, default: 3600 }),
  PURGE_BATCH_SIZE: Type.Integer({ minimum: 1, maximum: 10_000, default: 1000 }),
};

/** Background job queue settings (the worker polls; the API only enqueues). */
const jobFields = {
  JOB_POLL_INTERVAL_MS: Type.Integer({ minimum: 10, default: 1000 }),
  JOB_POLL_MAX_INTERVAL_MS: Type.Integer({ minimum: 10, default: 10_000 }),
  JOB_LEASE_SECONDS: Type.Integer({ minimum: 3, default: 60 }),
  JOB_MAX_ATTEMPTS: Type.Integer({ minimum: 1, maximum: 100, default: 5 }),
  JOB_BACKOFF_BASE_SECONDS: Type.Integer({ minimum: 1, default: 10 }),
  JOB_BACKOFF_MAX_SECONDS: Type.Integer({ minimum: 1, default: 3600 }),
  // must stay below SHUTDOWN_TIMEOUT_MS (Cloud Run sends SIGTERM and kills after 10 s by default)
  JOB_SHUTDOWN_GRACE_SECONDS: Type.Integer({ minimum: 0, default: 8 }),
  JOB_CONCURRENCY: Type.String({
    default: 'default:2',
    pattern: '^[a-z0-9_.-]+:[1-9][0-9]{0,2}(,[a-z0-9_.-]+:[1-9][0-9]{0,2})*$',
    description: 'Max jobs running at once per queue, e.g. imports:1,invites:4,default:2',
  }),
  JOBS_COMPLETED_RETENTION_DAYS: Type.Integer({ minimum: 0, default: 7 }),
  JOBS_DEAD_RETENTION_DAYS: Type.Integer({ minimum: 0, default: 30 }),
};

/** Bulk CSV import settings (the API validates uploads, the worker applies them). */
const importFields = {
  IMPORT_MAX_BYTES: Type.Integer({ minimum: 1024, default: 5 * 1024 * 1024 }),
  IMPORT_MAX_ROWS: Type.Integer({ minimum: 1, maximum: 100_000, default: 10_000 }),
  IMPORT_BATCH_SIZE: Type.Integer({ minimum: 1, maximum: 1000, default: 500 }),
  // staged rows hold names and emails: deleted this many days after an import finished
  IMPORT_RETENTION_DAYS: Type.Integer({ minimum: 0, default: 7 }),
  // invite emails of an import are spread out to at most this many per second
  INVITE_RATE_PER_SECOND: Type.Number({ minimum: 0.1, maximum: 1000, default: 5 }),
  // development only: the port of the web app in links of queued emails (production URLs have none)
  APP_PUBLIC_PORT: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
};

/** File storage (course files). `local` is a development driver: it is refused when NODE_ENV=production. */
const storageFields = {
  STORAGE_DRIVER: Type.Union([Type.Literal('local'), Type.Literal('gcs')], { default: 'local' }),
  // local driver: where the bytes go (git-ignored by convention: .storage)
  STORAGE_LOCAL_DIR: Type.String({ minLength: 1, default: '.storage' }),
  // local driver: HMAC key of the signed upload / download URLs (>= 32 characters, never committed)
  STORAGE_SIGNING_SECRET: Type.Optional(Type.String({ minLength: 32 })),
  STORAGE_MAX_FILE_BYTES: Type.Integer({ minimum: 1024, default: 50 * 1024 * 1024 }),
  STORAGE_URL_TTL_SECONDS: Type.Integer({ minimum: 10, maximum: 3600, default: 300 }),
  // gcs driver (a later step): the bucket
  STORAGE_GCS_BUCKET: Type.Optional(Type.String({ minLength: 3 })),
  // an unreferenced file is deleted this long after upload confirmation / its last reference was removed
  FILE_PURGE_GRACE_HOURS: Type.Integer({ minimum: 0, default: 24 }),
  FILE_PURGE_INTERVAL_SECONDS: Type.Integer({ minimum: 1, default: 3600 }),
};

/**
 * Video lessons (step 7). `local` (ffmpeg in the worker, HLS served by this API) is for development and CI ONLY:
 * it is refused when NODE_ENV=production, and ffmpeg is never shipped in a production image. Production uses a
 * managed provider (`gcp` Transcoder API, or a video service such as `bunny`), which carries the codec licensing.
 */
const videoFields = {
  VIDEO_PROVIDER: Type.Union([Type.Literal('local'), Type.Literal('gcp'), Type.Literal('bunny')], {
    default: 'local',
  }),
  // HMAC key of the playback tokens (>= 32 characters). Absent: derived (HKDF, own label) from STORAGE_SIGNING_SECRET.
  VIDEO_SIGNING_SECRET: Type.Optional(Type.String({ minLength: 32 })),
  VIDEO_MAX_BYTES: Type.Integer({ minimum: 1024, default: 2 * 1024 * 1024 * 1024 }),
  VIDEO_MAX_DURATION_SECONDS: Type.Integer({ minimum: 1, default: 3 * 3600 }),
  // one PATCH of the resumable upload carries at most this many bytes
  VIDEO_UPLOAD_CHUNK_BYTES: Type.Integer({
    minimum: 16 * 1024,
    maximum: 64 * 1024 * 1024,
    default: 8 * 1024 * 1024,
  }),
  // a playback session (and its token) is valid this long; the player asks for a new one when it expires
  VIDEO_PLAYBACK_TTL_SECONDS: Type.Integer({ minimum: 2, maximum: 86_400, default: 7200 }),
  // segment requests re-use a validated (session, asset) pair for this long (a revoked session may play on
  // for at most this long) in a cache of at most VIDEO_SESSION_CACHE_MAX entries
  VIDEO_SESSION_CACHE_TTL_SECONDS: Type.Integer({ minimum: 0, maximum: 600, default: 60 }),
  VIDEO_SESSION_CACHE_MAX: Type.Integer({ minimum: 1, default: 10_000 }),
  // the uploaded original is kept this many days after a successful transcode, then deleted
  VIDEO_SOURCE_RETENTION_DAYS: Type.Integer({ minimum: 0, default: 30 }),
  // an abandoned upload / an unreferenced video is deleted this long after its last activity
  VIDEO_UPLOAD_GRACE_HOURS: Type.Integer({ minimum: 0, default: 24 }),
  VIDEO_PURGE_INTERVAL_SECONDS: Type.Integer({ minimum: 1, default: 3600 }),
  // local provider: scratch space of the transcoder (one directory per job)
  VIDEO_WORK_DIR: Type.String({ minLength: 1, default: '.video-work' }),
  FFMPEG_PATH: Type.String({ minLength: 1, default: 'ffmpeg' }),
  FFPROBE_PATH: Type.String({ minLength: 1, default: 'ffprobe' }),
  // a transcode is killed after max(10 min, factor x the video's duration)
  VIDEO_TRANSCODE_TIMEOUT_FACTOR: Type.Number({ minimum: 0.5, default: 8 }),
  // encoder threads per ffmpeg process (0 = ffmpeg decides)
  VIDEO_FFMPEG_THREADS: Type.Integer({ minimum: 0, maximum: 64, default: 0 }),
};

export const apiEnvSchema = Type.Object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  HOST: Type.String({ default: '0.0.0.0' }),
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 3000 }),
  CORS_ORIGINS: Type.String({ default: '', description: 'Comma-separated allowed origins' }),
  BODY_LIMIT_BYTES: Type.Integer({ minimum: 1024, default: 1_048_576 }),
  RATE_LIMIT_MAX: Type.Integer({ minimum: 1, default: 300 }),
  RATE_LIMIT_WINDOW_MS: Type.Integer({ minimum: 1000, default: 60_000 }),
  READY_TIMEOUT_MS: Type.Integer({ minimum: 100, default: 2000 }),
  SHUTDOWN_TIMEOUT_MS: Type.Integer({ minimum: 1000, default: 10_000 }),
  TRUST_PROXY: Type.Boolean({ default: false }),
  ...authFields,
  ...jobFields,
  ...importFields,
  ...storageFields,
  ...videoFields,
  ...dbAppFields,
});
export type ApiEnv = Static<typeof apiEnvSchema>;

export const workerEnvSchema = Type.Object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  SHUTDOWN_TIMEOUT_MS: Type.Integer({ minimum: 1000, default: 10_000 }),
  ...authFields,
  ...jobFields,
  ...importFields,
  ...storageFields,
  ...videoFields,
  ...dbAppFields,
});
export type WorkerEnv = Static<typeof workerEnvSchema>;

/** Owner/migration connection. The password must be URL-safe so it needs no encoding. */
export const migrateEnvSchema = Type.Object({
  DATABASE_URL: pgUrl,
  DATABASE_APP_URL: pgUrl,
  LMS_APP_PASSWORD: Type.String({ minLength: 24, pattern: '^[A-Za-z0-9._~-]+$' }),
  NODE_ENV: nodeEnv,
  /** Dev-only password given to seeded users; the seed refuses to run in production. */
  SEED_USER_PASSWORD: Type.Optional(Type.String({ minLength: 10, maxLength: 128 })),
  DB_SSL: dbSsl,
  DB_SSL_CA: Type.Optional(Type.String({ minLength: 1 })),
});
export type MigrateEnv = Static<typeof migrateEnvSchema>;

/** Owner-only scripts (bootstrap CLI): just the owner connection. */
export const ownerEnvSchema = Type.Object({
  DATABASE_URL: pgUrl,
  NODE_ENV: nodeEnv,
  DB_SSL: dbSsl,
  DB_SSL_CA: Type.Optional(Type.String({ minLength: 1 })),
});

export const testEnvSchema = Type.Object({
  TEST_DATABASE_URL: pgUrl,
  TEST_DATABASE_APP_URL: pgUrl,
  DATABASE_URL: Type.Optional(pgUrl),
  DATABASE_APP_URL: Type.Optional(pgUrl),
  DB_SSL: dbSsl,
  DB_SSL_CA: Type.Optional(Type.String({ minLength: 1 })),
});

/** Pool size: explicit DB_POOL_MAX, else 10 in production and 5 elsewhere. */
export function resolvePoolMax(env: {
  NODE_ENV: string;
  DB_POOL_MAX?: number | undefined;
}): number {
  return env.DB_POOL_MAX ?? (env.NODE_ENV === 'production' ? 10 : 5);
}

/**
 * TLS policy for the database connection (NODE_ENV and DB_SSL, plus the hosts the URLs name):
 *  - `no-verify` (TLS without certificate verification) is for development and test only;
 *  - `off` (no TLS at all) is for a database on THIS machine: localhost / 127.0.0.1, and never in
 *    production. Any other host needs `verify-full` (+ DB_SSL_CA), or `no-verify` in development.
 * Messages never echo host names or values.
 */
export function assertSslPolicy(
  env: { NODE_ENV: string; DB_SSL: DbSsl },
  urls: readonly (string | undefined)[] = [],
): void {
  const issues: string[] = [];
  if (env.DB_SSL === 'no-verify' && env.NODE_ENV === 'production') {
    issues.push(
      'DB_SSL: "no-verify" is not allowed when NODE_ENV=production (use "verify-full" with DB_SSL_CA)',
    );
  }
  if (env.DB_SSL === 'off') {
    if (env.NODE_ENV === 'production') {
      issues.push(
        'DB_SSL: "off" is not allowed when NODE_ENV=production (use "verify-full" with DB_SSL_CA)',
      );
    } else if (urls.some((u) => u !== undefined && !isLocalHost(hostOf(u) ?? ''))) {
      issues.push(
        'DB_SSL: "off" is only allowed for a database on localhost / 127.0.0.1 (a remote host needs "verify-full" with DB_SSL_CA, or "no-verify" in development)',
      );
    }
  }
  if (issues.length > 0) throw new EnvError(issues);
}

export function parseApiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  const env = parseEnv(apiEnvSchema, source);
  assertSslPolicy(env, [env.DATABASE_APP_URL]);
  assertAuthPolicy(env, source);
  assertStoragePolicy(env);
  assertVideoPolicy(env);
  return env;
}

/**
 * The local storage driver keeps files on the server's disk and serves them through signed URLs of this API: a
 * development convenience. Production must use object storage, so `local` is refused there; a local driver
 * also needs its signing secret.
 */
export function assertStoragePolicy(env: {
  NODE_ENV: string;
  STORAGE_DRIVER: string;
  STORAGE_SIGNING_SECRET?: string | undefined;
  STORAGE_GCS_BUCKET?: string | undefined;
}): void {
  const issues: string[] = [];
  if (env.STORAGE_DRIVER === 'local') {
    if (env.NODE_ENV === 'production') {
      issues.push(
        'STORAGE_DRIVER: "local" is a development driver and is not allowed when NODE_ENV=production',
      );
    }
    if (!env.STORAGE_SIGNING_SECRET) {
      issues.push('STORAGE_SIGNING_SECRET: required (32+ characters) when STORAGE_DRIVER=local');
    }
  } else if (!env.STORAGE_GCS_BUCKET) {
    issues.push('STORAGE_GCS_BUCKET: required when STORAGE_DRIVER=gcs');
  }
  if (issues.length > 0) throw new EnvError(issues);
}

/**
 * The local video provider needs ffmpeg and serves HLS from this API: development and CI only. Production uses a
 * managed provider, so `local` is refused when NODE_ENV=production (ffmpeg, which is GPL-licensed with libx264, is
 * never shipped in a production image). It also stores everything through the local storage driver.
 */
export function assertVideoPolicy(env: {
  NODE_ENV: string;
  VIDEO_PROVIDER: string;
  STORAGE_DRIVER: string;
}): void {
  if (env.VIDEO_PROVIDER !== 'local') return;
  const issues: string[] = [];
  if (env.NODE_ENV === 'production') {
    issues.push(
      'VIDEO_PROVIDER: "local" (ffmpeg in the worker) is a development driver and is not allowed when NODE_ENV=production',
    );
  }
  if (env.STORAGE_DRIVER !== 'local') {
    issues.push('VIDEO_PROVIDER: "local" needs STORAGE_DRIVER=local');
  }
  if (issues.length > 0) throw new EnvError(issues);
}

/** Production must configure the base domain explicitly and may not use the console mailer. */
export function assertAuthPolicy(
  env: { NODE_ENV: string; MAILER: string; MAIL_FILE?: string | undefined },
  source: Record<string, string | undefined>,
): void {
  if (env.MAILER === 'file' && !env.MAIL_FILE) {
    throw new EnvError(['MAIL_FILE: required when MAILER=file']);
  }
  if (env.NODE_ENV !== 'production') return;
  const issues: string[] = [];
  if (!source.APP_BASE_DOMAIN) issues.push('APP_BASE_DOMAIN: required when NODE_ENV=production');
  if (env.MAILER === 'console') {
    issues.push(
      'MAILER: "console" is a dev mailer (it logs links) and is not allowed in production',
    );
  }
  if (env.MAILER === 'file') {
    issues.push(
      'MAILER: "file" writes links to disk in clear text and is not allowed in production',
    );
  }
  if (issues.length > 0) throw new EnvError(issues);
}

/** Session cookie settings: Secure everywhere except local development/test. */
export function cookieSettings(env: Pick<ApiEnv, 'NODE_ENV' | 'COOKIE_SECURE'>) {
  const secure = env.COOKIE_SECURE ?? env.NODE_ENV === 'production';
  return { secure, name: secure ? '__Host-sid' : 'sid' };
}

export function parseWorkerEnv(
  source: Record<string, string | undefined> = process.env,
): WorkerEnv {
  const env = parseEnv(workerEnvSchema, source);
  assertSslPolicy(env, [env.DATABASE_APP_URL]);
  assertStoragePolicy(env);
  assertVideoPolicy(env);
  return env;
}

export function parseMigrateEnv(
  source: Record<string, string | undefined> = process.env,
): MigrateEnv {
  const env = parseEnv(migrateEnvSchema, source);
  assertSslPolicy(env, [env.DATABASE_URL, env.DATABASE_APP_URL]);
  return env;
}

export function parseOwnerEnv(
  source: Record<string, string | undefined> = process.env,
): Static<typeof ownerEnvSchema> {
  const env = parseEnv(ownerEnvSchema, source);
  assertSslPolicy(env, [env.DATABASE_URL]);
  return env;
}

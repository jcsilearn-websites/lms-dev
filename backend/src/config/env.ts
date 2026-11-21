import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Static, type TSchema, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { parseSigningKeys } from '../core/keyring';
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
  // client-side deadline of one statement. Unset: 30 s in the API, none in the worker (a rollup refresh may run for minutes). 0 = none.
  DB_QUERY_TIMEOUT_MS: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600_000 })),
  DB_SSL: dbSsl,
  DB_SSL_CA: Type.Optional(Type.String({ minLength: 1, description: 'Path to CA certificate' })),
};

/**
 * Email delivery and notifications (step 13, ADR 0021). EMAIL_PROVIDER picks the delivery (falls back to MAILER):
 * smtp and sendgrid are real; console / file / none are development tools and are refused in production.
 */
const emailFields = {
  EMAIL_PROVIDER: Type.Optional(
    Type.Union([
      Type.Literal('smtp'),
      Type.Literal('sendgrid'),
      Type.Literal('console'),
      Type.Literal('file'),
      Type.Literal('none'),
    ]),
  ),
  // the From of mail with no verified college address: "<College> via JCS iLearn" <EMAIL_FROM_DEFAULT>
  EMAIL_FROM_DEFAULT: Type.Optional(
    Type.String({ pattern: '^[^\\s@<>",]+@[^\\s@<>",]+\\.[^\\s@<>",]+$' }),
  ),
  EMAIL_FROM_NAME: Type.String({ minLength: 1, maxLength: 80, default: 'JCS iLearn' }),
  // sends per second per worker process (token bucket); the provider sees at most this x the number of workers
  EMAIL_RATE_PER_SECOND: Type.Number({ minimum: 0.1, maximum: 1000, default: 10 }),
  // finished outbox rows (and provider webhook events) are deleted after this many days
  EMAIL_OUTBOX_RETENTION_DAYS: Type.Integer({ minimum: 1, maximum: 365, default: 30 }),
  EMAIL_SEND_TIMEOUT_MS: Type.Integer({ minimum: 1000, maximum: 120_000, default: 20_000 }),
  // circuit breaker around the provider (step 14a): this many consecutive failures open it; calls are then refused (the jobs are
  // deferred, no attempt charged) for the cooldown, after which ONE trial send is admitted (the cooldown doubles after a failed trial)
  EMAIL_BREAKER_FAILURES: Type.Integer({ minimum: 1, maximum: 100, default: 5 }),
  EMAIL_BREAKER_COOLDOWN_SECONDS: Type.Integer({ minimum: 1, maximum: 3600, default: 30 }),
  SMTP_HOST: Type.Optional(Type.String({ minLength: 1 })),
  SMTP_PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 587 }),
  // implicit = TLS from the first byte (465); starttls = upgrade required (587); off = development only
  SMTP_TLS: Type.Union([Type.Literal('starttls'), Type.Literal('implicit'), Type.Literal('off')], {
    default: 'starttls',
  }),
  SMTP_USER: Type.Optional(Type.String({ minLength: 1 })),
  SMTP_PASSWORD: Type.Optional(Type.String({ minLength: 1 })),
  SMTP_MAX_CONNECTIONS: Type.Integer({ minimum: 1, maximum: 20, default: 3 }),
  SENDGRID_API_KEY: Type.Optional(Type.String({ minLength: 10 })),
  SENDGRID_API_URL: Type.String({ pattern: '^https://', default: 'https://api.sendgrid.com' }),
  // the PUBLIC key of SendGrid's signed event webhook (base64 DER or PEM); absent = the webhook answers 503
  SENDGRID_WEBHOOK_PUBLIC_KEY: Type.Optional(Type.String({ minLength: 40 })),
  // a webhook whose timestamp is further than this from now is refused (replay)
  EMAIL_WEBHOOK_TOLERANCE_SECONDS: Type.Integer({ minimum: 30, maximum: 3600, default: 300 }),
  // HMAC key of the unsubscribe tokens (>= 32 characters). Absent: derived (HKDF, own label) from STORAGE_SIGNING_SECRET.
  NOTIFY_SIGNING_SECRET: Type.Optional(Type.String({ minLength: 32 })),
  UNSUBSCRIBE_TOKEN_DAYS: Type.Integer({ minimum: 1, maximum: 365, default: 90 }),
  // the scan for reminders, digests and weekly summaries runs this often
  NOTIFY_SCAN_SECONDS: Type.Integer({ minimum: 5, maximum: 3600, default: 300 }),
  // read in-app notifications are deleted after this many days (unread ones are kept)
  NOTIFICATIONS_READ_RETENTION_DAYS: Type.Integer({ minimum: 1, maximum: 3650, default: 90 }),
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
  // "download my data" asks for the password again: this many requests an hour per address (the strict, shared limiter)
  DATA_EXPORT_RATE_PER_HOUR: Type.Integer({ minimum: 1, default: 10 }),
  PASSWORD_HASH_CONCURRENCY: Type.Integer({ minimum: 1, maximum: 8, default: 2 }),
  TENANT_CACHE_TTL_MS: Type.Integer({ minimum: 0, default: 60_000 }),
  TENANT_CACHE_MAX: Type.Integer({ minimum: 1, default: 1000 }),
  // DEPRECATED alias of EMAIL_PROVIDER (step 13; kept one step for existing .env files): console | file | none
  MAILER: Type.Union([Type.Literal('console'), Type.Literal('file'), Type.Literal('none')], {
    default: 'console',
  }),
  // EMAIL_PROVIDER=file: the JSONL outbox (dev / E2E only). Git-ignored location by convention: .mail/outbox.jsonl
  MAIL_FILE: Type.Optional(Type.String({ minLength: 1 })),
  ...emailFields,
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
  // hard deadline of ONE storage operation (inspect, read, remove, ...); a deadline or an I/O error is a clean 503 (step 14a)
  STORAGE_OPERATION_TIMEOUT_MS: Type.Integer({ minimum: 100, maximum: 600_000, default: 30_000 }),
  // gcs driver (a later step): the bucket
  STORAGE_GCS_BUCKET: Type.Optional(Type.String({ minLength: 3 })),
  // an unreferenced file is deleted this long after upload confirmation / its last reference was removed
  FILE_PURGE_GRACE_HOURS: Type.Integer({ minimum: 0, default: 24 }),
  FILE_PURGE_INTERVAL_SECONDS: Type.Integer({ minimum: 1, default: 3600 }),
  // assessments (step 9): answers are accepted this long after the server deadline (network delay), then the attempt is
  // closed; the worker's sweeper closes attempts nobody submitted every ASSESSMENT_SWEEP_SECONDS, ...BATCH at a time
  ASSESSMENT_SAVE_GRACE_SECONDS: Type.Integer({ minimum: 0, maximum: 300, default: 30 }),
  ASSESSMENT_SWEEP_SECONDS: Type.Integer({ minimum: 1, maximum: 3600, default: 15 }),
  ASSESSMENT_SWEEP_BATCH: Type.Integer({ minimum: 1, maximum: 1000, default: 200 }),
  // analytics (step 12): the rollup refresh runs every ANALYTICS_ROLLUP_SECONDS (learners per statement: ANALYTICS_ROLLUP_BATCH); a
  // month is closed for billing USAGE_CLOSE_INTERVAL_SECONDS after the check finds it ended; USAGE_RENDITION_MIX is the assumed
  // share of viewing per rendition (JSON) used to estimate the video GB delivered
  ANALYTICS_ROLLUP_SECONDS: Type.Integer({ minimum: 5, maximum: 3600, default: 300 }),
  ANALYTICS_ROLLUP_BATCH: Type.Integer({ minimum: 10, maximum: 5000, default: 500 }),
  USAGE_CLOSE_INTERVAL_SECONDS: Type.Integer({ minimum: 60, maximum: 86400, default: 3600 }),
  USAGE_RENDITION_MIX: Type.String({ default: '{"360p":0.2,"480p":0.3,"720p":0.5}' }),
  // assignments (step 10): a file upload begun before the due date and handed in within this many minutes counts on time
  ASSIGNMENT_UPLOAD_GRACE_MINUTES: Type.Integer({ minimum: 0, maximum: 120, default: 10 }),
  // deadline fairness under load (core/deadline.ts): the arrival time of a request is believed for at most this long a wait; a
  // signed receipt (given with 503 busy) is honoured for the window. The key is >= 32 characters; absent it is derived (HKDF,
  // own label) from STORAGE_SIGNING_SECRET, so a deployment with the GCS driver must set it.
  ARRIVAL_QUEUE_WAIT_SECONDS: Type.Integer({ minimum: 1, maximum: 300, default: 30 }),
  DEADLINE_RECEIPT_WINDOW_SECONDS: Type.Integer({ minimum: 10, maximum: 3600, default: 600 }),
  DEADLINE_RECEIPT_SECRET: Type.Optional(Type.String({ minLength: 32 })),
  // Signing-key ring (step 14a, docs/key-rotation.md): `kid:secret,kid:secret`, the FIRST signs, all verify. Ids match
  // [A-Za-z0-9_-]{1,16}, secrets are 32+ characters; one HKDF label per purpose, so a key of one purpose never works for another.
  // Absent: the per-purpose keys above (one key, id k0). Tokens issued before key ids existed ("legacy") verify with those keys
  // while SIGNING_LEGACY_TOKENS=on; switch it off 90 days after the key-id format shipped.
  SIGNING_KEYS: Type.Optional(Type.String({ minLength: 34 })),
  SIGNING_LEGACY_TOKENS: Type.Union([Type.Literal('on'), Type.Literal('off')], { default: 'on' }),
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
  // hard deadline of one call to the video provider (createUpload, getStatus, deleteAsset): a deadline is a clean 503 (step 14a)
  VIDEO_PROVIDER_TIMEOUT_MS: Type.Integer({ minimum: 100, maximum: 600_000, default: 30_000 }),
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

/** Observability (step 14a, docs/slo.md): metrics, tracing and the worker's health port. */
const opsFields = {
  // bearer token of GET /metrics (API) and of the worker's metrics port; absent = the endpoints are disabled (404)
  METRICS_TOKEN: Type.Optional(Type.String({ minLength: 32 })),
  // OTLP/HTTP base URL of the collector (e.g. http://localhost:4318); absent = spans are recorded in process only if metrics are on
  OTEL_EXPORTER_OTLP_ENDPOINT: Type.Optional(Type.String({ pattern: '^https?://\\S+$' })),
  // fraction of root traces kept (children follow their parent)
  OTEL_TRACE_SAMPLE_RATIO: Type.Number({ minimum: 0, maximum: 1, default: 0.1 }),
};

export const apiEnvSchema = Type.Object({
  // shared rate limiting (step 14a, docs/adr/0022): `memory` = per instance (development, tests), `postgres` = counters shared by
  // every API instance (the production default). RATE_LIMIT_SYNC_MS: how often an instance folds its local hits into the shared store.
  RATE_LIMIT_STORE: Type.Optional(Type.Union([Type.Literal('memory'), Type.Literal('postgres')])),
  RATE_LIMIT_SYNC_MS: Type.Integer({ minimum: 100, maximum: 60_000, default: 1000 }),
  ...opsFields,
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
  // the worker's own HTTP port: /health/live, /health/ready (and /metrics with METRICS_TOKEN). 0 = no port.
  WORKER_HEALTH_PORT: Type.Integer({ minimum: 0, maximum: 65535, default: 3001 }),
  WORKER_HEALTH_HOST: Type.String({ default: '0.0.0.0' }),
  // /health/ready answers 503 when the worker has not polled the queue for this long
  WORKER_READY_MAX_POLL_AGE_SECONDS: Type.Integer({ minimum: 5, maximum: 3600, default: 60 }),
  ...opsFields,
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
  SEED_USER_PASSWORD: Type.Optional(Type.String({ minLength: 12, maxLength: 128 })),
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

/** The shared limiter's store: the environment's choice, else postgres in production and memory elsewhere. */
export function rateLimitStoreOf(env: {
  NODE_ENV: string;
  RATE_LIMIT_STORE?: 'memory' | 'postgres' | undefined;
}): 'memory' | 'postgres' {
  return env.RATE_LIMIT_STORE ?? (env.NODE_ENV === 'production' ? 'postgres' : 'memory');
}

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
  DEADLINE_RECEIPT_SECRET?: string | undefined;
  SIGNING_KEYS?: string | undefined;
}): void {
  const issues: string[] = [];
  try {
    parseSigningKeys(env.SIGNING_KEYS);
  } catch (err) {
    issues.push(err instanceof Error ? err.message : 'SIGNING_KEYS: invalid');
  }
  if (env.STORAGE_DRIVER === 'local') {
    if (env.NODE_ENV === 'production') {
      issues.push(
        'STORAGE_DRIVER: "local" is a development driver and is not allowed when NODE_ENV=production',
      );
    }
    if (!env.STORAGE_SIGNING_SECRET && !env.SIGNING_KEYS) {
      issues.push('STORAGE_SIGNING_SECRET: required (32+ characters) when STORAGE_DRIVER=local');
    }
  } else if (!env.STORAGE_GCS_BUCKET) {
    issues.push('STORAGE_GCS_BUCKET: required when STORAGE_DRIVER=gcs');
  }
  // the receipts of deadline fairness are signed with their own key, or one derived from the storage key (local driver)
  if (!env.DEADLINE_RECEIPT_SECRET && !env.STORAGE_SIGNING_SECRET && !env.SIGNING_KEYS) {
    issues.push(
      'DEADLINE_RECEIPT_SECRET: required (32+ characters) when there is no STORAGE_SIGNING_SECRET',
    );
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

/** The delivery the environment chose: EMAIL_PROVIDER, else the deprecated MAILER. */
export function emailProviderOf(env: {
  EMAIL_PROVIDER?: string | undefined;
  MAILER: string;
}): 'smtp' | 'sendgrid' | 'console' | 'file' | 'none' {
  return (env.EMAIL_PROVIDER ?? env.MAILER) as 'smtp' | 'sendgrid' | 'console' | 'file' | 'none';
}

/**
 * Production must configure the base domain explicitly and deliver mail for real: the console provider logs links, the file
 * provider writes them to disk, `none` drops every email. A real provider needs its settings, a From address and TLS.
 */
export function assertAuthPolicy(
  env: {
    NODE_ENV: string;
    MAILER: string;
    MAIL_FILE?: string | undefined;
    EMAIL_PROVIDER?: string | undefined;
    EMAIL_FROM_DEFAULT?: string | undefined;
    SMTP_HOST?: string | undefined;
    SMTP_TLS?: string | undefined;
    SENDGRID_API_KEY?: string | undefined;
    NOTIFY_SIGNING_SECRET?: string | undefined;
    STORAGE_SIGNING_SECRET?: string | undefined;
    SIGNING_KEYS?: string | undefined;
  },
  source: Record<string, string | undefined>,
): void {
  const provider = emailProviderOf(env);
  const issues: string[] = [];
  if (provider === 'file' && !env.MAIL_FILE)
    issues.push('MAIL_FILE: required when EMAIL_PROVIDER=file');
  if (provider === 'smtp' && !env.SMTP_HOST)
    issues.push('SMTP_HOST: required when EMAIL_PROVIDER=smtp');
  if (provider === 'sendgrid' && !env.SENDGRID_API_KEY) {
    issues.push('SENDGRID_API_KEY: required when EMAIL_PROVIDER=sendgrid');
  }
  if (!env.NOTIFY_SIGNING_SECRET && !env.STORAGE_SIGNING_SECRET && !env.SIGNING_KEYS) {
    issues.push(
      'NOTIFY_SIGNING_SECRET: required (32+ characters) when there is no STORAGE_SIGNING_SECRET',
    );
  }
  if (env.NODE_ENV === 'production') {
    if (!source.APP_BASE_DOMAIN) issues.push('APP_BASE_DOMAIN: required when NODE_ENV=production');
    if (provider === 'console') {
      issues.push(
        'EMAIL_PROVIDER: "console" is a dev provider (it logs links) and is not allowed in production',
      );
    }
    if (provider === 'file') {
      issues.push(
        'EMAIL_PROVIDER: "file" writes links to disk in clear text and is not allowed in production',
      );
    }
    if (provider === 'none') {
      issues.push('EMAIL_PROVIDER: "none" drops every email and is not allowed in production');
    }
    if (provider === 'smtp' && env.SMTP_TLS === 'off') {
      issues.push('SMTP_TLS: "off" sends mail without TLS and is not allowed in production');
    }
    if (!env.EMAIL_FROM_DEFAULT)
      issues.push('EMAIL_FROM_DEFAULT: required when NODE_ENV=production');
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
  // the worker SENDS the mail (step 13): the same delivery policy as the API
  assertAuthPolicy(env, source);
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

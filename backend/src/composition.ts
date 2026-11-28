import type { ApiEnv, WorkerEnv } from './config/env';
import { cookieSettings, emailProviderOf } from './config/env';
import { signingFromEnv } from './config/signing';
import type { AuthContext } from './core/auth-context';
import type { AuthRateLimitConfig } from './core/auth-rate-limit';
import { createBackgroundTasks } from './core/background';
import { createGcsLedger, createLocalLedger } from './core/erasure-ledger';
import type { HandlerMap } from './core/handlers';
import { createAddressHasher, parseHashKeys } from './core/keyed-hash';
import { createKeyRing, type SigningKeyEntry } from './core/keyring';
import {
  type BounceWebhookAdapter,
  createCapturingProvider,
  createConsoleProvider,
  createFileProvider,
  createNullProvider,
  createSendgridProvider,
  createSendgridWebhookAdapter,
  createSmtpProvider,
  createTokenBucket,
  createUnsubscribeTokens,
  type EmailProvider,
  guardEmailProvider,
  unsubscribeKey,
} from './core/mail';
import { createMfaCrypto, parseMfaKeys } from './core/mfa-crypto';
import { createPasswordHasher, type PasswordHasher } from './core/password';
import {
  createGcsStorage,
  createLocalStorage,
  guardStorage,
  type LocalStorage,
  type StorageProvider,
} from './core/storage';
import { traced } from './core/telemetry';
import {
  createBunnyVideoProvider,
  createGcpVideoProvider,
  createLocalVideoProvider,
  createPlaybackTokens,
  createTtlCache,
  guardVideoProvider,
  playbackKey,
  type TtlCache,
  tokenOfPlaybackUrl,
  type VideoProvider,
} from './core/video';
import type { Database } from './db/client';
import {
  createAcademicsController,
  createAcademicsHandlers,
  createAcademicsRepository,
  createAcademicsService,
} from './modules/academics';
import {
  createAnalyticsController,
  createAnalyticsHandlers,
  createAnalyticsRepository,
  createAnalyticsService,
} from './modules/analytics';
import {
  createAssessmentsController,
  createAssessmentsHandlers,
  createAssessmentsRepository,
  createAssessmentsService,
} from './modules/assessments';
import {
  createAssignmentsController,
  createAssignmentsRepository,
  createAssignmentsService,
} from './modules/assignments';
import {
  createAuditController,
  createAuditHandlers,
  createAuditRepository,
  createAuditService,
} from './modules/audit';
import {
  type AuthConfig,
  type AuthService,
  createAuthController,
  createAuthHandlers,
  createAuthRepository,
  createAuthService,
  createMfaRepository,
  createMfaResetRepository,
  createMfaResetService,
  createMfaService,
  DEFAULT_AUTH_CONFIG,
} from './modules/auth';
import {
  createContentController,
  createContentHandlers,
  createContentRepository,
  createContentService,
} from './modules/content';
import {
  createCourseParticipationResolver,
  createCoursesController,
  createCoursesHandlers,
  createCoursesRepository,
  createCoursesService,
} from './modules/courses';
import {
  createEmailController,
  createEmailHandlers,
  createEmailRepository,
  createEmailService,
} from './modules/email';
import {
  createFilesController,
  createFilesHandlers,
  createFilesRepository,
  createFilesService,
  createStorageController,
} from './modules/files';
import {
  createGradebookController,
  createGradebookHandlers,
  createGradebookRepository,
  createGradebookService,
} from './modules/gradebook';
import {
  createHealthController,
  createHealthHandlers,
  createHealthRepository,
  createHealthService,
} from './modules/health';
import {
  createImportsController,
  createImportsHandlers,
  createImportsRepository,
  createImportsService,
  type ImportsConfig,
} from './modules/imports';
import {
  createJobsHandlers,
  createJobsRepository,
  createJobsService,
  type JobsConfig,
} from './modules/jobs';
import {
  createMembershipsController,
  createMembershipsHandlers,
  createMembershipsRepository,
  createMembershipsService,
} from './modules/memberships';
import {
  createNotificationsController,
  createNotificationsHandlers,
  createNotificationsRepository,
  createNotificationsService,
} from './modules/notifications';
import { createOpsController, createOpsRepository, createOpsService } from './modules/ops';
import {
  createErasureController,
  createErasureRepository,
  createErasureService,
  createPrivacyController,
  createPrivacyHandlers,
  createPrivacyRepository,
  createPrivacyService,
} from './modules/privacy';
import {
  createProfilesController,
  createProfilesHandlers,
  createProfilesRepository,
  createProfilesService,
} from './modules/profiles';
import {
  createProgressController,
  createProgressHandlers,
  createProgressRepository,
  createProgressService,
} from './modules/progress';
import {
  createQuestionsController,
  createQuestionsHandlers,
  createQuestionsRepository,
  createQuestionsService,
} from './modules/questions';
import {
  createRateLimitHandlers,
  createRateLimitRepository,
  createRateLimitService,
} from './modules/ratelimit';
import {
  createRubricsController,
  createRubricsRepository,
  createRubricsService,
} from './modules/rubrics';
import {
  createSessionsController,
  createSessionsHandlers,
  createSessionsRepository,
  createSessionsService,
  type PurgeConfig,
  type SessionsConfig,
} from './modules/sessions';
import {
  createTenantsController,
  createTenantsHandlers,
  createTenantsPlatformRepository,
  createTenantsPlatformService,
  createTenantsRepository,
  createTenantsService,
  type TenantCacheOptions,
} from './modules/tenants';
import {
  createUsageController,
  createUsageHandlers,
  createUsageRepository,
  createUsageService,
  parseRenditionMix,
} from './modules/usage';
import {
  createUsersController,
  createUsersHandlers,
  createUsersRepository,
  createUsersService,
} from './modules/users';
import {
  createPlaybackController,
  createVideoController,
  createVideoHandlers,
  createVideoRepository,
  createVideoService,
  type VideoConfig,
} from './modules/video';

export interface ModulesConfig {
  /** bearer token of GET /metrics (absent: the endpoint is disabled) */
  metricsToken: string | undefined;
  /** deadlines of external calls and the email circuit breaker (step 14a, docs/adr/0024-resilience.md) */
  resilience: {
    emailTimeoutMs: number;
    emailBreakerFailures: number;
    emailBreakerCooldownMs: number;
    storageTimeoutMs: number;
    videoTimeoutMs: number;
  };
  /** the signing-key ring (docs/key-rotation.md): entries from SIGNING_KEYS (empty = the per-purpose keys) */
  signing: { entries: readonly SigningKeyEntry[]; legacyEnabled: boolean };
  readyTimeoutMs: number;
  sessions: SessionsConfig;
  auth: Partial<AuthConfig>;
  /** two-factor sign-in (step 14c): forced enrolment, and the keys of the secrets at rest (empty in the worker) */
  mfa: { enforced: boolean; keys: SigningKeyEntry[] };
  /** the clock of the second factor's time decisions (tests pass explicit instants) */
  now?: () => Date;
  /** tests: a password hasher whose argon2 calls can be held open */
  passwordHasher?: PasswordHasher;
  authRateLimits: AuthRateLimitConfig;
  privacy: {
    exportRatePerHour: number;
    /** keys of the keyed hash of a suppressed address (the first hashes, all are tried) */
    hashKeys: SigningKeyEntry[];
    ledgerDir: string;
    scanEveryMs: number;
  };
  tenantCache: TenantCacheOptions;
  passwordHashConcurrency: number;
  baseDomain: string;
  cookie: { name: string; secure: boolean };
  purge: PurgeConfig;
  jobs: JobsConfig;
  imports: ImportsConfig;
  storage: StorageConfig;
  assessments: AssessmentsModuleConfig;
  assignments: AssignmentsModuleConfig;
  analytics: AnalyticsModuleConfig;
  video: VideoModuleConfig;
  /** port of the web app for links in queued emails (development only) */
  publicPort: number | undefined;
  email: EmailModuleConfig;
  onBackgroundError: (err: unknown) => void;
}

/** Email delivery and notifications (step 13). */
export interface EmailModuleConfig {
  provider: EmailProvider;
  webhooks: readonly BounceWebhookAdapter[];
  ratePerSecond: number;
  fromDefault: string;
  fromName: string;
  /** HMAC key of the unsubscribe tokens */
  unsubscribeSecret: string;
  unsubscribeTtlSeconds: number;
  outboxRetentionDays: number;
  readRetentionDays: number;
  scanEveryMs: number;
}

export interface StorageConfig {
  driver: 'local' | 'gcs';
  localDir: string;
  signingSecret: string | undefined;
  gcsBucket: string | undefined;
  maxBytes: number;
  urlTtlSeconds: number;
  purgeGraceHours: number;
  purgeEveryMs: number;
}

export interface AnalyticsModuleConfig {
  rollupEveryMs: number;
  rollupBatch: number;
  usageCloseEveryMs: number;
  /** assumed share of viewing per rendition, e.g. {"360p":0.2,...} */
  renditionMix: Record<string, number>;
}

export interface AssignmentsModuleConfig {
  graceSeconds: number;
}

export interface AssessmentsModuleConfig {
  graceSeconds: number;
  sweepEveryMs: number;
  sweepBatch: number;
}

export interface VideoModuleConfig extends VideoConfig {
  provider: 'local' | 'gcp' | 'bunny';
  /** HMAC key of the playback tokens; absent: derived from the storage signing secret */
  signingSecret: string | undefined;
  /** segment requests re-use a validated session for this long (0 = never) */
  sessionCacheTtlSeconds: number;
  sessionCacheMax: number;
}

type Logging = {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

/** "imports:1,invites:4,default:2" -> { imports: 1, invites: 4, default: 2 } (already shape-checked by the env schema). */
export function parseConcurrency(value: string): Record<string, number> {
  // the transcoder uses every core it is given: one video at a time unless the env says otherwise
  const out: Record<string, number> = { default: 2, video: 1 };
  for (const part of value.split(',')) {
    const [name, n] = part.split(':');
    if (name && n) out[name] = Number(n);
  }
  return out;
}

/**
 * Two-factor sign-in is configured on the API only (the worker's environment has neither variable and gets no key). Outside
 * production a key derived from the storage secret stands in; in production assertMfaPolicy refuses an API without one.
 */
function mfaConfig(env: {
  NODE_ENV: string;
  STORAGE_SIGNING_SECRET?: string | undefined;
  MFA_ENCRYPTION_KEYS?: string | undefined;
  MFA_ENFORCEMENT?: 'off' | 'required' | undefined;
}) {
  const fallback =
    env.NODE_ENV !== 'production' && env.STORAGE_SIGNING_SECRET
      ? [{ kid: 'dev0', secret: env.STORAGE_SIGNING_SECRET }]
      : [];
  return {
    enforced: env.MFA_ENFORCEMENT === 'required',
    keys: env.MFA_ENCRYPTION_KEYS ? parseMfaKeys(env.MFA_ENCRYPTION_KEYS) : fallback,
  };
}

/** Translates validated env into the module settings (used by the API and the worker). */
export function modulesConfigFromEnv(
  env: Pick<
    ApiEnv & WorkerEnv,
    | 'NODE_ENV'
    | 'APP_BASE_DOMAIN'
    | 'COOKIE_SECURE'
    | 'SESSION_IDLE_DAYS'
    | 'SESSION_ABSOLUTE_DAYS'
    | 'LOGIN_MAX_ATTEMPTS'
    | 'LOCKOUT_BASE_SECONDS'
    | 'LOCKOUT_MAX_SECONDS'
    | 'RATE_LIMIT_LOGIN_PER_IP'
    | 'RATE_LIMIT_LOGIN_FAILURES_PER_IP'
    | 'RATE_LIMIT_AUTH_PER_IP'
    | 'RATE_LIMIT_LOGIN_PER_EMAIL'
    | 'RATE_LIMIT_AUTH_WINDOW_MS'
    | 'DATA_EXPORT_RATE_PER_HOUR'
    | 'SUPPRESSION_HASH_KEYS'
    | 'ERASURE_LEDGER_DIR'
    | 'PRIVACY_ERASURE_SCAN_SECONDS'
    | 'PASSWORD_HASH_CONCURRENCY'
    | 'TENANT_CACHE_TTL_MS'
    | 'TENANT_CACHE_MAX'
    | 'MAILER'
    | 'MAIL_FILE'
    | 'EMAIL_PROVIDER'
    | 'EMAIL_FROM_DEFAULT'
    | 'EMAIL_FROM_NAME'
    | 'EMAIL_RATE_PER_SECOND'
    | 'EMAIL_OUTBOX_RETENTION_DAYS'
    | 'EMAIL_SEND_TIMEOUT_MS'
    | 'EMAIL_BREAKER_FAILURES'
    | 'EMAIL_BREAKER_COOLDOWN_SECONDS'
    | 'STORAGE_OPERATION_TIMEOUT_MS'
    | 'VIDEO_PROVIDER_TIMEOUT_MS'
    | 'SMTP_HOST'
    | 'SMTP_PORT'
    | 'SMTP_TLS'
    | 'SMTP_USER'
    | 'SMTP_PASSWORD'
    | 'SMTP_MAX_CONNECTIONS'
    | 'SENDGRID_API_KEY'
    | 'SENDGRID_API_URL'
    | 'SENDGRID_WEBHOOK_PUBLIC_KEY'
    | 'EMAIL_WEBHOOK_TOLERANCE_SECONDS'
    | 'NOTIFY_SIGNING_SECRET'
    | 'SIGNING_KEYS'
    | 'METRICS_TOKEN'
    | 'SIGNING_LEGACY_TOKENS'
    | 'UNSUBSCRIBE_TOKEN_DAYS'
    | 'NOTIFY_SCAN_SECONDS'
    | 'NOTIFICATIONS_READ_RETENTION_DAYS'
    | 'PURGE_RETENTION_DAYS'
    | 'PURGE_INTERVAL_SECONDS'
    | 'PURGE_BATCH_SIZE'
    | 'JOB_POLL_INTERVAL_MS'
    | 'JOB_POLL_MAX_INTERVAL_MS'
    | 'JOB_LEASE_SECONDS'
    | 'JOB_MAX_ATTEMPTS'
    | 'JOB_BACKOFF_BASE_SECONDS'
    | 'JOB_BACKOFF_MAX_SECONDS'
    | 'JOB_SHUTDOWN_GRACE_SECONDS'
    | 'JOB_CONCURRENCY'
    | 'JOBS_COMPLETED_RETENTION_DAYS'
    | 'JOBS_DEAD_RETENTION_DAYS'
    | 'IMPORT_MAX_BYTES'
    | 'IMPORT_MAX_ROWS'
    | 'IMPORT_BATCH_SIZE'
    | 'IMPORT_RETENTION_DAYS'
    | 'INVITE_RATE_PER_SECOND'
    | 'APP_PUBLIC_PORT'
    | 'STORAGE_DRIVER'
    | 'STORAGE_LOCAL_DIR'
    | 'STORAGE_SIGNING_SECRET'
    | 'STORAGE_MAX_FILE_BYTES'
    | 'STORAGE_URL_TTL_SECONDS'
    | 'STORAGE_GCS_BUCKET'
    | 'FILE_PURGE_GRACE_HOURS'
    | 'FILE_PURGE_INTERVAL_SECONDS'
    | 'ASSESSMENT_SAVE_GRACE_SECONDS'
    | 'ASSESSMENT_SWEEP_SECONDS'
    | 'ASSESSMENT_SWEEP_BATCH'
    | 'ANALYTICS_ROLLUP_SECONDS'
    | 'ANALYTICS_ROLLUP_BATCH'
    | 'USAGE_CLOSE_INTERVAL_SECONDS'
    | 'USAGE_RENDITION_MIX'
    | 'ASSIGNMENT_UPLOAD_GRACE_MINUTES'
    | 'VIDEO_PROVIDER'
    | 'VIDEO_SIGNING_SECRET'
    | 'VIDEO_MAX_BYTES'
    | 'VIDEO_MAX_DURATION_SECONDS'
    | 'VIDEO_UPLOAD_CHUNK_BYTES'
    | 'VIDEO_PLAYBACK_TTL_SECONDS'
    | 'VIDEO_SESSION_CACHE_TTL_SECONDS'
    | 'VIDEO_SESSION_CACHE_MAX'
    | 'VIDEO_SOURCE_RETENTION_DAYS'
    | 'VIDEO_UPLOAD_GRACE_HOURS'
    | 'VIDEO_PURGE_INTERVAL_SECONDS'
    | 'VIDEO_WORK_DIR'
    | 'FFMPEG_PATH'
    | 'FFPROBE_PATH'
    | 'VIDEO_TRANSCODE_TIMEOUT_FACTOR'
    | 'VIDEO_FFMPEG_THREADS'
  > & { READY_TIMEOUT_MS?: number },
  logger: Logging,
  emailProvider?: EmailProvider,
): ModulesConfig {
  return {
    signing: signingFromEnv(env),
    metricsToken: env.METRICS_TOKEN,
    resilience: {
      // the providers' own timeouts (EMAIL_SEND_TIMEOUT_MS) come first; this is the backstop a little later
      emailTimeoutMs: env.EMAIL_SEND_TIMEOUT_MS + 5000,
      emailBreakerFailures: env.EMAIL_BREAKER_FAILURES,
      emailBreakerCooldownMs: env.EMAIL_BREAKER_COOLDOWN_SECONDS * 1000,
      storageTimeoutMs: env.STORAGE_OPERATION_TIMEOUT_MS,
      videoTimeoutMs: env.VIDEO_PROVIDER_TIMEOUT_MS,
    },
    readyTimeoutMs: env.READY_TIMEOUT_MS ?? 2000,
    sessions: {
      idleSeconds: Math.round(env.SESSION_IDLE_DAYS * 86_400),
      absoluteSeconds: Math.round(env.SESSION_ABSOLUTE_DAYS * 86_400),
      touchSeconds: 300,
    },
    auth: {
      maxAttempts: env.LOGIN_MAX_ATTEMPTS,
      lockBaseSeconds: env.LOCKOUT_BASE_SECONDS,
      lockMaxSeconds: env.LOCKOUT_MAX_SECONDS,
    },
    authRateLimits: {
      perIp: env.RATE_LIMIT_AUTH_PER_IP,
      signInPerIp: env.RATE_LIMIT_LOGIN_PER_IP,
      signInFailuresPerIp: env.RATE_LIMIT_LOGIN_FAILURES_PER_IP,
      perEmail: env.RATE_LIMIT_LOGIN_PER_EMAIL,
      windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS,
    },
    mfa: mfaConfig(env),
    privacy: {
      exportRatePerHour: env.DATA_EXPORT_RATE_PER_HOUR,
      // outside production a key derived from the storage secret is used (assertPrivacyPolicy refuses a missing key in production)
      hashKeys: env.SUPPRESSION_HASH_KEYS
        ? parseHashKeys(env.SUPPRESSION_HASH_KEYS)
        : [{ kid: 'dev0', secret: (env.STORAGE_SIGNING_SECRET ?? '').padEnd(32, '-') }],
      ledgerDir: env.ERASURE_LEDGER_DIR,
      scanEveryMs: env.PRIVACY_ERASURE_SCAN_SECONDS * 1000,
    },
    tenantCache: { ttlMs: env.TENANT_CACHE_TTL_MS, maxEntries: env.TENANT_CACHE_MAX },
    passwordHashConcurrency: env.PASSWORD_HASH_CONCURRENCY,
    purge: {
      retentionDays: env.PURGE_RETENTION_DAYS,
      batchSize: env.PURGE_BATCH_SIZE,
      everyMs: env.PURGE_INTERVAL_SECONDS * 1000,
    },
    jobs: {
      pollIntervalMs: env.JOB_POLL_INTERVAL_MS,
      pollMaxIntervalMs: env.JOB_POLL_MAX_INTERVAL_MS,
      leaseSeconds: env.JOB_LEASE_SECONDS,
      maxAttempts: env.JOB_MAX_ATTEMPTS,
      backoffBaseSeconds: env.JOB_BACKOFF_BASE_SECONDS,
      backoffMaxSeconds: env.JOB_BACKOFF_MAX_SECONDS,
      shutdownGraceSeconds: env.JOB_SHUTDOWN_GRACE_SECONDS,
      concurrency: parseConcurrency(env.JOB_CONCURRENCY),
      completedRetentionDays: env.JOBS_COMPLETED_RETENTION_DAYS,
      deadRetentionDays: env.JOBS_DEAD_RETENTION_DAYS,
      purgeBatchSize: env.PURGE_BATCH_SIZE,
    },
    imports: {
      maxBytes: env.IMPORT_MAX_BYTES,
      maxRows: env.IMPORT_MAX_ROWS,
      batchSize: env.IMPORT_BATCH_SIZE,
      retentionDays: env.IMPORT_RETENTION_DAYS,
      inviteRatePerSecond: env.INVITE_RATE_PER_SECOND,
      purgeBatchSize: env.PURGE_BATCH_SIZE,
    },
    storage: {
      driver: env.STORAGE_DRIVER,
      localDir: env.STORAGE_LOCAL_DIR,
      signingSecret: env.STORAGE_SIGNING_SECRET,
      gcsBucket: env.STORAGE_GCS_BUCKET,
      maxBytes: env.STORAGE_MAX_FILE_BYTES,
      urlTtlSeconds: env.STORAGE_URL_TTL_SECONDS,
      purgeGraceHours: env.FILE_PURGE_GRACE_HOURS,
      purgeEveryMs: env.FILE_PURGE_INTERVAL_SECONDS * 1000,
    },
    assessments: {
      graceSeconds: env.ASSESSMENT_SAVE_GRACE_SECONDS,
      sweepEveryMs: env.ASSESSMENT_SWEEP_SECONDS * 1000,
      sweepBatch: env.ASSESSMENT_SWEEP_BATCH,
    },
    assignments: { graceSeconds: env.ASSIGNMENT_UPLOAD_GRACE_MINUTES * 60 },
    analytics: {
      rollupEveryMs: env.ANALYTICS_ROLLUP_SECONDS * 1000,
      rollupBatch: env.ANALYTICS_ROLLUP_BATCH,
      usageCloseEveryMs: env.USAGE_CLOSE_INTERVAL_SECONDS * 1000,
      renditionMix: parseRenditionMix(env.USAGE_RENDITION_MIX),
    },
    video: {
      provider: env.VIDEO_PROVIDER,
      signingSecret: env.VIDEO_SIGNING_SECRET,
      sessionCacheTtlSeconds: env.VIDEO_SESSION_CACHE_TTL_SECONDS,
      sessionCacheMax: env.VIDEO_SESSION_CACHE_MAX,
      maxBytes: env.VIDEO_MAX_BYTES,
      maxDurationSeconds: env.VIDEO_MAX_DURATION_SECONDS,
      chunkBytes: env.VIDEO_UPLOAD_CHUNK_BYTES,
      playbackTtlSeconds: env.VIDEO_PLAYBACK_TTL_SECONDS,
      sourceRetentionDays: env.VIDEO_SOURCE_RETENTION_DAYS,
      graceHours: env.VIDEO_UPLOAD_GRACE_HOURS,
      workDir: env.VIDEO_WORK_DIR,
      ffmpegPath: env.FFMPEG_PATH,
      ffprobePath: env.FFPROBE_PATH,
      timeoutFactor: env.VIDEO_TRANSCODE_TIMEOUT_FACTOR,
      threads: env.VIDEO_FFMPEG_THREADS,
      purgeEveryMs: env.VIDEO_PURGE_INTERVAL_SECONDS * 1000,
    },
    publicPort: env.APP_PUBLIC_PORT,
    baseDomain: env.APP_BASE_DOMAIN,
    cookie: cookieSettings(env),
    email: {
      provider: emailProvider ?? emailProviderFromEnv(env, logger),
      webhooks: [
        createSendgridWebhookAdapter({
          publicKey: env.SENDGRID_WEBHOOK_PUBLIC_KEY,
          toleranceSeconds: env.EMAIL_WEBHOOK_TOLERANCE_SECONDS,
        }),
      ],
      ratePerSecond: env.EMAIL_RATE_PER_SECOND,
      fromDefault: env.EMAIL_FROM_DEFAULT ?? `no-reply@${env.APP_BASE_DOMAIN}`,
      fromName: env.EMAIL_FROM_NAME,
      // '' = no key material at all (the ring then has only the SIGNING_KEYS entries, or nothing: signing fails loudly)
      unsubscribeSecret:
        env.NOTIFY_SIGNING_SECRET || env.STORAGE_SIGNING_SECRET
          ? unsubscribeKey({
              notifySecret: env.NOTIFY_SIGNING_SECRET,
              storageSecret: env.STORAGE_SIGNING_SECRET,
            })
          : '',
      unsubscribeTtlSeconds: env.UNSUBSCRIBE_TOKEN_DAYS * 86_400,
      outboxRetentionDays: env.EMAIL_OUTBOX_RETENTION_DAYS,
      readRetentionDays: env.NOTIFICATIONS_READ_RETENTION_DAYS,
      scanEveryMs: env.NOTIFY_SCAN_SECONDS * 1000,
    },
    onBackgroundError: (err) => logger.error({ err }, 'background task failed'),
  };
}

/** The delivery chosen by EMAIL_PROVIDER (the env policy already refused dev providers in production). */
function emailProviderFromEnv(
  env: Pick<
    ApiEnv & WorkerEnv,
    | 'MAILER'
    | 'MAIL_FILE'
    | 'EMAIL_PROVIDER'
    | 'EMAIL_SEND_TIMEOUT_MS'
    | 'SMTP_HOST'
    | 'SMTP_PORT'
    | 'SMTP_TLS'
    | 'SMTP_USER'
    | 'SMTP_PASSWORD'
    | 'SMTP_MAX_CONNECTIONS'
    | 'SENDGRID_API_KEY'
    | 'SENDGRID_API_URL'
  >,
  logger: Logging,
): EmailProvider {
  switch (emailProviderOf(env)) {
    case 'smtp':
      return createSmtpProvider({
        host: env.SMTP_HOST ?? '',
        port: env.SMTP_PORT,
        tls: env.SMTP_TLS,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        maxConnections: env.SMTP_MAX_CONNECTIONS,
        timeoutMs: env.EMAIL_SEND_TIMEOUT_MS,
      });
    case 'sendgrid':
      return createSendgridProvider({
        apiKey: env.SENDGRID_API_KEY ?? '',
        apiUrl: env.SENDGRID_API_URL,
        timeoutMs: env.EMAIL_SEND_TIMEOUT_MS,
      });
    case 'console':
      return createConsoleProvider((obj, msg) => logger.info(obj, msg));
    case 'file':
      return env.MAIL_FILE ? createFileProvider(env.MAIL_FILE) : createCapturingProvider();
    default:
      return createNullProvider();
  }
}

/**
 * Composition root shared by the API (app.ts) and the worker (worker.ts): plain factory
 * functions with explicit dependencies, wired in one place. No DI framework, no decorators.
 * A module that needs another module's service receives it here, e.g.
 * `createMembershipsService({ db, membershipsRepo, sessionsService })`.
 */
export function createModules(db: Database, config: ModulesConfig) {
  const background = createBackgroundTasks(config.onBackgroundError);
  const hasher =
    config.passwordHasher ?? createPasswordHasher({ concurrency: config.passwordHashConcurrency });

  const healthService = traced(
    'health',
    createHealthService({
      healthRepo: createHealthRepository({ db }),
      readyTimeoutMs: config.readyTimeoutMs,
    }),
  );
  const tenantsService = traced(
    'tenants',
    createTenantsService({
      db,
      tenantsRepo: createTenantsRepository(),
      cache: config.tenantCache,
    }),
  );
  const jobsService = traced(
    'jobs',
    createJobsService({
      db,
      jobsRepo: createJobsRepository(),
      config: config.jobs,
    }),
  );
  const academicsService = traced(
    'academics',
    createAcademicsService({
      db,
      academicsRepo: createAcademicsRepository(),
    }),
  );
  const profilesService = traced(
    'profiles',
    createProfilesService({
      db,
      profilesRepo: createProfilesRepository(),
    }),
  );
  const usersService = traced(
    'users',
    createUsersService({ db, usersRepo: createUsersRepository() }),
  );
  const sessionsService = traced(
    'sessions',
    createSessionsService({
      db,
      sessionsRepo: createSessionsRepository(),
      config: { ...config.sessions, requireMfa: config.mfa.enforced },
    }),
  );
  const membershipsService = traced(
    'memberships',
    createMembershipsService({
      db,
      membershipsRepo: createMembershipsRepository(),
    }),
  );
  const auditService = traced(
    'audit',
    createAuditService({ db, auditRepo: createAuditRepository() }),
  );
  const tenantsPlatformService = traced(
    'tenantsPlatform',
    createTenantsPlatformService({
      db,
      platformRepo: createTenantsPlatformRepository(),
      auditService,
      membershipsService,
      config: {
        baseDomain: config.baseDomain,
        secure: config.cookie.secure,
        inviteTtlSeconds: config.auth.inviteTtlSeconds ?? DEFAULT_AUTH_CONFIG.inviteTtlSeconds,
      },
      clearSlugCache: () => tenantsService.clearCache(),
    }),
  );
  // ---- email (step 13): the outbox worker mints the tokens of security mail through the auth service, and the auth
  // service queues security mail through the email service: bound late, both stay plain factories.
  const ring = (purpose: string, legacyKey: string | null | undefined) =>
    createKeyRing({
      purpose,
      entries: config.signing.entries,
      legacyKey: legacyKey || null,
      legacyEnabled: config.signing.legacyEnabled,
    });
  const unsubscribeTokens = createUnsubscribeTokens(
    ring('unsubscribe', config.email.unsubscribeSecret),
    { ttlSeconds: config.email.unsubscribeTtlSeconds },
  );
  let authRef: Pick<
    AuthService,
    'mintInviteToken' | 'mintResetToken' | 'mintMfaEnrolToken'
  > | null = null;
  const minter = () => {
    if (!authRef) throw new Error('auth service not wired');
    return authRef;
  };
  // the provider behind a deadline and a circuit breaker (an outage defers the jobs instead of dead-lettering the mail)
  const emailProvider = guardEmailProvider(config.email.provider, {
    timeoutMs: config.resilience.emailTimeoutMs,
    failureThreshold: config.resilience.emailBreakerFailures,
    cooldownMs: config.resilience.emailBreakerCooldownMs,
  });
  const emailService = traced(
    'email',
    createEmailService({
      db,
      emailRepo: createEmailRepository(),
      provider: emailProvider,
      rate: createTokenBucket(config.email.ratePerSecond),
      unsubscribe: unsubscribeTokens,
      webhooks: config.email.webhooks,
      tokens: {
        invite: (tenantId, membershipId) => minter().mintInviteToken(tenantId, membershipId),
        reset: (userId) => minter().mintResetToken(userId),
        mfaEnrol: (userId, tenantId) => minter().mintMfaEnrolToken(userId, tenantId),
      },
      config: {
        baseDomain: config.baseDomain,
        secure: config.cookie.secure,
        publicPort: config.publicPort,
        fromDefault: config.email.fromDefault,
        fromName: config.email.fromName,
        unsubscribeTtlSeconds: config.email.unsubscribeTtlSeconds,
        outboxRetentionDays: config.email.outboxRetentionDays,
        purgeBatchSize: config.purge.batchSize,
      },
    }),
  );
  const notificationsService = traced(
    'notifications',
    createNotificationsService({
      db,
      notificationsRepo: createNotificationsRepository(),
      unsubscribe: unsubscribeTokens,
      config: {
        readRetentionDays: config.email.readRetentionDays,
        purgeBatchSize: config.purge.batchSize,
      },
    }),
  );
  const mfaService = traced(
    'mfa',
    createMfaService({
      db,
      mfaRepo: createMfaRepository(),
      authRepo: createAuthRepository(),
      hasher,
      crypto: config.mfa.keys.length > 0 ? createMfaCrypto(config.mfa.keys) : null,
      config: {
        enforced: config.mfa.enforced,
        sessionIdleSeconds: config.sessions.idleSeconds,
        sessionAbsoluteSeconds: config.sessions.absoluteSeconds,
        maxAttempts: config.auth.maxAttempts ?? DEFAULT_AUTH_CONFIG.maxAttempts,
        lockBaseSeconds: config.auth.lockBaseSeconds ?? DEFAULT_AUTH_CONFIG.lockBaseSeconds,
        lockMaxSeconds: config.auth.lockMaxSeconds ?? DEFAULT_AUTH_CONFIG.lockMaxSeconds,
      },
      ...(config.now ? { now: config.now } : {}),
    }),
  );
  const mfaResetService = traced(
    'mfaReset',
    createMfaResetService({
      db,
      resetRepo: createMfaResetRepository(),
      ...(config.now ? { now: config.now } : {}),
    }),
  );
  const authService = traced(
    'auth',
    createAuthService({
      secondFactor: mfaService,
      db,
      authRepo: createAuthRepository(),
      hasher,
      securityMail: { enqueue: (o) => emailService.enqueueSecurity(o) },
      background,
      sessionsService,
      usersService,
      membershipsService,
      auditService,
      config: config.auth,
    }),
  );
  authRef = authService;
  const importsService = traced(
    'imports',
    createImportsService({
      db,
      importsRepo: createImportsRepository(),
      jobsService,
      config: config.imports,
    }),
  );

  // every storage call has a deadline, and an I/O failure becomes a clean 503 (step 14a)
  const storage: StorageProvider = guardStorage(
    config.storage.driver === 'local'
      ? createLocalStorage({
          dir: config.storage.localDir,
          secret: ring('storage', config.storage.signingSecret),
          ttlSeconds: config.storage.urlTtlSeconds,
        })
      : createGcsStorage({ bucket: config.storage.gcsBucket ?? '' }),
    { timeoutMs: config.resilience.storageTimeoutMs },
  );
  const filesService = traced(
    'files',
    createFilesService({
      db,
      filesRepo: createFilesRepository(),
      storage,
      config: {
        maxBytes: config.storage.maxBytes,
        purgeGraceHours: config.storage.purgeGraceHours,
      },
    }),
  );
  // ---- data protection (step 14b): "download my data"; the password is asked again through the auth module
  const privacyService = traced(
    'privacy',
    createPrivacyService({
      db,
      privacyRepo: createPrivacyRepository(),
      passwords: { confirm: (ctx, password) => authService.confirmPassword(ctx, password) },
      storage,
      jobsService,
    }),
  );
  // ---- erasure inside a college (14b-1 part 3): the keyed hash of an address, the ledger OUTSIDE the database, the request workflow
  const erasureService = traced(
    'privacy.erasure',
    createErasureService({
      db,
      erasureRepo: createErasureRepository(),
      passwords: { confirm: (ctx, password) => authService.confirmPassword(ctx, password) },
      hasher: createAddressHasher(config.privacy.hashKeys),
      ledger:
        config.storage.driver === 'local'
          ? createLocalLedger({ dir: config.privacy.ledgerDir })
          : createGcsLedger(),
    }),
  );
  // ---- video (step 7). `local` = ffmpeg in the worker + HLS served by this API: development and CI only.
  const video = config.video;
  const localStorage = config.storage.driver === 'local' ? (storage as LocalStorage) : null;
  const playbackTokens =
    video.provider === 'local'
      ? createPlaybackTokens(
          ring(
            'playback',
            video.signingSecret || config.storage.signingSecret
              ? playbackKey({
                  videoSecret: video.signingSecret,
                  storageSecret: config.storage.signingSecret,
                })
              : null,
          ),
        )
      : null;
  const videoProvider: VideoProvider = guardVideoProvider(
    video.provider === 'local' && localStorage && playbackTokens
      ? createLocalVideoProvider({
          storage: localStorage,
          tokens: playbackTokens,
          chunkBytes: video.chunkBytes,
        })
      : video.provider === 'gcp'
        ? createGcpVideoProvider()
        : createBunnyVideoProvider(),
    { timeoutMs: config.resilience.videoTimeoutMs },
  );
  const videoService = traced(
    'video',
    createVideoService({
      db,
      videoRepo: createVideoRepository(),
      provider: videoProvider,
      local:
        localStorage && playbackTokens
          ? { storage: localStorage, tokens: playbackTokens }
          : undefined,
      jobs: jobsService,
      config: video,
    }),
  );
  /** validated sessions of playback requests (see registerAuthContext) */
  const playbackSessions: TtlCache<AuthContext> | null =
    video.provider === 'local'
      ? createTtlCache<AuthContext>({
          ttlMs: video.sessionCacheTtlSeconds * 1000,
          max: video.sessionCacheMax,
        })
      : null;

  const contentService = traced(
    'content',
    createContentService({
      db,
      contentRepo: createContentRepository(),
      filesService,
      videoService,
    }),
  );
  const coursesService = traced(
    'courses',
    createCoursesService({ db, coursesRepo: createCoursesRepository() }),
  );
  const progressService = traced(
    'progress',
    createProgressService({ db, progressRepo: createProgressRepository() }),
  );
  const analyticsService = traced(
    'analytics',
    createAnalyticsService({
      db,
      analyticsRepo: createAnalyticsRepository(),
      background,
      config: { csvPage: 100, activityCacheMax: 50_000, rollupBatch: config.analytics.rollupBatch },
    }),
  );
  const usageService = traced(
    'usage',
    createUsageService({
      db,
      usageRepo: createUsageRepository(),
      config: { renditionMix: config.analytics.renditionMix },
    }),
  );
  const assessmentsService = traced(
    'assessments',
    createAssessmentsService({
      db,
      assessmentsRepo: createAssessmentsRepository(),
      filesService,
      config: {
        graceSeconds: config.assessments.graceSeconds,
        sweepBatch: config.assessments.sweepBatch,
      },
    }),
  );
  const questionsService = traced(
    'questions',
    createQuestionsService({
      db,
      questionsRepo: createQuestionsRepository(),
    }),
  );

  const assignmentsService = traced(
    'assignments',
    createAssignmentsService({
      db,
      assignmentsRepo: createAssignmentsRepository(),
      filesService,
      storage,
      config: {
        graceSeconds: config.assignments.graceSeconds,
        maxFileBytes: config.storage.maxBytes,
      },
    }),
  );
  const rubricsService = traced(
    'rubrics',
    createRubricsService({ db, rubricsRepo: createRubricsRepository() }),
  );
  const gradebookService = traced(
    'gradebook',
    createGradebookService({
      db,
      gradebookRepo: createGradebookRepository(),
    }),
  );

  // ---- shared rate limiting and operations metrics (step 14a)
  const rateLimitService = traced(
    'rateLimit',
    createRateLimitService({ db, rateLimitRepo: createRateLimitRepository() }),
  );
  const opsService = traced('ops', createOpsService({ db, opsRepo: createOpsRepository() }));

  const handlers: HandlerMap = {
    ...createHealthHandlers({ healthService }),
    ...createTenantsHandlers({ tenantsService }),
    ...createUsersHandlers({ usersService }),
    ...createMembershipsHandlers({ membershipsService }),
    ...createAuditHandlers({ auditService }),
    ...createSessionsHandlers({ sessionsService, purge: config.purge }),
    ...createAuthHandlers({ authService, mfaService, mfaResetService, purge: config.purge }),
    ...createJobsHandlers({ jobsService, purge: config.purge }),
    ...createRateLimitHandlers({ rateLimitService, everyMs: 60_000 }),
    ...createEmailHandlers({ emailService, purge: { everyMs: config.purge.everyMs } }),
    ...createNotificationsHandlers({
      notificationsService,
      scan: { everyMs: config.email.scanEveryMs },
      purge: { everyMs: config.purge.everyMs },
    }),
    ...createAcademicsHandlers({ academicsService }),
    ...createProfilesHandlers({ profilesService }),
    ...createImportsHandlers({ importsService, purge: config.purge }),
    ...createPrivacyHandlers({
      privacyService,
      erasureService,
      purge: { everyMs: config.purge.everyMs },
      erasure: { everyMs: config.privacy.scanEveryMs },
    }),
    ...createContentHandlers({ contentService }),
    ...createProgressHandlers(),
    ...createAnalyticsHandlers({
      analyticsService,
      refresh: { everyMs: config.analytics.rollupEveryMs },
    }),
    ...createUsageHandlers({
      usageService,
      close: { everyMs: config.analytics.usageCloseEveryMs },
    }),
    ...createQuestionsHandlers({
      questionsService,
      purge: { everyMs: config.storage.purgeEveryMs },
    }),
    ...createAssessmentsHandlers({
      assessmentsService,
      sweep: { everyMs: config.assessments.sweepEveryMs },
    }),
    ...createVideoHandlers({ videoService, sweep: { everyMs: video.purgeEveryMs } }),
    ...createFilesHandlers({ filesService, purge: { everyMs: config.storage.purgeEveryMs } }),
    ...createGradebookHandlers({
      gradebookService,
      purge: { everyMs: config.storage.purgeEveryMs },
    }),
    ...createCoursesHandlers({
      coursesService,
      sync: { batchSize: 200, maxBatches: 500, concurrency: 1 },
    }),
  };

  return {
    handlers,
    background,
    config,
    jobs: { service: jobsService },
    rateLimit: { service: rateLimitService },
    ops: {
      service: opsService,
      controller: createOpsController({ metricsToken: config.metricsToken }),
    },
    email: {
      service: emailService,
      provider: emailProvider,
      controller: createEmailController({ emailService }),
    },
    notifications: {
      service: notificationsService,
      unsubscribe: unsubscribeTokens,
      controller: createNotificationsController({ notificationsService }),
    },
    privacy: {
      service: privacyService,
      controller: createPrivacyController({ privacyService }),
      erasureService,
      erasureController: createErasureController({ erasureService }),
    },
    imports: {
      service: importsService,
      controller: createImportsController({ importsService }),
    },
    content: {
      service: contentService,
      controller: createContentController({ contentService }),
    },
    files: {
      service: filesService,
      controller: createFilesController({ filesService, maxBytes: config.storage.maxBytes }),
      /** only the local driver serves its own signed URLs */
      storageController:
        storage.driver === 'local'
          ? createStorageController({ storage: storage as LocalStorage })
          : null,
    },
    assessments: {
      service: assessmentsService,
      controller: createAssessmentsController({ assessmentsService }),
    },
    assignments: {
      service: assignmentsService,
      controller: createAssignmentsController({ assignmentsService }),
    },
    gradebook: {
      service: gradebookService,
      controller: createGradebookController({ gradebookService }),
    },
    rubrics: {
      service: rubricsService,
      controller: createRubricsController({ rubricsService }),
    },
    questions: {
      service: questionsService,
      controller: createQuestionsController({ questionsService, filesService }),
    },
    analytics: {
      service: analyticsService,
      controller: createAnalyticsController({ analyticsService }),
    },
    usage: { service: usageService, controller: createUsageController({ usageService }) },
    progress: {
      service: progressService,
      controller: createProgressController({ progressService }),
    },
    video: {
      service: videoService,
      controller: createVideoController({ videoService, maxBytes: video.maxBytes }),
      /** only the local provider serves its own playback files */
      playbackController:
        video.provider === 'local' ? createPlaybackController({ videoService }) : null,
      sessionCache: playbackSessions
        ? { cache: playbackSessions, keyOf: tokenOfPlaybackUrl }
        : null,
    },
    courses: {
      service: coursesService,
      participation: createCourseParticipationResolver({ db }),
      controller: createCoursesController({ coursesService }),
    },
    profiles: {
      service: profilesService,
      controller: createProfilesController({ profilesService }),
    },
    academics: {
      service: academicsService,
      controller: createAcademicsController({ academicsService }),
    },
    health: { service: healthService, controller: createHealthController({ healthService }) },
    tenants: {
      service: tenantsService,
      platformService: tenantsPlatformService,
      controller: createTenantsController({
        tenantsService,
        platformService: tenantsPlatformService,
      }),
    },
    users: { service: usersService, controller: createUsersController({ usersService }) },
    memberships: {
      service: membershipsService,
      controller: createMembershipsController({ membershipsService }),
    },
    audit: { service: auditService, controller: createAuditController({ auditService }) },
    sessions: {
      service: sessionsService,
      controller: createSessionsController({ sessionsService }),
    },
    auth: {
      service: authService,
      hashingFull: () => hasher.full(),
      controller: createAuthController({
        authService,
        mfaService,
        mfaResetService,
        cookie: config.cookie,
        baseDomain: config.baseDomain,
      }),
    },
  };
}
export type Modules = ReturnType<typeof createModules>;

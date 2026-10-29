import type { ApiEnv, WorkerEnv } from './config/env';
import { cookieSettings } from './config/env';
import type { AuthRateLimitConfig } from './core/auth-rate-limit';
import type { HandlerMap } from './core/handlers';
import { buildOrigin } from './core/host';
import {
  createBackgroundTasks,
  createCapturingMailer,
  createConsoleMailer,
  createFileMailer,
  type Mailer,
} from './core/mailer';
import { createPasswordHasher } from './core/password';
import type { Database } from './db/client';
import {
  createAcademicsController,
  createAcademicsHandlers,
  createAcademicsRepository,
  createAcademicsService,
} from './modules/academics';
import {
  createAuditController,
  createAuditHandlers,
  createAuditRepository,
  createAuditService,
} from './modules/audit';
import {
  type AuthConfig,
  createAuthController,
  createAuthHandlers,
  createAuthRepository,
  createAuthService,
  DEFAULT_AUTH_CONFIG,
} from './modules/auth';
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
  createProfilesController,
  createProfilesHandlers,
  createProfilesRepository,
  createProfilesService,
} from './modules/profiles';
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
  createUsersController,
  createUsersHandlers,
  createUsersRepository,
  createUsersService,
} from './modules/users';

export interface ModulesConfig {
  readyTimeoutMs: number;
  sessions: SessionsConfig;
  auth: Partial<AuthConfig>;
  authRateLimits: AuthRateLimitConfig;
  tenantCache: TenantCacheOptions;
  passwordHashConcurrency: number;
  baseDomain: string;
  cookie: { name: string; secure: boolean };
  purge: PurgeConfig;
  jobs: JobsConfig;
  imports: ImportsConfig;
  /** port of the web app for links in queued emails (development only) */
  publicPort: number | undefined;
  mailer: Mailer;
  onBackgroundError: (err: unknown) => void;
}

type Logging = {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

/** "imports:1,invites:4,default:2" -> { imports: 1, invites: 4, default: 2 } (already shape-checked by the env schema). */
export function parseConcurrency(value: string): Record<string, number> {
  const out: Record<string, number> = { default: 2 };
  for (const part of value.split(',')) {
    const [name, n] = part.split(':');
    if (name && n) out[name] = Number(n);
  }
  return out;
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
    | 'RATE_LIMIT_LOGIN_PER_EMAIL'
    | 'RATE_LIMIT_AUTH_WINDOW_MS'
    | 'PASSWORD_HASH_CONCURRENCY'
    | 'TENANT_CACHE_TTL_MS'
    | 'TENANT_CACHE_MAX'
    | 'MAILER'
    | 'MAIL_FILE'
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
  > & { READY_TIMEOUT_MS?: number },
  logger: Logging,
  mailer?: Mailer,
): ModulesConfig {
  return {
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
      perIp: env.RATE_LIMIT_LOGIN_PER_IP,
      perEmail: env.RATE_LIMIT_LOGIN_PER_EMAIL,
      windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS,
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
    publicPort: env.APP_PUBLIC_PORT,
    baseDomain: env.APP_BASE_DOMAIN,
    cookie: cookieSettings(env),
    mailer:
      mailer ??
      (env.MAILER === 'console'
        ? createConsoleMailer((obj, msg) => logger.info(obj, msg))
        : env.MAILER === 'file' && env.MAIL_FILE
          ? createFileMailer(env.MAIL_FILE)
          : createCapturingMailer()),
    onBackgroundError: (err) => logger.error({ err }, 'background task failed'),
  };
}

/**
 * Composition root shared by the API (app.ts) and the worker (worker.ts): plain factory
 * functions with explicit dependencies, wired in one place. No DI framework, no decorators.
 * A module that needs another module's service receives it here, e.g.
 * `createMembershipsService({ db, membershipsRepo, sessionsService })`.
 */
export function createModules(db: Database, config: ModulesConfig) {
  const background = createBackgroundTasks(config.onBackgroundError);
  const hasher = createPasswordHasher({ concurrency: config.passwordHashConcurrency });

  const healthService = createHealthService({
    healthRepo: createHealthRepository({ db }),
    readyTimeoutMs: config.readyTimeoutMs,
  });
  const tenantsService = createTenantsService({
    db,
    tenantsRepo: createTenantsRepository(),
    cache: config.tenantCache,
  });
  const jobsService = createJobsService({
    db,
    jobsRepo: createJobsRepository(),
    config: config.jobs,
  });
  const academicsService = createAcademicsService({
    db,
    academicsRepo: createAcademicsRepository(),
  });
  const profilesService = createProfilesService({
    db,
    profilesRepo: createProfilesRepository(),
  });
  const usersService = createUsersService({ db, usersRepo: createUsersRepository() });
  const sessionsService = createSessionsService({
    db,
    sessionsRepo: createSessionsRepository(),
    config: config.sessions,
  });
  const membershipsService = createMembershipsService({
    db,
    membershipsRepo: createMembershipsRepository(),
  });
  const auditService = createAuditService({ db, auditRepo: createAuditRepository() });
  const tenantsPlatformService = createTenantsPlatformService({
    db,
    platformRepo: createTenantsPlatformRepository(),
    auditService,
    membershipsService,
    mailer: config.mailer,
    config: {
      baseDomain: config.baseDomain,
      secure: config.cookie.secure,
      inviteTtlSeconds: config.auth.inviteTtlSeconds ?? DEFAULT_AUTH_CONFIG.inviteTtlSeconds,
    },
    clearSlugCache: () => tenantsService.clearCache(),
  });
  const authService = createAuthService({
    db,
    authRepo: createAuthRepository(),
    hasher,
    mailer: config.mailer,
    background,
    sessionsService,
    usersService,
    membershipsService,
    auditService,
    config: config.auth,
    tenantOrigin: (slug) =>
      buildOrigin(
        { kind: 'tenant', slug, portSuffix: config.publicPort ? `:${config.publicPort}` : '' },
        config.baseDomain,
        config.cookie.secure,
      ) ?? '',
  });
  const importsService = createImportsService({
    db,
    importsRepo: createImportsRepository(),
    jobsService,
    config: config.imports,
  });

  const handlers: HandlerMap = {
    ...createHealthHandlers({ healthService }),
    ...createTenantsHandlers({ tenantsService }),
    ...createUsersHandlers({ usersService }),
    ...createMembershipsHandlers({ membershipsService }),
    ...createAuditHandlers({ auditService }),
    ...createSessionsHandlers({ sessionsService, purge: config.purge }),
    ...createAuthHandlers({ authService, purge: config.purge }),
    ...createJobsHandlers({ jobsService, purge: config.purge }),
    ...createAcademicsHandlers({ academicsService }),
    ...createProfilesHandlers({ profilesService }),
    ...createImportsHandlers({ importsService, purge: config.purge }),
  };

  return {
    handlers,
    background,
    config,
    jobs: { service: jobsService },
    imports: {
      service: importsService,
      controller: createImportsController({ importsService }),
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
      controller: createAuthController({
        authService,
        cookie: config.cookie,
        baseDomain: config.baseDomain,
      }),
    },
  };
}
export type Modules = ReturnType<typeof createModules>;

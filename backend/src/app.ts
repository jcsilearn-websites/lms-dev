import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyBaseLogger, LogController } from 'fastify';
import { createModules, modulesConfigFromEnv } from './composition';
import { type ApiEnv, rateLimitStoreOf } from './config/env';
import { registerAuthContext } from './core/auth-context';
import { registerRoutePolicy } from './core/authz';
import { registerCsrf } from './core/csrf';
import {
  createReceiptSigner,
  receiptKey,
  registerArrivalClock,
  registerReceipts,
} from './core/deadline';
import { registerErrorHandling } from './core/error-handler';
import { registerHttpTelemetry } from './core/http-telemetry';
import { createKeyRing } from './core/keyring';
import type { EmailProvider } from './core/mail';
import { registerOpenApi } from './core/openapi';
import { createBatchedLimiter, createStrictLimiter, type RateLimitStore } from './core/rate-limit';
import { genReqId, registerRequestId } from './core/request-id';
import { createBadSessionLimiter, registerSecurity } from './core/security';
import { registerUploads } from './core/uploads';
import type { Database } from './db/client';
import { createAcademicsRoutes } from './modules/academics';
import { createAnalyticsRoutes } from './modules/analytics';
import { createAssessmentsRoutes } from './modules/assessments';
import { createAssignmentsRoutes } from './modules/assignments';
import { createAuditRoutes } from './modules/audit';
import { createAuthRoutes } from './modules/auth';
import { createContentRoutes } from './modules/content';
import { createCoursesRoutes } from './modules/courses';
import { createEmailRoutes } from './modules/email';
import { createFilesRoutes, createStorageRoutes } from './modules/files';
import { createGradebookRoutes } from './modules/gradebook';
import { createHealthRoutes } from './modules/health';
import { createImportsRoutes } from './modules/imports';
import { createMembershipsRoutes } from './modules/memberships';
import { createNotificationsRoutes } from './modules/notifications';
import { createClientErrorRoutes, createCspReportRoutes, createMetricsRoutes } from './modules/ops';
import { createPrivacyRoutes } from './modules/privacy';
import { createProfilesRoutes } from './modules/profiles';
import { createProgressRoutes } from './modules/progress';
import { createQuestionsRoutes } from './modules/questions';
import { createRubricsRoutes } from './modules/rubrics';
import { createSessionsRoutes } from './modules/sessions';
import { createTenantsRoutes } from './modules/tenants';
import { createUsageRoutes } from './modules/usage';
import { createUsersRoutes } from './modules/users';
import { createPlaybackRoutes, createVideoRoutes, createVideoUploadRoutes } from './modules/video';

export interface AppDeps {
  env: ApiEnv;
  db: Database;
  logger: FastifyBaseLogger;
  /** Overrides the email provider chosen by EMAIL_PROVIDER (tests inject a capturing one). */
  emailProvider?: EmailProvider;
  /** Overrides the clock of the second factor's time decisions (tests). */
  now?: () => Date;
}

/**
 * Which addresses of a request are believed. With a hop count only the entries the proxies themselves appended are: hop 0 is the
 * socket, each further one the next X-Forwarded-For entry from the RIGHT, and the first untrusted one is the client's address.
 */
function trustedProxies(env: Pick<ApiEnv, 'TRUST_PROXY' | 'TRUST_PROXY_HOPS'>) {
  const hops = env.TRUST_PROXY_HOPS;
  if (!env.TRUST_PROXY || hops === undefined) return env.TRUST_PROXY;
  return (_address: string, hop: number) => hop < hops;
}

/**
 * Builds (but does not start) the API: composition root that wires every module's routes.
 * Callers `listen()` (server.ts) or use `inject()` (tests).
 */
/** Prefix of every application route (health probes are also served at the root). */
export const API_PREFIX = '/api';

export function buildApp({ env, db, logger, emailProvider, now }: AppDeps) {
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
    requestIdHeader: false,
    genReqId,
    bodyLimit: env.BODY_LIMIT_BYTES,
    trustProxy: trustedProxies(env),
    forceCloseConnections: 'idle',
    // the signed storage URLs carry a token of ~250 characters in the path
    routerOptions: { maxParamLength: 2048 },
  }).withTypeProvider<TypeBoxTypeProvider>();

  const modules = createModules(db, {
    ...modulesConfigFromEnv(env, logger, emailProvider),
    ...(now ? { now } : {}),
  });

  // Order matters: error handling, cross-cutting plugins (rate limit, CSRF), tenant + session
  // resolution, then module routes.
  // the arrival time is taken before anything can wait for the database pool
  registerArrivalClock(app, { queueWaitSeconds: env.ARRIVAL_QUEUE_WAIT_SECONDS });
  registerHttpTelemetry(app);
  registerErrorHandling(app);
  registerRequestId(app);
  // Rate limiting (step 14a, docs/adr/0022): a LOCAL tier for every route (decides without a database call, folds its hits into the
  // shared store in batches) and a STRICT tier (shared store on every request) for anonymous / authentication routes.
  const shared: RateLimitStore | null =
    rateLimitStoreOf(env) === 'postgres' ? modules.rateLimit.service.store : null;
  const limiter = createBatchedLimiter({
    shared,
    syncIntervalMs: env.RATE_LIMIT_SYNC_MS,
    onSyncError: (err) => logger.warn({ err }, 'shared rate-limit sync failed; counting locally'),
  });
  const strict = createStrictLimiter({
    shared,
    onError: (err) => logger.warn({ err }, 'shared rate-limit store failed; counting locally'),
  });
  registerSecurity(app, env, modules.config.cookie.name, { limiter, strict });
  registerCsrf(app);
  registerUploads(app, { maxBytes: env.IMPORT_MAX_BYTES });
  registerAuthContext(app, {
    baseDomain: modules.config.baseDomain,
    cookieName: modules.config.cookie.name,
    tenantResolver: modules.tenants.service,
    sessionResolver: modules.sessions.service,
    ...(modules.video.sessionCache ? { cachedSessions: modules.video.sessionCache } : {}),
    badSessions: createBadSessionLimiter({
      max: Math.max(60, Math.round(env.RATE_LIMIT_MAX / 2)),
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limiter,
    }),
  });
  registerReceipts(app, {
    signer: createReceiptSigner({
      key: createKeyRing({
        purpose: 'receipt',
        entries: modules.config.signing.entries,
        legacyKey:
          env.DEADLINE_RECEIPT_SECRET || env.STORAGE_SIGNING_SECRET
            ? receiptKey({
                secret: env.DEADLINE_RECEIPT_SECRET,
                storageSecret: env.STORAGE_SIGNING_SECRET,
              })
            : null,
        legacyEnabled: modules.config.signing.legacyEnabled,
      }),
      windowSeconds: env.DEADLINE_RECEIPT_WINDOW_SECONDS,
    }),
    cookieName: modules.config.cookie.name,
  });
  // step-up uses the same clock as every other decision of the second factor
  registerRoutePolicy(app, {
    enforced: modules.config.mfa.enforced,
    now: now ?? (() => new Date()),
  });
  // Activity (one write per user and local day): recorded AFTER the response, so a request never waits for it. Polling and
  // media-segment requests do not count as a person being active.
  app.addHook('onResponse', async (request, reply) => {
    const auth = request.auth;
    if (!auth?.tenantId || reply.statusCode >= 400) return;
    if (
      /^(\/api)?\/(auth\/me|health|video\/play|storage|notifications\/unread-count|me\/email-status)(\/|\?|$)/.test(
        request.url,
      )
    )
      return;
    modules.analytics.service.noteActivity(auth);
  });
  registerOpenApi(app, env);

  // background work (failed-login bookkeeping, reset emails) is awaited on shutdown
  app.addHook('onClose', async () => modules.background.drain());

  // Platform probes (load balancer, Cloud Run) hit the health routes at the ROOT.
  void app.register(createHealthRoutes({ healthController: modules.health.controller }));
  // The metrics scrape target (a bearer token protects it; absent token = 404)
  void app.register(createMetricsRoutes({ opsController: modules.ops.controller }));

  // Every application route lives under /api: the SPA owns the other paths (/members, /audit, ...), so a
  // gateway can send /api/* to this service and everything else to the SPA without rewriting any URL.
  // The health probes are also reachable under /api/health/* for the same reason.
  void app.register(
    async (api) => {
      void api.register(createHealthRoutes({ healthController: modules.health.controller }));
      void api.register(createTenantsRoutes({ tenantsController: modules.tenants.controller }));
      void api.register(createUsersRoutes({ usersController: modules.users.controller }));
      void api.register(
        createMembershipsRoutes({ membershipsController: modules.memberships.controller }),
      );
      void api.register(
        createAcademicsRoutes({ academicsController: modules.academics.controller }),
      );
      void api.register(createImportsRoutes({ importsController: modules.imports.controller }));
      void api.register(createProfilesRoutes({ profilesController: modules.profiles.controller }));
      void api.register(createCoursesRoutes({ coursesController: modules.courses.controller }));
      void api.register(createContentRoutes({ contentController: modules.content.controller }));
      void api.register(createFilesRoutes({ filesController: modules.files.controller }));
      void api.register(createProgressRoutes({ progressController: modules.progress.controller }));
      void api.register(
        createAnalyticsRoutes({ analyticsController: modules.analytics.controller }),
      );
      void api.register(createUsageRoutes({ usageController: modules.usage.controller }));
      void api.register(
        createAssessmentsRoutes({ assessmentsController: modules.assessments.controller }),
      );
      void api.register(
        createAssignmentsRoutes({ assignmentsController: modules.assignments.controller }),
      );
      void api.register(
        createQuestionsRoutes({ questionsController: modules.questions.controller }),
      );
      void api.register(createRubricsRoutes({ rubricsController: modules.rubrics.controller }));
      void api.register(
        createGradebookRoutes({ gradebookController: modules.gradebook.controller }),
      );
      void api.register(createVideoRoutes({ videoController: modules.video.controller }));
      void api.register(
        createVideoUploadRoutes({
          videoController: modules.video.controller,
          chunkBytes: modules.config.video.chunkBytes,
        }),
      );
      if (modules.video.playbackController) {
        void api.register(
          createPlaybackRoutes({ playbackController: modules.video.playbackController }),
        );
      }
      if (modules.files.storageController) {
        void api.register(
          createStorageRoutes({
            storageController: modules.files.storageController,
            maxBytes: modules.config.storage.maxBytes,
          }),
        );
      }
      void api.register(createAuditRoutes({ auditController: modules.audit.controller }));
      void api.register(
        createNotificationsRoutes({ notificationsController: modules.notifications.controller }),
      );
      void api.register(
        createPrivacyRoutes({
          privacyController: modules.privacy.controller,
          erasureController: modules.privacy.erasureController,
          exportRatePerHour: modules.config.privacy.exportRatePerHour,
        }),
      );
      void api.register(createEmailRoutes({ emailController: modules.email.controller }));
      void api.register(createSessionsRoutes({ sessionsController: modules.sessions.controller }));
      void api.register(
        createAuthRoutes({
          authController: modules.auth.controller,
          rateLimits: modules.config.authRateLimits,
          strict,
        }),
      );
      void api.register(createCspReportRoutes({ opsController: modules.ops.controller }));
      void api.register(createClientErrorRoutes({ opsController: modules.ops.controller }));
    },
    { prefix: API_PREFIX },
  );

  return Object.assign(app, { modules });
}

export type App = ReturnType<typeof buildApp>;

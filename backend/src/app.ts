import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyBaseLogger, LogController } from 'fastify';
import { createModules, modulesConfigFromEnv } from './composition';
import type { ApiEnv } from './config/env';
import { registerAuthContext } from './core/auth-context';
import { registerRoutePolicy } from './core/authz';
import { registerCsrf } from './core/csrf';
import { registerErrorHandling } from './core/error-handler';
import type { Mailer } from './core/mailer';
import { registerOpenApi } from './core/openapi';
import { genReqId, registerRequestId } from './core/request-id';
import { registerSecurity } from './core/security';
import { registerUploads } from './core/uploads';
import type { Database } from './db/client';
import { createAcademicsRoutes } from './modules/academics';
import { createAuditRoutes } from './modules/audit';
import { createAuthRoutes } from './modules/auth';
import { createContentRoutes } from './modules/content';
import { createCoursesRoutes } from './modules/courses';
import { createFilesRoutes, createStorageRoutes } from './modules/files';
import { createHealthRoutes } from './modules/health';
import { createImportsRoutes } from './modules/imports';
import { createMembershipsRoutes } from './modules/memberships';
import { createProfilesRoutes } from './modules/profiles';
import { createSessionsRoutes } from './modules/sessions';
import { createTenantsRoutes } from './modules/tenants';
import { createUsersRoutes } from './modules/users';
import { createPlaybackRoutes, createVideoRoutes, createVideoUploadRoutes } from './modules/video';

export interface AppDeps {
  env: ApiEnv;
  db: Database;
  logger: FastifyBaseLogger;
  /** Overrides the mailer chosen by env.MAILER (tests inject a capturing one). */
  mailer?: Mailer;
}

/**
 * Builds (but does not start) the API: composition root that wires every module's routes.
 * Callers `listen()` (server.ts) or use `inject()` (tests).
 */
/** Prefix of every application route (health probes are also served at the root). */
export const API_PREFIX = '/api';

export function buildApp({ env, db, logger, mailer }: AppDeps) {
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
    requestIdHeader: false,
    genReqId,
    bodyLimit: env.BODY_LIMIT_BYTES,
    trustProxy: env.TRUST_PROXY,
    forceCloseConnections: 'idle',
    // the signed storage URLs carry a token of ~250 characters in the path
    routerOptions: { maxParamLength: 2048 },
  }).withTypeProvider<TypeBoxTypeProvider>();

  const modules = createModules(db, modulesConfigFromEnv(env, logger, mailer));

  // Order matters: error handling, cross-cutting plugins (rate limit, CSRF), tenant + session
  // resolution, then module routes.
  registerErrorHandling(app);
  registerRequestId(app);
  registerSecurity(app, env);
  registerCsrf(app);
  registerUploads(app, { maxBytes: env.IMPORT_MAX_BYTES });
  registerAuthContext(app, {
    baseDomain: modules.config.baseDomain,
    cookieName: modules.config.cookie.name,
    tenantResolver: modules.tenants.service,
    sessionResolver: modules.sessions.service,
    ...(modules.video.sessionCache ? { cachedSessions: modules.video.sessionCache } : {}),
  });
  registerRoutePolicy(app);
  registerOpenApi(app, env);

  // background work (failed-login bookkeeping, reset emails) is awaited on shutdown
  app.addHook('onClose', async () => modules.background.drain());

  // Platform probes (load balancer, Cloud Run) hit the health routes at the ROOT.
  void app.register(createHealthRoutes({ healthController: modules.health.controller }));

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
      void api.register(createSessionsRoutes({ sessionsController: modules.sessions.controller }));
      void api.register(
        createAuthRoutes({
          authController: modules.auth.controller,
          rateLimits: modules.config.authRateLimits,
        }),
      );
    },
    { prefix: API_PREFIX },
  );

  return Object.assign(app, { modules });
}

export type App = ReturnType<typeof buildApp>;

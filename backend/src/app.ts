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
import { createHealthRoutes } from './modules/health';
import { createImportsRoutes } from './modules/imports';
import { createMembershipsRoutes } from './modules/memberships';
import { createProfilesRoutes } from './modules/profiles';
import { createSessionsRoutes } from './modules/sessions';
import { createTenantsRoutes } from './modules/tenants';
import { createUsersRoutes } from './modules/users';

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
export function buildApp({ env, db, logger, mailer }: AppDeps) {
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
    requestIdHeader: false,
    genReqId,
    bodyLimit: env.BODY_LIMIT_BYTES,
    trustProxy: env.TRUST_PROXY,
    forceCloseConnections: 'idle',
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
  });
  registerRoutePolicy(app);
  registerOpenApi(app, env);

  // background work (failed-login bookkeeping, reset emails) is awaited on shutdown
  app.addHook('onClose', async () => modules.background.drain());

  void app.register(createHealthRoutes({ healthController: modules.health.controller }));
  void app.register(createTenantsRoutes({ tenantsController: modules.tenants.controller }));
  void app.register(createUsersRoutes({ usersController: modules.users.controller }));
  void app.register(
    createMembershipsRoutes({ membershipsController: modules.memberships.controller }),
  );
  void app.register(createAcademicsRoutes({ academicsController: modules.academics.controller }));
  void app.register(createImportsRoutes({ importsController: modules.imports.controller }));
  void app.register(createProfilesRoutes({ profilesController: modules.profiles.controller }));
  void app.register(createAuditRoutes({ auditController: modules.audit.controller }));
  void app.register(createSessionsRoutes({ sessionsController: modules.sessions.controller }));
  void app.register(
    createAuthRoutes({
      authController: modules.auth.controller,
      rateLimits: modules.config.authRateLimits,
    }),
  );

  return Object.assign(app, { modules });
}

export type App = ReturnType<typeof buildApp>;

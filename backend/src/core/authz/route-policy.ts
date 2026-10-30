import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
} from 'fastify';
import { ForbiddenError, UnauthorizedError } from '../errors';
import type { Permission } from './catalog';
import { can } from './policy';

// Every route MUST declare exactly one of these in its `config`:
//   config: { permission: 'member.read' }   a named permission (coarse check; services re-check)
//   config: { permission: 'course.edit', scope: 'offering' }
//                                           a permission that is granted by a PARTICIPATION in an offering
//                                           (instructor, assistant, learner). The route hook can only require
//                                           a session; the service resolves the participation and answers 404
//                                           for a non-participant and 403 for a participant without the permission.
//   config: { authenticated: true }         any signed-in user
//   config: { public: true }                no sign-in needed (login, health probes, ...)
declare module 'fastify' {
  interface FastifyContextConfig {
    /** One permission, or several of which ANY suffices (the service then decides which applies). */
    permission?: Permission | readonly Permission[];
    /** 'offering': the permission is decided from the caller's participation by the service. */
    scope?: 'offering';
    authenticated?: boolean;
    public?: boolean;
  }
}

export interface RouteDeclaration {
  permission?: Permission | readonly Permission[] | undefined;
  scope?: 'offering' | undefined;
  authenticated?: boolean | undefined;
  public?: boolean | undefined;
}

/** How many of the three declarations a route made (must be exactly 1). */
export function declarationCount(config: RouteDeclaration | undefined): number {
  if (!config) return 0;
  return (
    (config.permission !== undefined ? 1 : 0) +
    (config.authenticated === true ? 1 : 0) +
    (config.public === true ? 1 : 0)
  );
}

export const requireAuthenticated: onRequestAsyncHookHandler = async (request) => {
  if (!request.auth) throw new UnauthorizedError();
};

/** 401 when not signed in, 403 when the policy denies. Account-level only: zero DB queries. */
export function requirePermission(
  permission: Permission | readonly Permission[],
): onRequestAsyncHookHandler {
  const anyOf = typeof permission === 'string' ? [permission] : permission;
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const a = request.auth;
    if (!a) throw new UnauthorizedError();
    const subject = {
      userId: a.userId,
      tenantId: a.tenantId,
      role: a.membershipRole,
      isPlatformAdmin: a.isPlatformAdmin,
    };
    if (!anyOf.some((p) => can(subject, p))) throw new ForbiddenError();
  };
}

/**
 * Enforces the declaration rule at startup and installs the check: a route with no declaration, or
 * with more than one, makes `app.ready()` fail; a declared permission/authenticated check is added
 * as the FIRST route-level onRequest hook: it runs right after the session is resolved (registerAuthContext)
 * and BEFORE body validation, so an unauthorised caller gets 401/403 and never a validation error.
 * Register before any route.
 */
export function registerRoutePolicy(app: FastifyInstance): void {
  app.addHook('onRoute', (route) => {
    // the OpenAPI docs routes are registered by plugins and are not part of the API surface
    if (route.url.startsWith('/docs') || route.schema?.hide === true) return;
    const config = route.config as RouteDeclaration | undefined;
    if (declarationCount(config) !== 1) {
      throw new Error(
        `route ${String(route.method)} ${route.url} must declare exactly one of ` +
          'config.permission, config.authenticated or config.public',
      );
    }
    let guard: onRequestAsyncHookHandler | undefined;
    if (config?.scope !== undefined && config.permission === undefined) {
      throw new Error(
        `route ${String(route.method)} ${route.url}: config.scope needs a permission`,
      );
    }
    // an offering-scoped permission cannot be decided without the offering: the service does it
    if (config?.permission !== undefined && config.scope === 'offering')
      guard = requireAuthenticated;
    else if (config?.permission !== undefined) guard = requirePermission(config.permission);
    else if (config?.authenticated === true) guard = requireAuthenticated;
    if (!guard) return;
    const existing = route.onRequest;
    const rest = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
    route.onRequest = [guard, ...rest] as typeof route.onRequest;
  });
}

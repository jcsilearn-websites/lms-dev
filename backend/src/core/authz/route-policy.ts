import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
  preHandlerAsyncHookHandler,
} from 'fastify';
import { ForbiddenError, MfaStepUpRequiredError, UnauthorizedError } from '../errors';
import type { Permission } from './catalog';
import { can } from './policy';

// Every route MUST declare exactly one of these in its `config`:
//   config: { permission: 'member.read' }   a named permission (coarse check; services re-check)
//   config: { permission: 'course.edit', scope: 'offering' }
//                                           a permission that is granted by a PARTICIPATION in an offering
//                                           (instructor, assistant, learner). The route hook can only require
//                                           a session; the service resolves the participation and answers 404
//                                           for a non-participant and 403 for a participant without the permission.
//   config: { permission: 'question.manage', scope: 'course' }
//                                           the same for the question bank: granted by a participation (instructor ...)
//                                           in ANY offering of the course
//   config: { authenticated: true }         any signed-in user
//   config: { public: true }                no sign-in needed (login, health probes, ...)
declare module 'fastify' {
  interface FastifyContextConfig {
    /** One permission, or several of which ANY suffices (the service then decides which applies). */
    permission?: Permission | readonly Permission[];
    /** 'offering' / 'course': the permission is decided from the caller's participation by the service. */
    scope?: 'offering' | 'course';
    authenticated?: boolean;
    public?: boolean;
    /**
     * STEP-UP (docs/adr/0026-mfa.md): a person with two-step sign-in must have passed their second factor less than 10 minutes
     * ago, else 403 `mfa_step_up_required`. `true` is checked before body validation; `{ when }` after it (for a route that is
     * sensitive only for some bodies). The routes that carry it are pinned by test/step-up-routes.test.ts.
     */
    stepUp?: true | StepUpCondition;
  }
}

export interface StepUpCondition {
  when(request: FastifyRequest): boolean;
}

/** "Under 10 minutes old": an age of exactly this much is too old. */
export const STEP_UP_MAX_AGE_MS = 10 * 60 * 1000;

export interface StepUpOptions {
  /** two-factor sign-in is enforced for administrators (MFA_ENFORCEMENT=required) */
  enforced: boolean;
  now: () => Date;
}

/** The facts of the session a step-up decision needs. */
export interface StepUpSubject {
  tenantId: string | null;
  membershipRole: string | null;
  isPlatformAdmin: boolean;
  mfaEnrolled: boolean;
  mfaVerifiedAt: Date | null;
}

/**
 * Must this session step up before a sensitive action? It applies to everybody who HAS a second factor, and (where enforcement is
 * on) to everybody whose role on this host must have one: without a factor and without enforcement there is nothing to ask for.
 */
export function needsStepUp(a: StepUpSubject, options: StepUpOptions): boolean {
  // the account role only decides WHO MUST HAVE a factor here; it grants nothing
  const mustHave =
    a.tenantId === null ? a.isPlatformAdmin : a.membershipRole === 'institution_admin';
  if (!a.mfaEnrolled && !(options.enforced && mustHave)) return false;
  if (!a.mfaVerifiedAt) return true;
  return options.now().getTime() - a.mfaVerifiedAt.getTime() >= STEP_UP_MAX_AGE_MS;
}

export interface RouteDeclaration {
  permission?: Permission | readonly Permission[] | undefined;
  scope?: 'offering' | 'course' | undefined;
  authenticated?: boolean | undefined;
  public?: boolean | undefined;
  stepUp?: true | StepUpCondition | undefined;
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
export function registerRoutePolicy(
  app: FastifyInstance,
  stepUp: StepUpOptions = { enforced: false, now: () => new Date() },
): void {
  const requireStepUp = async (request: FastifyRequest): Promise<void> => {
    if (!request.auth) throw new UnauthorizedError();
    if (needsStepUp(request.auth, stepUp)) throw new MfaStepUpRequiredError();
  };
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
    if (config?.permission !== undefined && config.scope !== undefined)
      guard = requireAuthenticated;
    else if (config?.permission !== undefined) guard = requirePermission(config.permission);
    else if (config?.authenticated === true) guard = requireAuthenticated;
    const demand = config?.stepUp;
    if (demand !== undefined && !guard) {
      throw new Error(`route ${String(route.method)} ${route.url}: a public route cannot step up`);
    }
    if (!guard) return;
    const guards: onRequestAsyncHookHandler[] = [guard];
    // after authorization (a caller who may not do it at all learns nothing about step-up), before body validation
    if (demand === true) guards.push(requireStepUp);
    else if (demand) {
      const conditional: preHandlerAsyncHookHandler = async (request) => {
        if (demand.when(request)) await requireStepUp(request);
      };
      const before = route.preHandler;
      const list = before === undefined ? [] : Array.isArray(before) ? before : [before];
      route.preHandler = [conditional, ...list] as typeof route.preHandler;
    }
    const existing = route.onRequest;
    const rest = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
    route.onRequest = [...guards, ...rest] as typeof route.onRequest;
  });
}

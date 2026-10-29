import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  AcceptInviteRequestSchema,
  ChangePasswordRequestSchema,
  ForgotPasswordRequestSchema,
  InviteRequestSchema,
  LoginRequestSchema,
  MemberParamsSchema,
  ResetPasswordRequestSchema,
} from '../../contracts';
import { clientInfo, contextFrom } from '../../core/context';
import { NotFoundError } from '../../core/errors';
import { buildOrigin } from '../../core/host';
import type { AuthService, HostScope } from './auth.service';

export interface SessionCookieConfig {
  name: string;
  secure: boolean;
}

// Reads the validated request, calls the service, maps the result to the response DTO and sets or
// clears the session cookie. No DB access, no business rules.
export function createAuthController(deps: {
  authService: AuthService;
  cookie: SessionCookieConfig;
  baseDomain: string;
}) {
  const { authService, cookie, baseDomain } = deps;

  const cookieOptions = {
    httpOnly: true,
    secure: cookie.secure,
    sameSite: 'lax' as const,
    path: '/',
  };

  function scopeOf(request: FastifyRequest): HostScope {
    const origin = buildOrigin(request.hostInfo, baseDomain, cookie.secure);
    if (!origin) throw new NotFoundError('tenant_not_found', 'Tenant not found');
    const t = request.tenant;
    return { tenant: t ? { id: t.id, slug: t.slug } : null, origin };
  }

  return {
    login: async (
      request: FastifyRequest<{ Body: Static<typeof LoginRequestSchema> }>,
      reply: FastifyReply,
    ) => {
      const tenant = request.tenant ? { id: request.tenant.id, slug: request.tenant.slug } : null;
      const result = await authService.login({
        email: request.body.email,
        password: request.body.password,
        tenant,
        client: clientInfo(request),
      });
      reply.setCookie(cookie.name, result.token, { ...cookieOptions, expires: result.expiresAt });
      return result.me;
    },

    logout: async (request: FastifyRequest, reply: FastifyReply) => {
      await authService.logout(contextFrom(request));
      reply.clearCookie(cookie.name, cookieOptions);
      return { status: 'ok' };
    },

    me: async (request: FastifyRequest) => {
      const t = request.tenant;
      return authService.me(contextFrom(request), t ? { id: t.id, slug: t.slug } : null);
    },

    forgot: async (
      request: FastifyRequest<{ Body: Static<typeof ForgotPasswordRequestSchema> }>,
      reply: FastifyReply,
    ) => {
      await authService.requestPasswordReset({
        email: request.body.email,
        scope: scopeOf(request),
        client: clientInfo(request),
      });
      reply.status(202);
      return { status: 'accepted' };
    },

    reset: async (request: FastifyRequest<{ Body: Static<typeof ResetPasswordRequestSchema> }>) => {
      await authService.resetPassword({
        token: request.body.token,
        newPassword: request.body.newPassword,
        scope: scopeOf(request),
        client: clientInfo(request),
      });
      return { status: 'ok' };
    },

    change: async (
      request: FastifyRequest<{ Body: Static<typeof ChangePasswordRequestSchema> }>,
    ) => {
      await authService.changePassword(contextFrom(request), request.body);
      return { status: 'ok' };
    },

    invite: async (
      request: FastifyRequest<{ Body: Static<typeof InviteRequestSchema> }>,
      reply: FastifyReply,
    ) => {
      await authService.createInvite(contextFrom(request), {
        ...request.body,
        scope: scopeOf(request),
      });
      reply.status(201);
      return { status: 'invited' };
    },

    resendInvite: async (
      request: FastifyRequest<{ Params: Static<typeof MemberParamsSchema> }>,
    ) => {
      await authService.resendInvite(contextFrom(request), request.params.userId, scopeOf(request));
      return { status: 'invited' };
    },

    acceptInvite: async (
      request: FastifyRequest<{ Body: Static<typeof AcceptInviteRequestSchema> }>,
    ) => {
      if (!request.tenant) throw new NotFoundError('tenant_not_found', 'Tenant not found');
      await authService.acceptInvite({
        token: request.body.token,
        password: request.body.password,
        tenantId: request.tenant.id,
        client: clientInfo(request),
      });
      return { status: 'accepted' };
    },

    unlock: async (request: FastifyRequest<{ Params: { userId: string } }>) => {
      await authService.unlockMember(contextFrom(request), request.params.userId);
      return { status: 'ok' };
    },
  };
}
export type AuthController = ReturnType<typeof createAuthController>;

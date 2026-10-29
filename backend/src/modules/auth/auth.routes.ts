import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { requireKnownHost } from '../../core/auth-guards';
import { type AuthRateLimitConfig, createAuthRateLimits } from '../../core/auth-rate-limit';
import type { AuthController } from './auth.controller';
import {
  acceptInviteRouteSchema,
  changeRouteSchema,
  forgotRouteSchema,
  inviteRouteSchema,
  loginRouteSchema,
  logoutRouteSchema,
  meRouteSchema,
  resendInviteRouteSchema,
  resetRouteSchema,
  unlockRouteSchema,
} from './auth.schemas';

// URL + method + schemas + preHandlers only; no logic.
export function createAuthRoutes(deps: {
  authController: AuthController;
  rateLimits: AuthRateLimitConfig;
}): FastifyPluginAsyncTypebox {
  const { authController, rateLimits } = deps;
  return async (app) => {
    // stricter per-IP and per-email limits on the credential-sensitive endpoints
    const limit = createAuthRateLimits(rateLimits);

    app.post(
      '/auth/login',
      {
        config: { public: true },
        onRequest: [limit.perIp],
        preHandler: [requireKnownHost, limit.perEmail],
        schema: loginRouteSchema,
      },
      authController.login,
    );
    app.post(
      '/auth/logout',
      { config: { authenticated: true }, schema: logoutRouteSchema },
      authController.logout,
    );
    app.get(
      '/auth/me',
      { config: { authenticated: true }, schema: meRouteSchema },
      authController.me,
    );

    app.post(
      '/auth/password/forgot',
      {
        config: { public: true },
        onRequest: [limit.perIp],
        preHandler: [requireKnownHost, limit.perEmail],
        schema: forgotRouteSchema,
      },
      authController.forgot,
    );
    app.post(
      '/auth/password/reset',
      { config: { public: true }, preHandler: [requireKnownHost], schema: resetRouteSchema },
      authController.reset,
    );
    app.post(
      '/auth/password/change',
      { config: { authenticated: true }, schema: changeRouteSchema },
      authController.change,
    );

    app.post(
      '/auth/invites',
      { config: { permission: 'member.invite' }, schema: inviteRouteSchema },
      authController.invite,
    );
    app.post(
      '/members/:userId/resend-invite',
      { config: { permission: 'member.invite' }, schema: resendInviteRouteSchema },
      authController.resendInvite,
    );
    app.post(
      '/auth/invites/accept',
      {
        config: { public: true },
        onRequest: [limit.perIp],
        preHandler: [requireKnownHost],
        schema: acceptInviteRouteSchema,
      },
      authController.acceptInvite,
    );

    app.post(
      '/auth/members/:userId/unlock',
      {
        // tenant host: institution admins; admin host: platform admins (the service picks)
        config: { permission: ['member.unlock', 'platform.user.unlock'] },
        schema: unlockRouteSchema,
      },
      authController.unlock,
    );
  };
}

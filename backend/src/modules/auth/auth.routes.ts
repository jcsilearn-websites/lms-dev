import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { requireKnownHost } from '../../core/auth-guards';
import { type AuthRateLimitConfig, createAuthRateLimits } from '../../core/auth-rate-limit';
import type { StrictLimiter } from '../../core/rate-limit';
import type { AuthController } from './auth.controller';
import {
  acceptInviteRouteSchema,
  changeRouteSchema,
  forgotRouteSchema,
  inviteRouteSchema,
  loginRouteSchema,
  logoutRouteSchema,
  meRouteSchema,
  mfaDisableRouteSchema,
  mfaEnrolConfirmRouteSchema,
  mfaEnrolStartRouteSchema,
  mfaRecoveryCodesRouteSchema,
  mfaReplaceConfirmRouteSchema,
  mfaReplaceStartRouteSchema,
  mfaResetApproveRouteSchema,
  mfaResetCancelRouteSchema,
  mfaResetFileRouteSchema,
  mfaResetListRouteSchema,
  mfaResetRejectRouteSchema,
  mfaStatusRouteSchema,
  mfaStepUpRouteSchema,
  mfaVerifyRouteSchema,
  resendInviteRouteSchema,
  resetRouteSchema,
  unlockRouteSchema,
} from './auth.schemas';

// URL + method + schemas + preHandlers only; no logic.
export function createAuthRoutes(deps: {
  authController: AuthController;
  rateLimits: AuthRateLimitConfig;
  /** the shared store's strict tier: the per-IP / per-email buckets are then shared by every API instance */
  strict?: StrictLimiter;
}): FastifyPluginAsyncTypebox {
  const { authController, rateLimits, strict } = deps;
  return async (app) => {
    // stricter per-IP and per-email limits on the credential-sensitive endpoints
    const limit = createAuthRateLimits(rateLimits, strict);

    app.post(
      '/auth/login',
      {
        config: { public: true },
        onRequest: [limit.signInPerIp],
        preHandler: [requireKnownHost, limit.perEmail],
        onError: [limit.signInFailed],
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

    // two-factor sign-in (step 14c). Public: the challenge cookie (or the emailed token) is the authority; the same
    // per-address limit as sign-in, shared by every instance
    app.post(
      '/auth/mfa/verify',
      {
        config: { public: true },
        onRequest: [limit.perIp],
        preHandler: [requireKnownHost],
        schema: mfaVerifyRouteSchema,
      },
      authController.mfaVerify,
    );
    app.post(
      '/auth/mfa/enrol/start',
      {
        config: { public: true },
        onRequest: [limit.perIp],
        preHandler: [requireKnownHost],
        schema: mfaEnrolStartRouteSchema,
      },
      authController.mfaEnrolStart,
    );
    app.post(
      '/auth/mfa/enrol/confirm',
      {
        config: { public: true },
        onRequest: [limit.perIp],
        preHandler: [requireKnownHost],
        schema: mfaEnrolConfirmRouteSchema,
      },
      authController.mfaEnrolConfirm,
    );
    app.get(
      '/me/mfa',
      { config: { authenticated: true }, schema: mfaStatusRouteSchema },
      authController.mfaStatus,
    );
    // the same per-address limit as sign-in: a stolen session cannot guess codes through this door faster
    app.post(
      '/me/mfa/step-up',
      { config: { authenticated: true }, onRequest: [limit.perIp], schema: mfaStepUpRouteSchema },
      authController.mfaStepUp,
    );
    const own = { authenticated: true, stepUp: true } as const;
    app.post(
      '/me/mfa/replace/start',
      { config: own, schema: mfaReplaceStartRouteSchema },
      authController.mfaReplaceStart,
    );
    app.post(
      '/me/mfa/replace/confirm',
      { config: own, schema: mfaReplaceConfirmRouteSchema },
      authController.mfaReplaceConfirm,
    );
    app.post(
      '/me/mfa/recovery-codes',
      { config: own, schema: mfaRecoveryCodesRouteSchema },
      authController.mfaRecoveryCodes,
    );
    app.post(
      '/me/mfa/disable',
      { config: own, schema: mfaDisableRouteSchema },
      authController.mfaDisable,
    );

    // ---- reset of a lost second factor: platform administrators, three different people
    const resets = { permission: 'platform.mfa_reset.manage' } as const;
    const resetWrite = { ...resets, stepUp: true } as const;
    app.get(
      '/platform/mfa-resets',
      { config: resets, schema: mfaResetListRouteSchema },
      authController.mfaResetList,
    );
    app.post(
      '/platform/mfa-resets',
      { config: resetWrite, schema: mfaResetFileRouteSchema },
      authController.mfaResetFile,
    );
    app.post(
      '/platform/mfa-resets/:id/approve',
      { config: resetWrite, schema: mfaResetApproveRouteSchema },
      authController.mfaResetDecide('approve'),
    );
    app.post(
      '/platform/mfa-resets/:id/reject',
      { config: resetWrite, schema: mfaResetRejectRouteSchema },
      authController.mfaResetDecide('reject'),
    );
    app.post(
      '/platform/mfa-resets/:id/cancel',
      { config: resetWrite, schema: mfaResetCancelRouteSchema },
      authController.mfaResetDecide('cancel'),
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
      {
        // the token is the authority; the strict limit stops guessing and flooding across every instance
        config: { public: true, strictRateLimit: { max: 30, windowMs: 60_000 } },
        preHandler: [requireKnownHost],
        schema: resetRouteSchema,
      },
      authController.reset,
    );
    app.post(
      '/auth/password/change',
      // step-up: only for a person who has (or must have) a second factor
      { config: { authenticated: true, stepUp: true }, schema: changeRouteSchema },
      authController.change,
    );

    app.post(
      '/auth/invites',
      {
        // inviting an institution admin asks for a step-up; inviting a member does not
        config: {
          permission: 'member.invite',
          stepUp: {
            when: (request) => (request.body as { role?: string }).role === 'institution_admin',
          },
        },
        schema: inviteRouteSchema,
      },
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
        config: { permission: ['member.unlock', 'platform.user.unlock'], stepUp: true },
        schema: unlockRouteSchema,
      },
      authController.unlock,
    );
  };
}

import { Type } from '@sinclair/typebox';
import {
  AcceptInviteRequestSchema,
  AckSchema,
  ChangePasswordRequestSchema,
  COMMON_ERRORS,
  ForgotPasswordRequestSchema,
  InviteRequestSchema,
  LoginChallengeSchema,
  LoginRequestSchema,
  MemberParamsSchema,
  MeResponseSchema,
  MfaEnrolConfirmRequestSchema,
  MfaEnrolConfirmResponseSchema,
  MfaEnrolStartRequestSchema,
  MfaEnrolStartResponseSchema,
  MfaRecoveryCodesResponseSchema,
  MfaResetFileSchema,
  MfaResetListSchema,
  MfaResetResultSchema,
  MfaStatusSchema,
  MfaStepUpRequestSchema,
  MfaStepUpResponseSchema,
  MfaVerifyRequestSchema,
  ResetPasswordRequestSchema,
} from '../../contracts';

const tags = ['auth'];

export const loginRouteSchema = {
  tags,
  summary: 'Log in with email + password (sets the session cookie)',
  body: LoginRequestSchema,
  response: { 200: MeResponseSchema, 202: LoginChallengeSchema, ...COMMON_ERRORS },
};

export const mfaVerifyRouteSchema = {
  tags,
  summary: 'Second step of a sign-in: a code of the authenticator app, or a recovery code',
  body: MfaVerifyRequestSchema,
  response: { 200: MeResponseSchema, ...COMMON_ERRORS },
};

export const mfaEnrolStartRouteSchema = {
  tags,
  summary: 'Start setting up two-step sign-in (the emailed link and the password)',
  body: MfaEnrolStartRequestSchema,
  response: { 200: MfaEnrolStartResponseSchema, ...COMMON_ERRORS },
};

export const mfaEnrolConfirmRouteSchema = {
  tags,
  summary: 'Confirm the authenticator app with its first code; answers the recovery codes ONCE',
  body: MfaEnrolConfirmRequestSchema,
  response: { 200: MfaEnrolConfirmResponseSchema, ...COMMON_ERRORS },
};

export const mfaStatusRouteSchema = {
  tags,
  summary: 'My two-step sign-in: required, set up, recovery codes left',
  response: { 200: MfaStatusSchema, ...COMMON_ERRORS },
};

export const mfaStepUpRouteSchema = {
  tags,
  summary: 'Prove the second factor again inside a session (a code, or a recovery code)',
  body: MfaStepUpRequestSchema,
  response: { 200: MfaStepUpResponseSchema, ...COMMON_ERRORS },
};

export const mfaReplaceStartRouteSchema = {
  tags,
  summary: 'Start replacing the authenticator app (step-up required): the new secret',
  response: { 200: MfaEnrolStartResponseSchema, ...COMMON_ERRORS },
};

export const mfaReplaceConfirmRouteSchema = {
  tags,
  summary: 'The first code of the new app: it replaces the old one and ends the other sessions',
  body: MfaEnrolConfirmRequestSchema,
  response: { 200: AckSchema, ...COMMON_ERRORS },
};

export const mfaRecoveryCodesRouteSchema = {
  tags,
  summary: 'New recovery codes (step-up required): shown once, the earlier ones stop working',
  response: { 200: MfaRecoveryCodesResponseSchema, ...COMMON_ERRORS },
};

export const mfaDisableRouteSchema = {
  tags,
  summary: 'Turn two-step sign-in off (step-up required; refused while a role requires it)',
  response: { 200: AckSchema, ...COMMON_ERRORS },
};

const resetTags = ['platform', 'auth'];
const resetParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

export const mfaResetListRouteSchema = {
  tags: resetTags,
  summary: 'Resets of lost second factors (newest first)',
  querystring: Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    after: Type.Optional(Type.String({ format: 'uuid' })),
  }),
  response: { 200: MfaResetListSchema, ...COMMON_ERRORS },
};

export const mfaResetFileRouteSchema = {
  tags: resetTags,
  summary: 'File the reset of the second factor of the account with this address',
  body: MfaResetFileSchema,
  response: { 202: MfaResetResultSchema, ...COMMON_ERRORS },
};

const resetDecideSchema = (summary: string) => ({
  tags: resetTags,
  summary,
  params: resetParams,
  response: { 200: MfaResetResultSchema, ...COMMON_ERRORS },
});
export const mfaResetApproveRouteSchema = resetDecideSchema(
  'Approve (neither the filer nor the person): executed 24 hours later',
);
export const mfaResetRejectRouteSchema = resetDecideSchema('Reject a request that is not decided');
export const mfaResetCancelRouteSchema = resetDecideSchema('Cancel a request that has not run');

export const logoutRouteSchema = {
  tags,
  summary: 'Log out (revokes the current session)',
  response: { 200: AckSchema, ...COMMON_ERRORS },
};

export const meRouteSchema = {
  tags,
  summary: 'The signed-in user, tenant, role and platform-admin flag',
  response: { 200: MeResponseSchema, ...COMMON_ERRORS },
};

export const forgotRouteSchema = {
  tags,
  summary: 'Request a password-reset email (always 202)',
  body: ForgotPasswordRequestSchema,
  response: { 202: AckSchema, ...COMMON_ERRORS },
};

export const resetRouteSchema = {
  tags,
  summary: 'Reset the password with an emailed token',
  body: ResetPasswordRequestSchema,
  response: { 200: AckSchema, ...COMMON_ERRORS },
};

export const changeRouteSchema = {
  tags,
  summary: 'Change my password (requires the current one)',
  body: ChangePasswordRequestSchema,
  response: { 200: AckSchema, ...COMMON_ERRORS },
};

export const inviteRouteSchema = {
  tags,
  summary: 'Invite someone to this institution (institution admin)',
  body: InviteRequestSchema,
  response: { 201: AckSchema, ...COMMON_ERRORS },
};

export const acceptInviteRouteSchema = {
  tags,
  summary: 'Accept an invite (sets the password for new users)',
  body: AcceptInviteRequestSchema,
  response: { 200: AckSchema, ...COMMON_ERRORS },
};

export const unlockRouteSchema = {
  tags,
  summary: 'Unlock a locked account (institution admin; platform admin on the admin host)',
  params: Type.Object({ userId: Type.String({ format: 'uuid' }) }),
  response: { 200: AckSchema, ...COMMON_ERRORS },
};

export const resendInviteRouteSchema = {
  tags: ['members'],
  summary: 'Send a new invite email to a member who has not accepted yet (voids the old token)',
  params: MemberParamsSchema,
  response: { 200: AckSchema, ...COMMON_ERRORS },
};

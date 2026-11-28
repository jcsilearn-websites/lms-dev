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
  MfaStatusSchema,
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

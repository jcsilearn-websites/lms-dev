import { type Static, Type } from '@sinclair/typebox';
import { MembershipRoleSchema } from './roles';

// Not format:'email': the service trims/lowercases first and validates, so ' Ada@X.com ' is accepted.
const Email = Type.String({ minLength: 3, maxLength: 320 });
// Passwords are validated by the auth service (min 10, max 128, common-password list); the schema
// only bounds the size so oversized input is rejected before hashing.
const Password = Type.String({ minLength: 1, maxLength: 1024 });
const Token = Type.String({ minLength: 20, maxLength: 200 });
const Uuid = Type.String({ format: 'uuid' });

export const AckSchema = Type.Object({ status: Type.String() });
export type Ack = Static<typeof AckSchema>;

export const LoginRequestSchema = Type.Object({ email: Email, password: Password });
export type LoginRequest = Static<typeof LoginRequestSchema>;

export const SessionUserSchema = Type.Object({
  id: Uuid,
  email: Type.String(),
  displayName: Type.String(),
});

/** Response of POST /auth/login and GET /auth/me. */
export const MeResponseSchema = Type.Object({
  user: SessionUserSchema,
  tenant: Type.Union([Type.Object({ id: Uuid, slug: Type.String() }), Type.Null()]),
  role: Type.Union([MembershipRoleSchema, Type.Null()]),
  isPlatformAdmin: Type.Boolean(),
  /**
   * Account-level permission names the caller holds in this scope (see docs/permissions.md). For
   * the UI only: it decides what to SHOW. Hiding a button is cosmetic; the backend checks every
   * request again and stays the source of truth.
   */
  permissions: Type.Array(Type.String()),
});
export type MeResponse = Static<typeof MeResponseSchema>;

// ---- two-factor sign-in (step 14c, docs/adr/0026-mfa.md)

/**
 * 202 of POST /auth/login: the password was right but there is NO session yet. `totp`: send the code to /auth/mfa/verify (the
 * challenge cookie is set). `enrol_email`: this account must set up its second factor first; a link was e-mailed to it.
 */
export const LoginChallengeSchema = Type.Object({
  step: Type.Union([Type.Literal('totp'), Type.Literal('enrol_email')]),
});
export type LoginChallenge = Static<typeof LoginChallengeSchema>;

const TotpCode = Type.String({ pattern: '^[0-9]{6}$' });

/** Exactly one of `code` (the authenticator app) and `recoveryCode`. */
export const MfaVerifyRequestSchema = Type.Object({
  code: Type.Optional(TotpCode),
  recoveryCode: Type.Optional(Type.String({ minLength: 10, maxLength: 24 })),
});
export type MfaVerifyRequest = Static<typeof MfaVerifyRequestSchema>;

export const MfaEnrolStartRequestSchema = Type.Object({ token: Token, password: Password });
export type MfaEnrolStartRequest = Static<typeof MfaEnrolStartRequestSchema>;

export const MfaEnrolStartResponseSchema = Type.Object({
  /** base32, for typing into an authenticator app */
  secret: Type.String(),
  /** the same as a link; the QR code of the screen encodes exactly this */
  otpauthUri: Type.String(),
});
export type MfaEnrolStartResponse = Static<typeof MfaEnrolStartResponseSchema>;

export const MfaEnrolConfirmRequestSchema = Type.Object({ code: TotpCode });
export type MfaEnrolConfirmRequest = Static<typeof MfaEnrolConfirmRequestSchema>;

export const MfaEnrolConfirmResponseSchema = Type.Object({
  /** shown ONCE: they are stored only as keyed hashes */
  recoveryCodes: Type.Array(Type.String()),
  me: MeResponseSchema,
});
export type MfaEnrolConfirmResponse = Static<typeof MfaEnrolConfirmResponseSchema>;

export const MfaStatusSchema = Type.Object({
  /** the role on this host must use a second factor */
  required: Type.Boolean(),
  enrolled: Type.Boolean(),
  enrolledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  recoveryCodesRemaining: Type.Integer({ minimum: 0 }),
  /** false while any role of this person must use a second factor */
  canDisable: Type.Boolean(),
});
export type MfaStatus = Static<typeof MfaStatusSchema>;

/** POST /me/mfa/step-up: exactly one of the two. */
export const MfaStepUpRequestSchema = MfaVerifyRequestSchema;
export type MfaStepUpRequest = MfaVerifyRequest;

export const MfaStepUpResponseSchema = Type.Object({
  /** until then the actions that ask for a step-up are allowed */
  validUntil: Type.String({ format: 'date-time' }),
});
export type MfaStepUpResponse = Static<typeof MfaStepUpResponseSchema>;

export const MfaRecoveryCodesResponseSchema = Type.Object({
  /** shown ONCE; the earlier codes stop working */
  recoveryCodes: Type.Array(Type.String()),
});
export type MfaRecoveryCodesResponse = Static<typeof MfaRecoveryCodesResponseSchema>;

// ---- reset of a lost second factor (platform administrators, three different people)

const MfaResetStatus = Type.Union([
  Type.Literal('pending_approval'),
  Type.Literal('approved'),
  Type.Literal('done'),
  Type.Literal('rejected'),
  Type.Literal('cancelled'),
  Type.Literal('expired'),
]);
const NullableDateTime = Type.Union([Type.String({ format: 'date-time' }), Type.Null()]);
const NullableText = Type.Union([Type.String(), Type.Null()]);

export const MfaResetRequestSchema = Type.Object({
  id: Uuid,
  status: MfaResetStatus,
  requestedAt: Type.String({ format: 'date-time' }),
  expiresAt: Type.String({ format: 'date-time' }),
  executeAfter: NullableDateTime,
});
export type MfaResetRequest = Static<typeof MfaResetRequestSchema>;

export const MfaResetItemSchema = Type.Composite([
  MfaResetRequestSchema,
  Type.Object({
    executedAt: NullableDateTime,
    /** why it ended without a decision: subject_signed_in, subject_disabled, no_factor, break_glass */
    reason: NullableText,
    personName: Type.String(),
    personEmail: NullableText,
    requestedByName: Type.String(),
    approvedByName: NullableText,
    /** the caller is neither the filer nor the person */
    canApprove: Type.Boolean(),
    canCancel: Type.Boolean(),
  }),
]);
export type MfaResetItem = Static<typeof MfaResetItemSchema>;

export const MfaResetListSchema = Type.Object({
  items: Type.Array(MfaResetItemSchema),
  nextCursor: NullableText,
});
export type MfaResetList = Static<typeof MfaResetListSchema>;

export const MfaResetFileSchema = Type.Object({ email: Email }, { additionalProperties: false });
export type MfaResetFile = Static<typeof MfaResetFileSchema>;

export const MfaResetResultSchema = Type.Object({ request: MfaResetRequestSchema });
export type MfaResetResult = Static<typeof MfaResetResultSchema>;

export const ForgotPasswordRequestSchema = Type.Object({ email: Email });
export const ResetPasswordRequestSchema = Type.Object({ token: Token, newPassword: Password });
export const ChangePasswordRequestSchema = Type.Object({
  currentPassword: Password,
  newPassword: Password,
});

export const InviteRequestSchema = Type.Object({
  email: Email,
  role: MembershipRoleSchema,
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});
export const AcceptInviteRequestSchema = Type.Object({
  token: Token,
  password: Type.Optional(Password),
});

export const SessionDtoSchema = Type.Object({
  id: Uuid,
  createdAt: Type.String({ format: 'date-time' }),
  lastSeenAt: Type.String({ format: 'date-time' }),
  ip: Type.Union([Type.String(), Type.Null()]),
  userAgent: Type.Union([Type.String(), Type.Null()]),
  current: Type.Boolean(),
});
export const SessionListSchema = Type.Object({
  items: Type.Array(SessionDtoSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});
export type SessionList = Static<typeof SessionListSchema>;

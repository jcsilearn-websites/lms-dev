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

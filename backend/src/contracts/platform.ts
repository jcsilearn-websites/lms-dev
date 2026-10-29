import { type Static, Type } from '@sinclair/typebox';
import { MemberListQuerySchema, MemberListResponseSchema } from './members';

const Uuid = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const Email = Type.String({ minLength: 3, maxLength: 320 });

export const TenantStatusSchema = Type.Union([Type.Literal('active'), Type.Literal('suspended')]);

export const TenantSchema = Type.Object({
  id: Uuid,
  slug: Type.String(),
  name: Type.String(),
  status: TenantStatusSchema,
  createdAt: DateTime,
  updatedAt: DateTime,
});
export type TenantDto = Static<typeof TenantSchema>;

export const TenantDetailSchema = Type.Composite([
  TenantSchema,
  Type.Object({ members: Type.Integer(), activeAdmins: Type.Integer() }),
]);

export const TenantListQuerySchema = Type.Object({
  /** Prefix of the name or the slug (at least 2 characters). */
  q: Type.Optional(Type.String({ minLength: 2, maxLength: 100 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});
export const TenantListResponseSchema = Type.Object({
  items: Type.Array(TenantSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

export const TenantParamsSchema = Type.Object({ id: Uuid });

export const CreateTenantRequestSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  /** 3-63 characters: lowercase letters, digits, hyphens; not a reserved word. Immutable once set. */
  slug: Type.String({ minLength: 3, maxLength: 63 }),
  adminEmail: Email,
  adminName: Type.String({ minLength: 1, maxLength: 200 }),
});
export const UpdateTenantRequestSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
});

export const AdminInviteRequestSchema = Type.Object({
  email: Email,
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
});
export const AdminInviteResponseSchema = Type.Object({
  /** invited: an invite email was sent; promoted: an active member became institution_admin. */
  outcome: Type.Union([Type.Literal('invited'), Type.Literal('promoted')]),
  userId: Uuid,
  membershipId: Uuid,
});

export const CreateTenantResponseSchema = Type.Object({
  tenant: TenantSchema,
  adminInvite: AdminInviteResponseSchema,
});

export const PlatformMembersQuerySchema = MemberListQuerySchema;
export const PlatformMembersResponseSchema = MemberListResponseSchema;

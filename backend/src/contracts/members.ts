import { type Static, Type } from '@sinclair/typebox';
import { MembershipRoleSchema } from './roles';

const Uuid = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });

export const MEMBER_STATUSES = ['active', 'pending', 'suspended'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];
export const MemberStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('pending'),
  Type.Literal('suspended'),
]);

const NullableId = Type.Union([Type.String({ format: 'uuid' }), Type.Null()]);

export const MemberSchema = Type.Object({
  /** The membership id (also the pagination cursor). */
  id: Uuid,
  userId: Uuid,
  email: Type.String(),
  displayName: Type.String(),
  role: MembershipRoleSchema,
  status: MemberStatusSchema,
  createdAt: DateTime,
  /** From the member profile (null when there is none). A LABEL: it grants no permission. */
  profileType: Type.Optional(
    Type.Union([
      Type.Literal('student'),
      Type.Literal('faculty'),
      Type.Literal('staff'),
      Type.Null(),
    ]),
  ),
  registerNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  employeeId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  departmentId: Type.Optional(NullableId),
  batchId: Type.Optional(NullableId),
  sectionId: Type.Optional(NullableId),
});
export type Member = Static<typeof MemberSchema>;

export const MemberListQuerySchema = Type.Object({
  role: Type.Optional(MembershipRoleSchema),
  status: Type.Optional(MemberStatusSchema),
  /** Prefix of the email or of the display name (at least 2 characters). */
  q: Type.Optional(Type.String({ minLength: 2, maxLength: 100 })),
  /** Filters on the member profile. */
  profileType: Type.Optional(
    Type.Union([Type.Literal('student'), Type.Literal('faculty'), Type.Literal('staff')]),
  ),
  departmentId: Type.Optional(Type.String({ format: 'uuid' })),
  batchId: Type.Optional(Type.String({ format: 'uuid' })),
  sectionId: Type.Optional(Type.String({ format: 'uuid' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});
export type MemberListQuery = Static<typeof MemberListQuerySchema>;

export const MemberListResponseSchema = Type.Object({
  items: Type.Array(MemberSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});
export type MemberListResponse = Static<typeof MemberListResponseSchema>;

export const ChangeMemberRoleRequestSchema = Type.Object({ role: MembershipRoleSchema });

export const MemberParamsSchema = Type.Object({ userId: Uuid });

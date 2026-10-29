import { Type } from '@sinclair/typebox';

/** Tenant-level roles (tenant_memberships.role). Authorization uses permission names, not these. */
export const MEMBERSHIP_ROLES = ['institution_admin', 'member'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];
export const MembershipRoleSchema = Type.Union([
  Type.Literal('institution_admin'),
  Type.Literal('member'),
]);

export const isMembershipRole = (value: unknown): value is MembershipRole =>
  typeof value === 'string' && (MEMBERSHIP_ROLES as readonly string[]).includes(value);

/** Course participation types (used by the courses module in a later step). */
export const PARTICIPATION_TYPES = ['instructor', 'assistant', 'learner'] as const;

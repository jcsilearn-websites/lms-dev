import {
  AckSchema,
  ChangeMemberRoleRequestSchema,
  COMMON_ERRORS,
  MemberListQuerySchema,
  MemberListResponseSchema,
  MemberParamsSchema,
  MemberSchema,
} from '../../contracts';

const tags = ['members'];

export const listMembersRouteSchema = {
  tags,
  summary: 'List members (keyset pagination; filters: role, status, q = email/name prefix)',
  querystring: MemberListQuerySchema,
  response: { 200: MemberListResponseSchema, ...COMMON_ERRORS },
};

export const getMemberRouteSchema = {
  tags,
  summary: 'One member',
  params: MemberParamsSchema,
  response: { 200: MemberSchema, ...COMMON_ERRORS },
};

export const changeRoleRouteSchema = {
  tags,
  summary: 'Change a member role (institution_admin <-> member); revokes their sessions here',
  params: MemberParamsSchema,
  body: ChangeMemberRoleRequestSchema,
  response: { 200: MemberSchema, ...COMMON_ERRORS },
};

export const suspendMemberRouteSchema = {
  tags,
  summary: 'Suspend a member: sessions are revoked and they cannot log in',
  params: MemberParamsSchema,
  response: { 200: MemberSchema, ...COMMON_ERRORS },
};

export const reactivateMemberRouteSchema = {
  tags,
  summary: 'Reactivate a suspended member',
  params: MemberParamsSchema,
  response: { 200: MemberSchema, ...COMMON_ERRORS },
};

export const removeMemberRouteSchema = {
  tags,
  summary: 'Remove the membership (the global user is kept)',
  params: MemberParamsSchema,
  response: { 200: AckSchema, ...COMMON_ERRORS },
};

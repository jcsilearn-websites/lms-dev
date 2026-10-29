import {
  BulkMoveSectionRequestSchema,
  COMMON_ERRORS,
  MemberParamsSchema,
  MoveSectionRequestSchema,
  MoveSectionResponseSchema,
  ProfileSchema,
  UpdateProfileRequestSchema,
} from '../../contracts';

const tags = ['profiles'];

export const getProfileRouteSchema = {
  tags,
  summary: "A member's profile (institution admin). profileType is a label and grants nothing",
  params: MemberParamsSchema,
  response: { 200: ProfileSchema, ...COMMON_ERRORS },
};

export const updateProfileRouteSchema = {
  tags,
  summary: 'Create or change a member profile (null clears a field); audited',
  params: MemberParamsSchema,
  body: UpdateProfileRequestSchema,
  response: { 200: ProfileSchema, ...COMMON_ERRORS },
};

export const ownProfileRouteSchema = {
  tags,
  summary: 'My own profile',
  response: { 200: ProfileSchema, ...COMMON_ERRORS },
};

export const moveOneRouteSchema = {
  tags,
  summary: 'Move one student to a section of their own batch; audited',
  params: MemberParamsSchema,
  body: MoveSectionRequestSchema,
  response: { 200: MoveSectionResponseSchema, ...COMMON_ERRORS },
};

export const moveManyRouteSchema = {
  tags,
  summary: 'Move up to 500 students to a section of their own batch; one audit entry per student',
  body: BulkMoveSectionRequestSchema,
  response: { 200: MoveSectionResponseSchema, ...COMMON_ERRORS },
};

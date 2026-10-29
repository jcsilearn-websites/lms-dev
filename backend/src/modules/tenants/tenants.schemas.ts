import {
  AdminInviteRequestSchema,
  AdminInviteResponseSchema,
  COMMON_ERRORS,
  CreateTenantRequestSchema,
  CreateTenantResponseSchema,
  MemberListQuerySchema,
  PlatformMembersResponseSchema,
  TenantDetailSchema,
  TenantInfoSchema,
  TenantListQuerySchema,
  TenantListResponseSchema,
  TenantParamsSchema,
  TenantSchema,
  UpdateBrandingRequestSchema,
  UpdateTenantRequestSchema,
} from '../../contracts';

const tags = ['platform'];

export const tenantInfoRouteSchema = {
  tags: ['tenant'],
  summary: 'Public branding of the college behind this host (display name, primary colour, slug)',
  response: { 200: TenantInfoSchema, ...COMMON_ERRORS },
};

export const updateBrandingRouteSchema = {
  tags: ['tenant'],
  summary: 'Change the college branding (institution admin)',
  body: UpdateBrandingRequestSchema,
  response: { 200: TenantInfoSchema, ...COMMON_ERRORS },
};

export const createTenantRouteSchema = {
  tags,
  summary: 'Create a college and invite its first institution admin (platform admin, admin host)',
  body: CreateTenantRequestSchema,
  response: { 201: CreateTenantResponseSchema, ...COMMON_ERRORS },
};

export const listTenantsRouteSchema = {
  tags,
  summary: 'List colleges (keyset pagination; q = name or slug prefix)',
  querystring: TenantListQuerySchema,
  response: { 200: TenantListResponseSchema, ...COMMON_ERRORS },
};

export const getTenantRouteSchema = {
  tags,
  summary: 'One college with member counts',
  params: TenantParamsSchema,
  response: { 200: TenantDetailSchema, ...COMMON_ERRORS },
};

export const updateTenantRouteSchema = {
  tags,
  summary: 'Rename a college (the slug is immutable)',
  params: TenantParamsSchema,
  body: UpdateTenantRequestSchema,
  response: { 200: TenantSchema, ...COMMON_ERRORS },
};

export const suspendTenantRouteSchema = {
  tags,
  summary: 'Suspend a college: its sessions stop working immediately',
  params: TenantParamsSchema,
  response: { 200: TenantSchema, ...COMMON_ERRORS },
};

export const reactivateTenantRouteSchema = {
  tags,
  summary: 'Reactivate a suspended college',
  params: TenantParamsSchema,
  response: { 200: TenantSchema, ...COMMON_ERRORS },
};

export const adminInviteRouteSchema = {
  tags,
  summary: 'Invite (or promote) an institution admin of a college; audited in both logs',
  params: TenantParamsSchema,
  body: AdminInviteRequestSchema,
  response: { 201: AdminInviteResponseSchema, ...COMMON_ERRORS },
};

export const tenantMembersRouteSchema = {
  tags,
  summary: "Read-only view of a college's members; every call is audited in both logs",
  params: TenantParamsSchema,
  querystring: MemberListQuerySchema,
  response: { 200: PlatformMembersResponseSchema, ...COMMON_ERRORS },
};

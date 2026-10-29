import { AuditListQuerySchema, AuditListResponseSchema, COMMON_ERRORS } from '../../contracts';

const tags = ['audit'];

export const listTenantAuditRouteSchema = {
  tags,
  summary: "The tenant's audit log, newest first (filters: action, from, to)",
  querystring: AuditListQuerySchema,
  response: { 200: AuditListResponseSchema, ...COMMON_ERRORS },
};

export const listPlatformAuditRouteSchema = {
  tags,
  summary: 'The platform audit log, newest first (admin host; filters: action, from, to)',
  querystring: AuditListQuerySchema,
  response: { 200: AuditListResponseSchema, ...COMMON_ERRORS },
};

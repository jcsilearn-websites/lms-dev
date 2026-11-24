import { Type } from '@sinclair/typebox';
import {
  COMMON_ERRORS,
  DataExportDownloadSchema,
  DataExportListSchema,
  ErasureAdminListSchema,
  ErasurePreviewSchema,
  ErasureRequestSchema,
  MyErasureSchema,
  RequestDataExportResultSchema,
  RequestDataExportSchema,
  RequestErasureResultSchema,
  RequestErasureSchema,
} from '../../contracts';

const tags = ['privacy'];
export const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

export const requestExportRouteSchema = {
  tags,
  summary:
    'Ask for an archive of my own data in this college. The password is asked again. 202: being prepared (an earlier request still in progress is returned, not repeated)',
  body: RequestDataExportSchema,
  response: { 202: RequestDataExportResultSchema, ...COMMON_ERRORS },
};
export const listExportsRouteSchema = {
  tags,
  summary: 'My data exports (newest first, the last 10)',
  response: { 200: DataExportListSchema, ...COMMON_ERRORS },
};
export const downloadExportRouteSchema = {
  tags,
  summary:
    'A short-lived signed link to my archive (owner only; 409 while it is being prepared or after it expired)',
  params: IdParams,
  response: { 200: DataExportDownloadSchema, ...COMMON_ERRORS },
};

// ------------------------------------------------------------------ erasure inside a college
const erasureTags = ['privacy'];
export const erasurePreviewRouteSchema = {
  tags: erasureTags,
  summary:
    'What erasing me from this college would remove and what it keeps: COUNTS ONLY, the rules (30 days, 7 days) and the request in progress',
  response: { 200: ErasurePreviewSchema, ...COMMON_ERRORS },
};
export const myErasureRouteSchema = {
  tags: erasureTags,
  summary: 'My latest erasure request in this college',
  response: { 200: MyErasureSchema, ...COMMON_ERRORS },
};
export const requestErasureRouteSchema = {
  tags: erasureTags,
  summary:
    'Ask to be erased from this college. The password is asked again. An institution admin (not me) has to approve; 7 days of grace follow the approval',
  body: RequestErasureSchema,
  response: { 202: RequestErasureResultSchema, ...COMMON_ERRORS },
};
export const cancelMyErasureRouteSchema = {
  tags: erasureTags,
  summary: 'Withdraw my request (until the grace period ends)',
  response: { 200: Type.Object({ request: ErasureRequestSchema }), ...COMMON_ERRORS },
};
export const erasureAdminListRouteSchema = {
  tags: erasureTags,
  summary: "The college's erasure requests, open ones first (institution admins)",
  response: { 200: ErasureAdminListSchema, ...COMMON_ERRORS },
};
const decideSchema = (summary: string) => ({
  tags: erasureTags,
  summary,
  params: IdParams,
  response: { 200: Type.Object({ request: ErasureRequestSchema }), ...COMMON_ERRORS },
});
export const approveErasureRouteSchema = decideSchema(
  'Approve a request (never your own): the grace period of 7 days starts',
);
export const rejectErasureRouteSchema = decideSchema('Reject a request');
export const cancelErasureRouteSchema = decideSchema(
  'Cancel a request before its grace period ends',
);

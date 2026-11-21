import { Type } from '@sinclair/typebox';
import {
  COMMON_ERRORS,
  DataExportDownloadSchema,
  DataExportListSchema,
  RequestDataExportResultSchema,
  RequestDataExportSchema,
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

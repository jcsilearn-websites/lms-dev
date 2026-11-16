import {
  COMMON_ERRORS,
  UsageExportQuerySchema,
  UsageQuerySchema,
  UsageResponseSchema,
} from '../../contracts';

const tags = ['platform'];

export const usageRouteSchema = {
  tags,
  summary:
    'Monthly usage of every college for billing (aggregates only): closed months are frozen snapshots, the open month is provisional',
  querystring: UsageQuerySchema,
  response: { 200: UsageResponseSchema, ...COMMON_ERRORS },
};
export const usageExportRouteSchema = {
  tags,
  summary: 'The monthly usage as CSV or XLSX',
  querystring: UsageExportQuerySchema,
  response: { ...COMMON_ERRORS },
};

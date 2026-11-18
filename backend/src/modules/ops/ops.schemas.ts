import { Type } from '@sinclair/typebox';
import { ErrorResponseSchema } from '../../contracts';

export const metricsRouteSchema = {
  tags: ['ops'],
  summary: 'Prometheus metrics (bearer token; 404 when METRICS_TOKEN is not set)',
  response: { 200: Type.String(), 401: ErrorResponseSchema, 404: ErrorResponseSchema },
};

export const cspReportRouteSchema = {
  tags: ['ops'],
  summary: 'Browser CSP violation reports (unauthenticated, strictly rate limited, size limited)',
  body: Type.Unknown(),
  response: { 204: Type.Null(), 400: ErrorResponseSchema, 429: ErrorResponseSchema },
};

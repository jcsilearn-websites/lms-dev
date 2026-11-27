import { Type } from '@sinclair/typebox';
import { ErrorResponseSchema } from '../../contracts';
import { REPORT_KINDS } from '../../contracts/scrub';

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

/** A browser error report (step 14b-2 part D): small, closed, and scrubbed again by the server before anything is logged. */
export const clientErrorRouteSchema = {
  tags: ['ops'],
  summary:
    'Browser error report (unauthenticated, strictly rate limited, 4 KB, scrubbed, never stored)',
  body: Type.Object(
    {
      v: Type.Literal(1),
      kind: Type.Union(REPORT_KINDS.map((k) => Type.Literal(k))),
      message: Type.String({ maxLength: 2000 }),
      stack: Type.Optional(Type.String({ maxLength: 4000 })),
      route: Type.Optional(Type.String({ maxLength: 400 })),
      build: Type.Optional(Type.String({ maxLength: 80 })),
    },
    { additionalProperties: false },
  ),
  response: {
    204: Type.Null(),
    400: ErrorResponseSchema,
    413: ErrorResponseSchema,
    429: ErrorResponseSchema,
  },
};

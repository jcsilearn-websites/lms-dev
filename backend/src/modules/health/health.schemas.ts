import { ErrorResponseSchema, HealthLiveSchema, HealthReadySchema } from '../../contracts';

export const liveRouteSchema = {
  tags: ['health'],
  summary: 'Liveness (no DB)',
  response: { 200: HealthLiveSchema },
};

export const readyRouteSchema = {
  tags: ['health'],
  summary: 'Readiness (checks the database)',
  response: { 200: HealthReadySchema, 503: ErrorResponseSchema },
};

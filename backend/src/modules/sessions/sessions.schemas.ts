import { Type } from '@sinclair/typebox';
import { AckSchema, COMMON_ERRORS, SessionListSchema } from '../../contracts';

const PageQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Type.String({ format: 'uuid' })),
});

export const listSessionsRouteSchema = {
  tags: ['auth'],
  summary: 'My active sessions',
  querystring: PageQuery,
  response: { 200: SessionListSchema, ...COMMON_ERRORS },
};

export const revokeSessionRouteSchema = {
  tags: ['auth'],
  summary: 'Revoke one of my sessions',
  params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
  response: { 200: AckSchema, ...COMMON_ERRORS },
};

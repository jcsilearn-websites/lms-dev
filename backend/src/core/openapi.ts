import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import type { ApiEnv } from '../config/env';

/** OpenAPI docs at /docs, served only outside production. Register before the routes. */
export function registerOpenApi(app: FastifyInstance, env: Pick<ApiEnv, 'NODE_ENV'>): void {
  if (env.NODE_ENV === 'production') return;
  void app.register(swagger, {
    openapi: {
      info: { title: 'JCS iLearn LMS API', version: '0.0.0' },
      tags: [{ name: 'health' }],
    },
  });
  void app.register(swaggerUi, { routePrefix: '/docs' });
}

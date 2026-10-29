import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { ApiEnv } from '../config/env';
import { notFoundHandler } from './error-handler';

/** helmet security headers, CORS restricted by config, and rate limiting (404s included). */
export function registerSecurity(
  app: FastifyInstance,
  env: Pick<ApiEnv, 'CORS_ORIGINS' | 'RATE_LIMIT_MAX' | 'RATE_LIMIT_WINDOW_MS'>,
): void {
  void app.register(helmet);
  void app.register(cors, {
    origin: env.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  });
  void app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    // in-memory store: per instance. Needs a shared store before production (see CLAUDE.md).
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      code: 'FST_ERR_RATE_LIMIT',
      error: 'Too Many Requests',
      message: `Rate limit exceeded, retry in ${context.after}`,
    }),
  });

  // 404s are rate limited too (scanners); the limiter must be loaded before it can be referenced.
  void app.after(() => {
    app.setNotFoundHandler({ preHandler: app.rateLimit() }, notFoundHandler);
  });
}

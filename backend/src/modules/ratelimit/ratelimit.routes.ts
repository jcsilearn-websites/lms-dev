import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

// The shared limiter has no HTTP endpoints.
export function createRateLimitRoutes(): FastifyPluginAsyncTypebox {
  return async () => {};
}

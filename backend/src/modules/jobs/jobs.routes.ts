import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

// URL + method + schemas + route declaration only. The job queue has no HTTP endpoints.
export function createJobsRoutes(): FastifyPluginAsyncTypebox {
  return async () => {};
}

import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';

/**
 * multipart/form-data support for file uploads. Files are STREAMS (never buffered whole): the limit is
 * enforced while the bytes arrive, and an oversized file makes the stream fail with
 * FST_REQ_FILE_TOO_LARGE, which the consumer maps to 413. One file, a few small fields at most.
 */
export function registerUploads(app: FastifyInstance, opts: { maxBytes: number }): void {
  void app.register(multipart, {
    limits: { fileSize: opts.maxBytes, files: 1, fields: 5, parts: 6 },
  });
}

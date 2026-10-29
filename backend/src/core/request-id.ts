import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Accept a well-formed upstream id, otherwise mint a UUIDv7; never trust arbitrary header text. */
export function genReqId(req: { headers: Record<string, string | string[] | undefined> }): string {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : uuidv7();
}

/** Echo the request id on every response. */
export function registerRequestId(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
}

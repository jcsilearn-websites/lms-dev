import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ErrorResponse } from '../contracts';
import { issueReceipt } from './deadline';
import { AppError } from './errors';

const CLIENT_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
};

function body(
  requestId: string,
  code: string,
  message: string,
  details?: ErrorResponse['error']['details'],
): ErrorResponse {
  return { error: { code, message, requestId, ...(details ? { details } : {}) } };
}

/** pg-pool's own error when no connection became free in time (it has no code; the message is stable). */
export function isPoolExhausted(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    if (e instanceof Error && /timeout exceeded when trying to connect/i.test(e.message))
      return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

async function handleError(err: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) request.log.warn({ err }, 'request failed');
    return reply.status(err.statusCode).send(body(request.id, err.code, err.message, err.details));
  }

  if (err.validation) {
    const details = err.validation.map((v) => ({
      path: v.instancePath || '/',
      message: v.message ?? 'invalid value',
    }));
    return reply
      .status(400)
      .send(body(request.id, 'validation_error', 'Request validation failed', details));
  }

  const status = err.statusCode;
  if (status !== undefined && status >= 400 && status < 500) {
    const code = CLIENT_CODES[status] ?? 'bad_request';
    // Fastify/plugin 4xx messages are generic and safe to expose.
    return reply.status(status).send(body(request.id, code, err.message));
  }

  // The database pool had no free connection for `connectionTimeoutMs`: the service is saturated (a deadline burst), not
  // broken. Say so with a Retry-After: the clients retry (every hand-in and save is idempotent), instead of a 500 that looks
  // like a bug and is never retried.
  if (isPoolExhausted(err)) {
    request.log.warn({ err }, 'database pool exhausted');
    // a deadline-sensitive request gets a signed receipt of WHEN it arrived (no database access): the retry sends it back
    const receipt = await issueReceipt(request);
    if (receipt) void reply.header('deadline-receipt', receipt);
    return reply
      .status(503)
      .header('retry-after', '2')
      .send(body(request.id, 'busy', 'The service is busy right now. Try again in a moment.'));
  }

  // Everything else is a bug or an infrastructure failure: log it, never leak it.
  request.log.error({ err }, 'unhandled error');
  return reply.status(500).send(body(request.id, 'internal_error', 'Internal server error'));
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send(body(request.id, 'not_found', 'Route not found'));
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler(handleError);
}

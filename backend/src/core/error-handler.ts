import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ErrorResponse } from '../contracts';
import { issueReceipt } from './deadline';
import { AppError, ServiceBusyError } from './errors';
import { isStorageInfrastructureError } from './storage';
import { StorageUnavailableError } from './storage/storage';

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

/**
 * The database is unreachable or going away (a restart, a failover, too many connections): transient, so the client is told to
 * retry (503 + Retry-After) instead of seeing a 500 that looks like a bug. SQLSTATE class 08 (connection exception), 57P01-57P03
 * (shutdown, crash recovery, cannot connect now), 53300 (too many connections), and the socket errors a dead connection raises.
 */
export function isDatabaseUnavailable(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (/^08/.test(code) || ['57P01', '57P02', '57P03', '53300', '53400'].includes(code))
        return true;
      if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(code))
        return true;
    }
    if (
      e instanceof Error &&
      /Connection terminated|Query read timeout|rollback timed out|terminating connection|the database system is (shutting down|starting up|in recovery)|Client has encountered a connection error|read ECONNRESET|connect ECONNREFUSED/i.test(
        e.message,
      )
    )
      return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
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

/** The guard trigger of migration 0066 raises a check_violation with the constraint name `account_erased`. */
function hitErasedAccount(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if ((cur as { constraint?: unknown }).constraint === 'account_erased') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

async function handleError(err: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) request.log.warn({ err }, 'request failed');
    if (err instanceof ServiceBusyError) {
      void reply.header('retry-after', String(err.retryAfterSeconds));
    }
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

  // A request that was in flight while the person's ACCOUNT was erased (an invite, an accept, a sign-in): the database guard
  // (migration 0066, constraint `account_erased`) refused it. A clean conflict, not a 500.
  if (hitErasedAccount(err)) {
    return reply
      .status(409)
      .send(
        body(request.id, 'account_erased', 'This account was erased and can no longer be used.'),
      );
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

  if (isDatabaseUnavailable(err)) {
    request.log.warn({ err }, 'database unavailable');
    return reply
      .status(503)
      .header('retry-after', '2')
      .send(
        body(
          request.id,
          'database_unavailable',
          'The service is temporarily unavailable. Try again shortly.',
        ),
      );
  }

  // Storage that is unwell (disk full, I/O error, a deadline): a clean, retryable 503, not a 500.
  if (err instanceof StorageUnavailableError || isStorageInfrastructureError(err)) {
    request.log.warn({ err }, 'storage unavailable');
    return reply
      .status(503)
      .header('retry-after', '5')
      .send(
        body(
          request.id,
          'storage_unavailable',
          'File storage is not available right now. Try again shortly.',
        ),
      );
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

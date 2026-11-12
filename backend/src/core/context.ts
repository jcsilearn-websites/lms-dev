import type { FastifyRequest } from 'fastify';
import type { MembershipRole } from './auth-context';
import { UnauthorizedError } from './errors';

/** What services receive instead of the request: explicit, serializable, no framework types. */
export interface RequestContext {
  userId: string;
  tenantId: string | null;
  role: MembershipRole | null;
  isPlatformAdmin: boolean;
  sessionId: string;
  email: string;
  displayName: string;
  ip: string | null;
  userAgent: string | null;
  /**
   * When the request reached the server (taken before it waited for a database connection) or, with a valid receipt, when the
   * refused first attempt did. The deadline-sensitive calls pass it to the database (core/deadline.ts).
   */
  arrival?: { atMs: number; maxAgeSeconds: number };
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export function clientInfo(request: FastifyRequest): ClientInfo {
  const ua = request.headers['user-agent'];
  return { ip: request.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null };
}

export function contextFrom(request: FastifyRequest): RequestContext {
  const a = request.auth;
  if (!a) throw new UnauthorizedError();
  return {
    userId: a.userId,
    tenantId: a.tenantId,
    role: a.membershipRole,
    isPlatformAdmin: a.isPlatformAdmin,
    sessionId: a.sessionId,
    email: a.email,
    displayName: a.displayName,
    ...clientInfo(request),
    ...(request.arrival
      ? { arrival: { atMs: request.arrival.atMs, maxAgeSeconds: request.arrival.maxAgeSeconds } }
      : {}),
  };
}

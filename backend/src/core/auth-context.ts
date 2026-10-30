import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { NotFoundError } from './errors';
import { type HostInfo, parseHost } from './host';
import { bindTenantToLog } from './tenant-log';
import { hashToken } from './tokens';
import type { TtlCache } from './video/ttl-cache';

export type MembershipRole = 'institution_admin' | 'member';

/** Who is making the request. null on the request = unauthenticated. */
export interface AuthContext {
  sessionId: string;
  userId: string;
  /** null for platform-admin sessions (admin.<domain>). */
  tenantId: string | null;
  membershipRole: MembershipRole | null;
  isPlatformAdmin: boolean;
  email: string;
  displayName: string;
}

export interface ResolvedTenant {
  id: string;
  slug: string;
  status: string;
}

/** Implemented by the tenants module (with a TTL cache); injected by the composition root. */
export interface TenantResolver {
  resolveBySlug(slug: string): Promise<ResolvedTenant | null>;
}

/** Implemented by the sessions module: one indexed query joined with the membership role. */
export interface SessionResolver {
  lookup(tokenHash: Buffer, tenantId: string | null): Promise<AuthContext | null>;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    hostInfo: HostInfo;
    tenant: ResolvedTenant | null;
  }
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Reads one cookie from the raw header (this hook runs before the cookie plugin parses it). */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  return cookie.parse(header)[name];
}

/**
 * Resolves tenant (from the Host subdomain) and session (from the cookie) for every request and
 * exposes `request.auth` / `request.tenant`. A session only counts on the tenant host it was
 * issued for; unknown or suspended tenants answer 404 with the standard error shape.
 */
export function registerAuthContext(
  app: FastifyInstance,
  deps: {
    baseDomain: string;
    cookieName: string;
    tenantResolver: TenantResolver;
    sessionResolver: SessionResolver;
    /**
     * Optional: for URLs where `keyOf(url)` is non-null (the video segment requests, one every few seconds per
     * viewer) a successful session lookup is remembered per (session, key) for the cache's TTL, so those
     * requests do not each query the database. A session revoked meanwhile keeps working on those URLs for at most
     * that TTL (VIDEO_SESSION_CACHE_TTL_SECONDS); every other URL is checked on every request as always.
     */
    cachedSessions?: { cache: TtlCache<AuthContext>; keyOf(url: string): string | null };
  },
): void {
  void app.register(cookie);
  app.decorateRequest('auth', null);
  app.decorateRequest('tenant', null);
  app.decorateRequest('hostInfo', null as never);

  app.addHook('onRequest', async (request) => {
    request.hostInfo = parseHost(request.host, deps.baseDomain);
    const info = request.hostInfo;
    // probes and non-tenant hosts carry no tenant/session context
    if (info.kind === 'none' || /^(\/api)?\/health(\/|\?|$)/.test(request.url)) return;

    if (info.kind === 'tenant') {
      const tenant = await deps.tenantResolver.resolveBySlug(info.slug);
      if (tenant?.status !== 'active') {
        throw new NotFoundError('tenant_not_found', 'Tenant not found');
      }
      request.tenant = tenant;
      bindTenantToLog(request, tenant.id);
    }

    const token = readCookie(request.headers.cookie, deps.cookieName);
    if (!token || !TOKEN_SHAPE.test(token)) return;
    const tokenHash = hashToken(token);
    const urlKey = deps.cachedSessions?.keyOf(request.url) ?? null;
    const cacheKey = urlKey
      ? `${tokenHash.toString('hex')}|${request.tenant?.id ?? ''}|${urlKey}`
      : null;
    let auth = cacheKey ? deps.cachedSessions?.cache.get(cacheKey) : undefined;
    if (!auth) {
      auth =
        (await deps.sessionResolver.lookup(tokenHash, request.tenant?.id ?? null)) ?? undefined;
      if (auth && cacheKey) deps.cachedSessions?.cache.set(cacheKey, auth);
    }
    if (auth) {
      request.auth = auth;
      request.log = request.log.child({ user_id: auth.userId });
    }
  });
}

export function sessionCookieToken(
  request: FastifyRequest,
  cookieName: string,
): string | undefined {
  return readCookie(request.headers.cookie, cookieName);
}

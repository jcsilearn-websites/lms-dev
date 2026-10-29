import type { AuthContext } from '../../core/auth-context';
import type { RequestContext } from '../../core/context';
import { buildPage, normalizePage, type Page, type PageRequest } from '../../core/pagination';
import { generateToken, hashToken } from '../../core/tokens';
import { newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import { SessionNotFoundError } from './sessions.errors';
import type { SessionsRepository } from './sessions.repository';

export interface SessionsConfig {
  idleSeconds: number;
  absoluteSeconds: number;
  /** last_seen_at / idle expiry are refreshed at most this often (avoids a write per request). */
  touchSeconds: number;
}

export interface SessionSummary {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface CompletedLogin {
  /** The raw cookie token. Returned once, never stored (only its SHA-256 is). */
  token: string;
  sessionId: string;
  expiresAt: Date;
  email: string;
  displayName: string;
  role: 'institution_admin' | 'member' | null;
}

export function createSessionsService(deps: {
  db: Pick<Database, 'withTenant' | 'withUser' | 'withoutTenant'>;
  sessionsRepo: SessionsRepository;
  config: SessionsConfig;
}) {
  const { db, sessionsRepo, config } = deps;

  /** Runs in the session owner's context: tenant + user for tenant sessions, user only for platform ones. */
  function asOwner<T>(
    tenantId: string | null,
    userId: string,
    fn: Parameters<Database['withUser']>[1] extends (tx: infer E) => Promise<unknown>
      ? (tx: E) => Promise<T>
      : never,
  ): Promise<T> {
    return tenantId ? db.withTenant(tenantId, fn, { userId }) : db.withUser(userId, fn);
  }

  return {
    /**
     * Login step 2 in ONE statement (see lms.auth_login_complete): validates membership/tenant again,
     * clears failed attempts, creates a brand-new session (a fresh random token every time: login
     * always rotates) and audits the login. null = the account may no longer log in here.
     */
    async completeLogin(input: {
      userId: string;
      tenantId: string | null;
      ip: string | null;
      userAgent: string | null;
    }): Promise<CompletedLogin | null> {
      const token = await generateToken();
      const sessionId = newId();
      const row = await db.withoutTenant((exec) =>
        sessionsRepo.loginComplete(exec, {
          userId: input.userId,
          tenantId: input.tenantId,
          sessionId,
          tokenHash: hashToken(token),
          idleSeconds: config.idleSeconds,
          absoluteSeconds: config.absoluteSeconds,
          ip: input.ip,
          userAgent: input.userAgent,
          auditId: newId(),
        }),
      );
      if (row?.r_status !== 'ok' || !row.r_expires_at) return null;
      return {
        token,
        sessionId,
        expiresAt: new Date(row.r_expires_at),
        email: row.r_email ?? '',
        displayName: row.r_display_name ?? '',
        role: row.r_role,
      };
    },

    /** Per-request lookup (one indexed query). null = not authenticated for this tenant host. */
    async lookup(tokenHash: Buffer, tenantId: string | null): Promise<AuthContext | null> {
      const row = await db.withoutTenant((exec) =>
        sessionsRepo.lookup(exec, {
          tokenHash,
          tenantId,
          touchSeconds: config.touchSeconds,
          idleSeconds: config.idleSeconds,
        }),
      );
      if (!row) return null;
      return {
        sessionId: row.session_id,
        userId: row.user_id,
        tenantId: row.tenant_id,
        membershipRole: row.membership_role,
        isPlatformAdmin: row.is_platform_admin,
        email: row.email,
        displayName: row.display_name,
      };
    },

    async listMine(ctx: RequestContext, request?: PageRequest): Promise<Page<SessionSummary>> {
      const { limit, after } = normalizePage(request);
      const rows = await asOwner(ctx.tenantId, ctx.userId, (tx) =>
        sessionsRepo.listMine(tx, { limit: limit + 1, after }),
      );
      const page = buildPage(rows, limit);
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((s) => ({ ...s, current: s.id === ctx.sessionId })),
      };
    },

    /** Revokes one of the caller's own sessions; other users' sessions are invisible (RLS) -> 404. */
    async revokeMine(ctx: RequestContext, sessionId: string): Promise<void> {
      const revoked = await asOwner(ctx.tenantId, ctx.userId, (tx) =>
        sessionsRepo.revoke(tx, sessionId),
      );
      if (!revoked) throw new SessionNotFoundError();
    },

    /** Logout: revokes the caller's current session and audits it, in one statement. */
    async logout(ctx: RequestContext): Promise<void> {
      await db.withoutTenant((exec) =>
        sessionsRepo.logout(exec, {
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          tenantId: ctx.tenantId,
          ip: ctx.ip,
          auditId: newId(),
        }),
      );
    },

    /**
     * Deletes sessions that died (revoked / idle-expired / absolute-expired) more than
     * `retentionDays` ago, in bounded batches, until a batch comes back short or `maxBatches` is hit.
     */
    async purgeDead(opts: {
      retentionDays: number;
      batchSize: number;
      maxBatches?: number;
    }): Promise<number> {
      let total = 0;
      for (let i = 0; i < (opts.maxBatches ?? 100); i++) {
        const n = await db.withoutTenant((exec) =>
          sessionsRepo.purge(exec, opts.retentionDays, opts.batchSize),
        );
        total += n;
        if (n < opts.batchSize) break;
      }
      return total;
    },

    /**
     * Revokes every live session of a user (optionally keeping one, optionally only in one tenant).
     * Used on password change/reset and on role changes. SECURITY DEFINER under the hood: the
     * caller is responsible for authorization.
     */
    revokeAllForUser(
      userId: string,
      opts: { exceptSessionId?: string; tenantId?: string } = {},
    ): Promise<number> {
      return db.withoutTenant((exec) =>
        sessionsRepo.revokeUserSessions(exec, {
          userId,
          exceptSessionId: opts.exceptSessionId ?? null,
          tenantId: opts.tenantId ?? null,
        }),
      );
    },
  };
}
export type SessionsService = ReturnType<typeof createSessionsService>;

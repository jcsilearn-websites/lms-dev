import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { sessions } from './sessions.model';

const listColumns = {
  id: sessions.id,
  createdAt: sessions.createdAt,
  lastSeenAt: sessions.lastSeenAt,
  ip: sessions.ip,
  userAgent: sessions.userAgent,
};

export interface SessionLookupRow {
  session_id: string;
  user_id: string;
  tenant_id: string | null;
  membership_role: 'institution_admin' | 'member' | null;
  is_platform_admin: boolean;
  email: string;
  display_name: string;
}

export interface LoginCompleteRow {
  r_status: 'ok' | 'denied';
  r_email: string | null;
  r_display_name: string | null;
  r_role: 'institution_admin' | 'member' | null;
  r_expires_at: Date | string | null;
}

export function createSessionsRepository() {
  return {
    /** The caller's own live sessions, newest first; keyset over id, `limit` = rows to fetch. */
    listMine(tx: Executor, page: { limit: number; after?: string | undefined }) {
      const live = and(isNull(sessions.revokedAt), sql`${sessions.idleExpiresAt} > now()`);
      return tx
        .select(listColumns)
        .from(sessions)
        .where(page.after ? and(live, lt(sessions.id, page.after)) : live)
        .orderBy(desc(sessions.id))
        .limit(page.limit);
    },

    async revoke(tx: Executor, id: string): Promise<boolean> {
      const rows = await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      return rows.length > 0;
    },

    /**
     * Pre-tenant session lookup: ONE statement through the SECURITY DEFINER function, which joins the
     * user and membership, enforces expiry/revocation/tenant/status and bumps last_seen at most
     * once per `touchSeconds`.
     */
    async lookup(
      db: Executor,
      args: {
        tokenHash: Buffer;
        tenantId: string | null;
        touchSeconds: number;
        idleSeconds: number;
      },
    ): Promise<SessionLookupRow | undefined> {
      const result = await db.execute(
        sql`select * from lms.auth_lookup_session(${args.tokenHash}::bytea, ${args.tenantId}::uuid, ${args.touchSeconds}::int, ${args.idleSeconds}::int)`,
      );
      return result.rows[0] as SessionLookupRow | undefined;
    },

    /**
     * Login step 2, ONE statement: re-validates membership/tenant status, clears failed attempts,
     * creates the session and writes the audit entry. The token itself never reaches the database,
     * only its SHA-256.
     */
    async loginComplete(
      db: Executor,
      a: {
        userId: string;
        tenantId: string | null;
        sessionId: string;
        tokenHash: Buffer;
        idleSeconds: number;
        absoluteSeconds: number;
        ip: string | null;
        userAgent: string | null;
        auditId: string;
      },
    ): Promise<LoginCompleteRow | undefined> {
      const res = await db.execute(
        sql`select * from lms.auth_login_complete(${a.userId}::uuid, ${a.tenantId}::uuid, ${a.sessionId}::uuid, ${a.tokenHash}::bytea, ${a.idleSeconds}::int, ${a.absoluteSeconds}::int, ${a.ip}::inet, ${a.userAgent}::text, ${a.auditId}::uuid)`,
      );
      return res.rows[0] as LoginCompleteRow | undefined;
    },

    /** Revokes the caller's own session and audits it, ONE statement. false = not theirs/already revoked. */
    async logout(
      db: Executor,
      a: {
        sessionId: string;
        userId: string;
        tenantId: string | null;
        ip: string | null;
        auditId: string;
      },
    ): Promise<boolean> {
      const res = await db.execute(
        sql`select lms.auth_logout(${a.sessionId}::uuid, ${a.userId}::uuid, ${a.tenantId}::uuid, ${a.ip}::inet, ${a.auditId}::uuid) as revoked`,
      );
      return (res.rows[0] as { revoked: boolean }).revoked;
    },

    /** Bounded purge of dead sessions older than the retention period; returns rows deleted. */
    async purge(db: Executor, retentionDays: number, batch: number): Promise<number> {
      const res = await db.execute(
        sql`select lms.auth_purge_sessions(${retentionDays}::int, ${batch}::int) as n`,
      );
      return Number((res.rows[0] as { n: number }).n);
    },

    async revokeUserSessions(
      db: Executor,
      args: { userId: string; exceptSessionId: string | null; tenantId: string | null },
    ): Promise<number> {
      const result = await db.execute(
        sql`select lms.auth_revoke_user_sessions(${args.userId}::uuid, ${args.exceptSessionId}::uuid, ${args.tenantId}::uuid) as count`,
      );
      return Number((result.rows[0] as { count: number }).count);
    },
  };
}
export type SessionsRepository = ReturnType<typeof createSessionsRepository>;

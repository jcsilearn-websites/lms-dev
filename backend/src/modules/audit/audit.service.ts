import { can } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { BadRequestError, ForbiddenError } from '../../core/errors';
import { buildTimePage, normalizeTimePage, type Page } from '../../core/pagination';
import { newId } from '../../core/uuid';
import type { Database, Executor } from '../../db/client';
import { InvalidAuditEntryError } from './audit.errors';
import type { AuditListRow, AuditRepository } from './audit.repository';

export interface AuditEntryInput {
  /** null/undefined = system (worker) action. */
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditEntry {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: unknown;
  createdAt: Date;
  /** Who did it: null only for system actions (no actor). */
  actorName: string | null;
  actorEmail: string | null;
}

export interface AuditListInput {
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
  after?: string | undefined;
}

function toEntry(r: AuditListRow): AuditEntry {
  return {
    id: r.id,
    actorUserId: r.actorUserId,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    metadata: r.metadata,
    createdAt: r.createdAt,
    ...actorOf(r),
  };
}

/**
 * The actor as shown to people. No actor = a system action (null). An actor who cannot be read any more
 * (removed from the college, or deleted) is "Unknown user"; a platform administrator acting inside a
 * college is not a member there, so the entry's own flag names them.
 */
function actorOf(r: AuditListRow): { actorName: string | null; actorEmail: string | null } {
  if (r.actorUserId === null) return { actorName: null, actorEmail: null };
  if (r.actorName) return { actorName: r.actorName, actorEmail: r.actorEmail };
  return {
    actorName: r.metadata.viaPlatformAdmin === true ? 'Platform administrator' : 'Unknown user',
    actorEmail: null,
  };
}

/** Validates the date range and the cursor, then returns the repository filter (fetching limit + 1). */
function toFilter(input: AuditListInput) {
  for (const v of [input.from, input.to]) {
    if (v !== undefined && Number.isNaN(Date.parse(v))) {
      throw new BadRequestError('invalid_date', 'from/to must be ISO-8601 timestamps');
    }
  }
  if (
    input.from !== undefined &&
    input.to !== undefined &&
    Date.parse(input.from) >= Date.parse(input.to)
  ) {
    throw new BadRequestError('invalid_date_range', '"from" must be earlier than "to"');
  }
  const { limit, after } = normalizeTimePage(input);
  return {
    limit,
    filter: { limit: limit + 1, after, action: input.action, from: input.from, to: input.to },
  };
}

export function createAuditService(deps: {
  db: Pick<Database, 'withTenant' | 'withoutTenant'>;
  auditRepo: AuditRepository;
}) {
  const { db, auditRepo } = deps;
  function assertAction(action: string): void {
    if (action.length < 1 || action.length > 100) {
      throw new InvalidAuditEntryError('action must be 1-100 characters');
    }
  }

  return {
    /** Tenant-less audit event (platform-admin host logins, lockouts, unlocks, ...). */
    async recordPlatform(entry: AuditEntryInput & { ip?: string | null }): Promise<void> {
      assertAction(entry.action);
      await db.withoutTenant((exec) =>
        auditRepo.insertPlatform(exec, {
          id: newId(),
          actorUserId: entry.actorUserId ?? null,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId ?? null,
          metadata: entry.metadata ?? {},
          ip: entry.ip ?? null,
        }),
      );
    },

    /**
     * Runs `fn` inside a tenant transaction on behalf of a PLATFORM ADMIN (who is not a member of
     * the tenant) and writes the audit_log entry in the SAME transaction, so access can never go
     * unrecorded. Writes the tenant's audit_log AND the platform_audit_log.
     */
    async withPlatformAdminAccess<T>(
      actor: { userId: string; isPlatformAdmin: boolean },
      tenantId: string,
      entry: {
        action: string;
        targetType: string;
        targetId?: string | null;
        metadata?: Record<string, unknown>;
        ip?: string | null;
      },
      fn: (tx: Executor) => Promise<T>,
    ): Promise<T> {
      if (!actor.isPlatformAdmin) throw new ForbiddenError();
      assertAction(entry.action);
      return db.withTenant(
        tenantId,
        async (tx) => {
          const id = newId();
          const metadata = { ...(entry.metadata ?? {}), platformAdmin: true };
          // BOTH logs, in the transaction of the access itself: it cannot happen unrecorded.
          await auditRepo.insert(tx, {
            id,
            tenantId,
            actorUserId: actor.userId,
            action: entry.action,
            targetType: entry.targetType,
            targetId: entry.targetId ?? null,
            metadata,
          });
          await auditRepo.insertPlatform(tx, {
            id,
            actorUserId: actor.userId,
            action: entry.action,
            targetType: entry.targetType,
            targetId: entry.targetId ?? null,
            metadata: { ...metadata, tenantId },
            ip: entry.ip ?? null,
          });
          return fn(tx);
        },
        { userId: actor.userId },
      );
    },

    async record(tenantId: string, entry: AuditEntryInput): Promise<void> {
      assertAction(entry.action);
      await db.withTenant(tenantId, (tx) =>
        auditRepo.insert(tx, {
          id: newId(),
          tenantId,
          actorUserId: entry.actorUserId ?? null,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId ?? null,
          metadata: entry.metadata ?? {},
        }),
      );
    },

    /** GET /audit: the tenant's own log (permission audit.read), newest first. */
    async listTenantLog(
      ctx: RequestContext,
      input: AuditListInput,
    ): Promise<Page<AuditEntry & { cursorAt: string }>> {
      if (!ctx.tenantId || !can(ctx, 'audit.read')) throw new ForbiddenError();
      const { limit, filter } = toFilter(input);
      const tenantId = ctx.tenantId;
      const rows = await db.withTenant(tenantId, (tx) =>
        auditRepo.listTenant(tx, tenantId, filter),
      );
      return buildTimePage(
        rows.map((r) => ({ ...toEntry(r), cursorAt: r.cursorAt })),
        limit,
        (r) => ({ createdAt: r.cursorAt, id: r.id }),
      );
    },

    /** GET /platform/audit: the platform log (permission platform.audit.read), admin host only. */
    async listPlatformLog(
      ctx: RequestContext,
      input: AuditListInput,
    ): Promise<Page<AuditEntry & { cursorAt: string }>> {
      if (ctx.tenantId !== null || !can(ctx, 'platform.audit.read')) throw new ForbiddenError();
      const { limit, filter } = toFilter(input);
      const rows = await db.withoutTenant((exec) =>
        auditRepo.listPlatform(exec, ctx.userId, filter),
      );
      return buildTimePage(
        rows.map((r) => ({ ...toEntry(r), cursorAt: r.cursorAt })),
        limit,
        (r) => ({ createdAt: r.cursorAt, id: r.id }),
      );
    },
  };
}
export type AuditService = ReturnType<typeof createAuditService>;

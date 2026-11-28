import type { MfaResetItem, MfaResetRequest } from '../../contracts';
import { can } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { ForbiddenError } from '../../core/errors';
import { normalizePage, type Page, type PageRequest } from '../../core/pagination';
import type { Database } from '../../db/client';
import {
  MfaResetAccountNotFoundError,
  MfaResetConflictError,
  MfaResetNotFoundError,
} from './auth.errors';
import type { MfaResetOutcome, MfaResetRepository } from './auth.mfa-reset.repository';

// RESET OF A LOST SECOND FACTOR (step 14c part 2, docs/adr/0026-mfa.md): platform administrators only, the filer, the approver and
// the person are three different people (the database enforces it), executed by the worker 24 hours after the approval. The database
// decides everything; this service maps its verdicts.

export function createMfaResetService(deps: {
  db: Pick<Database, 'withoutTenant'>;
  resetRepo: MfaResetRepository;
  /** every time decision uses this clock (tests pass explicit instants) */
  now?: () => Date;
}) {
  const { db, resetRepo } = deps;
  const now = deps.now ?? (() => new Date());

  /** Admin host only, with the platform permission. */
  function platformAdmin(ctx: RequestContext): string {
    if (ctx.tenantId !== null || !can(ctx, 'platform.mfa_reset.manage')) throw new ForbiddenError();
    return ctx.userId;
  }

  function requestOf(r: MfaResetOutcome): MfaResetRequest {
    switch (r.result) {
      case 'ok':
        return r.request as MfaResetRequest;
      case 'not_found':
        throw new MfaResetNotFoundError();
      case 'self':
        throw new MfaResetConflictError('mfa_reset_self');
      case 'self_approval':
        throw new MfaResetConflictError('mfa_reset_self_approval');
      case 'not_enrolled':
        throw new MfaResetConflictError('mfa_not_enrolled');
      case 'in_progress':
        throw new MfaResetConflictError('mfa_reset_in_progress');
      case 'not_pending':
        throw new MfaResetConflictError('mfa_reset_not_pending');
      case 'expired':
        throw new MfaResetConflictError('mfa_reset_expired');
      case 'too_late':
        throw new MfaResetConflictError('mfa_reset_too_late');
    }
  }

  return {
    async list(ctx: RequestContext, page?: PageRequest): Promise<Page<MfaResetItem>> {
      const actor = platformAdmin(ctx);
      const { limit, after } = normalizePage(page);
      const r = await db.withoutTenant((exec) =>
        resetRepo.list(exec, { actor, limit, after: after ?? null }),
      );
      const last = r.items[r.items.length - 1];
      return { items: r.items, nextCursor: r.hasMore && last ? last.id : null };
    },

    async file(ctx: RequestContext, email: string): Promise<MfaResetRequest> {
      const actor = platformAdmin(ctx);
      const r = await db.withoutTenant((exec) =>
        resetRepo.file(exec, { actor, email, ip: ctx.ip, now: now() }),
      );
      if (r.result === 'not_found') throw new MfaResetAccountNotFoundError();
      return requestOf(r);
    },

    async decide(
      ctx: RequestContext,
      id: string,
      action: 'approve' | 'reject' | 'cancel',
    ): Promise<MfaResetRequest> {
      const actor = platformAdmin(ctx);
      return requestOf(
        await db.withoutTenant((exec) =>
          resetRepo.decide(exec, { actor, id, action, ip: ctx.ip, now: now() }),
        ),
      );
    },

    /**
     * The scheduled run (worker): undecided requests expire, approved ones whose 24 hours are over are executed, one
     * transaction each. One that fails does not stop the others; the job is retried for it.
     */
    async run(limit = 100): Promise<{ expired: number; executed: number; cancelled: number }> {
      const at = now();
      const expired = await db.withoutTenant((exec) => resetRepo.expire(exec, at, limit));
      const due = await db.withoutTenant((exec) => resetRepo.due(exec, at, limit));
      let executed = 0;
      let cancelled = 0;
      let failure: unknown;
      for (const id of due) {
        try {
          const result = await db.withoutTenant((exec) => resetRepo.execute(exec, id, at));
          if (result === 'ok') executed++;
          else if (result === 'cancelled') cancelled++;
        } catch (err) {
          failure = err;
        }
      }
      if (failure) throw failure;
      return { expired, executed, cancelled };
    },
  };
}
export type MfaResetService = ReturnType<typeof createMfaResetService>;

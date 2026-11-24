import { ERASURE_RULES, type ErasurePreview, type ErasureRequest } from '../../contracts';
import { can } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import type { ErasureLedger } from '../../core/erasure-ledger';
import { ConflictError, ForbiddenError, NotFoundError } from '../../core/errors';
import type { AddressHasher } from '../../core/keyed-hash';
import type { Database } from '../../db/client';
import type { AdminRow, ErasureRepository, RequestRow } from './privacy.erasure.repository';
import { NotAnActiveMemberError } from './privacy.errors';

const toDto = (r: RequestRow): ErasureRequest => ({ ...r });

class LastAdminError extends ConflictError {
  constructor() {
    super(
      'last_admin',
      'A college must keep at least one active institution admin. Make someone else an admin first.',
    );
  }
}

/**
 * Erasure inside a college (data protection, step 14b-1 part 3). The member re-enters their password and asks; ANOTHER institution
 * admin approves; 7 days of grace; either side can cancel until then; an undecided request expires after 30 days. The worker executes
 * what is due in ONE database call per request (migration 0064), then writes the ledger entry (ids only) outside the database.
 */
export function createErasureService(deps: {
  db: Pick<Database, 'withTenant' | 'withoutTenant'>;
  erasureRepo: ErasureRepository;
  passwords: { confirm(ctx: RequestContext, password: string): Promise<void> };
  hasher: AddressHasher;
  ledger: ErasureLedger;
  now?: () => Date;
}) {
  const { db, erasureRepo, passwords, hasher, ledger } = deps;
  const now = deps.now ?? (() => new Date());

  const member = (ctx: RequestContext): { tenantId: string; userId: string } => {
    if (!ctx.tenantId || ctx.isPlatformAdmin) throw new NotAnActiveMemberError();
    return { tenantId: ctx.tenantId, userId: ctx.userId };
  };
  const approver = (ctx: RequestContext): string => {
    if (!ctx.tenantId || !can(ctx, 'privacy.erasure.approve')) throw new ForbiddenError();
    return ctx.tenantId;
  };

  const asRequest = (j: unknown): ErasureRequest | null => (j ? (j as ErasureRequest) : null);

  async function decide(
    ctx: RequestContext,
    tenantId: string,
    id: string,
    action: 'approve' | 'reject' | 'cancel',
  ): Promise<{ request: ErasureRequest }> {
    const r = await db.withoutTenant((exec) =>
      erasureRepo.decide(exec, { tenantId, id, actor: ctx.userId, action, now: now(), ip: ctx.ip }),
    );
    switch (r.result) {
      case 'ok':
        return { request: r.request as ErasureRequest };
      case 'not_found':
        throw new NotFoundError('erasure_request_not_found', 'This request does not exist');
      case 'self_approval':
        throw new ConflictError(
          'self_approval_not_allowed',
          'Another administrator has to decide on your own request.',
        );
      case 'last_admin':
        throw new LastAdminError();
      case 'expired':
        throw new ConflictError('erasure_request_expired', 'This request has expired.');
      case 'too_late':
        throw new ConflictError(
          'erasure_too_late',
          'The grace period is over: the erasure can no longer be cancelled.',
        );
      default:
        throw new ConflictError('erasure_request_not_pending', 'This request was already decided.');
    }
  }

  return {
    /** GET /me/erasure/preview: COUNTS ONLY, the rules, and the request in progress (one statement) */
    async preview(ctx: RequestContext): Promise<ErasurePreview> {
      const { tenantId, userId } = member(ctx);
      const p = await db.withoutTenant((exec) => erasureRepo.preview(exec, tenantId, userId));
      if (p.result === 'not_a_member') throw new NotAnActiveMemberError();
      return {
        lastAdmin: p.lastAdmin as boolean,
        erased: p.erased as Record<string, number>,
        kept: p.kept as Record<string, number>,
        open: asRequest(p.open),
        rules: { ...ERASURE_RULES },
      };
    },

    /** GET /me/erasure */
    async mine(ctx: RequestContext): Promise<{ request: ErasureRequest | null }> {
      const { tenantId, userId } = member(ctx);
      const r = await db.withoutTenant((exec) => erasureRepo.mine(exec, tenantId, userId));
      return { request: asRequest(r.request) };
    },

    /** POST /me/erasure: the password is asked again BEFORE anything is written */
    async requestErasure(
      ctx: RequestContext,
      input: { password: string },
    ): Promise<{ request: ErasureRequest; alreadyInProgress: boolean }> {
      const { tenantId, userId } = member(ctx);
      await passwords.confirm(ctx, input.password);
      const r = await db.withoutTenant((exec) =>
        erasureRepo.request(exec, { tenantId, userId, ip: ctx.ip, now: now() }),
      );
      if (r.result === 'not_a_member') throw new NotAnActiveMemberError();
      if (r.result === 'last_admin') throw new LastAdminError();
      return {
        request: r.request as ErasureRequest,
        alreadyInProgress: r.result === 'in_progress',
      };
    },

    /** POST /me/erasure/cancel: the member withdraws (until the grace period ends) */
    async cancelMine(ctx: RequestContext): Promise<{ request: ErasureRequest }> {
      const { tenantId, userId } = member(ctx);
      const mine = asRequest(
        (await db.withoutTenant((exec) => erasureRepo.mine(exec, tenantId, userId))).request,
      );
      if (!mine || !['pending_approval', 'approved'].includes(mine.status)) {
        throw new NotFoundError('erasure_request_not_found', 'You have no open request');
      }
      return decide(ctx, tenantId, mine.id, 'cancel');
    },

    /** GET /privacy/erasure-requests (institution admins) */
    async adminList(
      ctx: RequestContext,
    ): Promise<{ items: (ErasureRequest & { memberName: string; memberEmail: string })[] }> {
      const tenantId = approver(ctx);
      const rows: AdminRow[] = await db.withTenant(tenantId, (tx) =>
        erasureRepo.adminList(tx, 100),
      );
      return {
        items: rows.map((r) => ({
          ...toDto(r),
          memberName: r.memberName,
          memberEmail: r.memberEmail,
        })),
      };
    },

    /** approve | reject | cancel by an administrator */
    async decide(ctx: RequestContext, id: string, action: 'approve' | 'reject' | 'cancel') {
      return decide(ctx, approver(ctx), id, action);
    },

    // ------------------------------------------------------------------ the worker
    /**
     * One scan: expire undecided requests (the member is told by the database function), execute what is due, write the ledger
     * entries that are still to write. Every step is safe to repeat.
     */
    async scan(): Promise<{ expired: number; erased: number; blocked: number; ledger: number }> {
      const expired = await db.withoutTenant((exec) => erasureRepo.expire(exec, now(), 200));
      let erased = 0;
      let blocked = 0;
      const due = await db.withoutTenant((exec) => erasureRepo.due(exec, now(), 50));
      for (const d of due) {
        const prep = await db.withoutTenant((exec) =>
          erasureRepo.prepare(exec, d.tenantId, d.id, now()),
        );
        if (prep.result !== 'ok') continue;
        const address = prep.email as string;
        const { kid, hash } = hasher.hash(address);
        const r = await db.withoutTenant((exec) =>
          erasureRepo.execute(exec, {
            tenantId: d.tenantId,
            id: d.id,
            now: now(),
            email: address,
            hash,
            kid,
          }),
        );
        if (r.result === 'ok') erased += 1;
        else if (r.result === 'blocked') blocked += 1;
      }
      return { expired, erased, blocked, ledger: await this.writeLedger() };
    },

    /** Appends the ledger entries of executed erasures (ids only) outside the database, then records that it was done. */
    async writeLedger(): Promise<number> {
      const pending = await db.withoutTenant((exec) => erasureRepo.ledgerPending(exec, 200));
      const done: string[] = [];
      for (const p of pending) {
        try {
          await ledger.append({
            v: 1,
            requestId: p.requestId,
            tenantId: p.tenantId,
            membershipId: p.membershipId,
            userId: p.userId,
            level: 'college',
            at: p.at,
          });
          done.push(p.requestId);
        } catch {
          // the ledger is unwell: the entry stays pending and the next scan writes it (never lost, never "done" without being written)
        }
      }
      if (done.length > 0)
        await db.withoutTenant((exec) => erasureRepo.ledgerDone(exec, done, now()));
      return done.length;
    },

    /**
     * After a RESTORE of an older backup (`pnpm privacy:reapply-erasures`): every person in the ledger is erased again. Idempotent:
     * a person who is already erased is skipped, one the restored database does not know is "nothing to do".
     */
    async reapplyFromLedger(): Promise<{
      entries: number;
      reapplied: number;
      already: number;
      nothing: number;
    }> {
      const entries = await ledger.readAll();
      let reapplied = 0;
      let already = 0;
      let nothing = 0;
      for (const e of entries) {
        const prep = await db.withoutTenant((exec) =>
          erasureRepo.reapplyPrepare(exec, {
            tenantId: e.tenantId,
            membershipId: e.membershipId,
            userId: e.userId,
          }),
        );
        if (prep.result === 'already') {
          already += 1;
          continue;
        }
        if (prep.result !== 'ok') {
          nothing += 1;
          continue;
        }
        const address = prep.email as string;
        const { kid, hash } = hasher.hash(address);
        const r = await db.withoutTenant((exec) =>
          erasureRepo.reapply(exec, {
            tenantId: e.tenantId,
            membershipId: e.membershipId,
            userId: e.userId,
            requestId: e.requestId,
            at: e.at,
            now: now(),
            email: address,
            hash,
            kid,
          }),
        );
        if (r.result === 'ok') reapplied += 1;
        else if (r.result === 'already') already += 1;
        else nothing += 1;
      }
      return { entries: entries.length, reapplied, already, nothing };
    },
  };
}
export type ErasureService = ReturnType<typeof createErasureService>;

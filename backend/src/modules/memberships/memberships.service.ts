import { isMembershipRole, type MembershipRole } from '../../contracts';
import { can } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { ForbiddenError } from '../../core/errors';
import { buildPage, normalizePage, type Page } from '../../core/pagination';
import { prefixPattern } from '../../core/search';
import { newId } from '../../core/uuid';
import type { Database, Executor } from '../../db/client';
import { isLastAdminViolation, isUniqueViolation } from '../../db/pg-errors';
import {
  CannotModifySelfError,
  InvalidMembershipRoleError,
  LastAdminError,
  MemberNotActiveError,
  MemberNotFoundError,
  MemberNotSuspendedError,
  MembershipAlreadyExistsError,
  MembershipNotFoundError,
} from './memberships.errors';
import type {
  ChangeArgs,
  MemberListFilter,
  MemberRow,
  MembershipRow,
  MembershipStatus,
  MembershipsRepository,
} from './memberships.repository';

export type Membership = MembershipRow;
export type Member = MemberRow;

export interface ListMembersInput {
  role?: string | undefined;
  status?: string | undefined;
  q?: string | undefined;
  profileType?: string | undefined;
  departmentId?: string | undefined;
  batchId?: string | undefined;
  sectionId?: string | undefined;
  limit?: number | undefined;
  after?: string | undefined;
}

const STATUSES: readonly string[] = ['active', 'pending', 'suspended'];

export function createMembershipsService(deps: {
  db: Pick<Database, 'withTenant'>;
  membershipsRepo: MembershipsRepository;
}) {
  const { db, membershipsRepo } = deps;

  /** Account-level check, re-done here because services are the source of truth. */
  function assertCan(ctx: RequestContext, permission: Parameters<typeof can>[1]): string {
    if (!ctx.tenantId || !can(ctx, permission)) throw new ForbiddenError();
    return ctx.tenantId;
  }

  function filterFrom(input: ListMembersInput): { limit: number; filter: MemberListFilter } {
    const { limit, after } = normalizePage(input);
    if (input.role !== undefined && !isMembershipRole(input.role)) {
      throw new InvalidMembershipRoleError();
    }
    const status = input.status;
    if (status !== undefined && !STATUSES.includes(status)) {
      throw new MemberNotFoundError(); // unreachable through the route schema
    }
    return {
      limit,
      filter: {
        limit: limit + 1,
        after,
        role: input.role as MembershipRole | undefined,
        status: status as MembershipStatus | undefined,
        pattern: input.q === undefined ? undefined : prefixPattern(input.q),
        profileType: input.profileType,
        departmentId: input.departmentId,
        batchId: input.batchId,
        sectionId: input.sectionId,
      },
    };
  }

  /** Runs a mutation and maps the last-admin trigger to its API error. */
  async function mutate<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isLastAdminViolation(err)) throw new LastAdminError();
      throw err;
    }
  }

  async function change(
    ctx: RequestContext,
    tenantId: string,
    userId: string,
    args: Pick<ChangeArgs, 'set' | 'requireStatus' | 'revokeSessions'> & { action: string },
  ) {
    return mutate(() =>
      db.withTenant(tenantId, (tx) =>
        membershipsRepo.change(tx, {
          tenantId,
          userId,
          set: args.set,
          requireStatus: args.requireStatus,
          revokeSessions: args.revokeSessions,
          audit: { id: newId(), actorUserId: ctx.userId, action: args.action },
        }),
      ),
    );
  }

  return {
    // ------------------------------------------------------------------ used by other modules
    /** The user's membership in this tenant (any status), or null. Used by login and unlock. */
    async getMembership(tenantId: string, userId: string): Promise<Membership | null> {
      const row = await db.withTenant(tenantId, (tx) => membershipsRepo.findByUserId(tx, userId), {
        userId,
      });
      return row ?? null;
    },

    /**
     * Creates a PENDING membership for an invite (or re-uses a pending one, updating the role).
     * An already-active (or suspended) member is a conflict.
     */
    async invite(tenantId: string, input: { userId: string; role: string }): Promise<Membership> {
      if (!isMembershipRole(input.role)) throw new InvalidMembershipRoleError();
      const role = input.role;
      return db.withTenant(tenantId, async (tx) => {
        const existing = await membershipsRepo.findByUserId(tx, input.userId);
        if (existing && existing.status !== 'pending') throw new MembershipAlreadyExistsError();
        if (existing) {
          const updated = await membershipsRepo.updateRole(tx, existing.id, role);
          return updated ?? existing;
        }
        const row = await membershipsRepo.insert(tx, {
          id: newId(),
          tenantId,
          userId: input.userId,
          role,
          status: 'pending',
        });
        if (!row) throw new MembershipNotFoundError();
        return row;
      });
    },

    async addMember(
      tenantId: string,
      input: { userId: string; role?: string },
    ): Promise<Membership> {
      const role = input.role ?? 'member';
      if (!isMembershipRole(role)) throw new InvalidMembershipRoleError();
      try {
        const row = await db.withTenant(tenantId, (tx) =>
          membershipsRepo.insert(tx, { id: newId(), tenantId, userId: input.userId, role }),
        );
        if (!row) throw new MembershipNotFoundError();
        return row;
      } catch (err) {
        if (isUniqueViolation(err)) throw new MembershipAlreadyExistsError();
        throw err;
      }
    },

    /**
     * One page of a tenant's members inside a transaction the caller already opened (the audited
     * platform-admin view). Authorization is the caller's job: this does not look at the caller.
     */
    async listPageIn(
      tx: Executor,
      tenantId: string,
      input: ListMembersInput,
    ): Promise<Page<Member>> {
      const { limit, filter } = filterFrom(input);
      return buildPage(await membershipsRepo.list(tx, tenantId, filter), limit);
    },

    // ------------------------------------------------------------------ member management (admin)
    /** GET /members */
    async list(ctx: RequestContext, input: ListMembersInput): Promise<Page<Member>> {
      const tenantId = assertCan(ctx, 'member.read');
      const { limit, filter } = filterFrom(input);
      const rows = await db.withTenant(tenantId, (tx) =>
        membershipsRepo.list(tx, tenantId, filter),
      );
      return buildPage(rows, limit);
    },

    /** GET /members/:userId */
    async get(ctx: RequestContext, userId: string): Promise<Member> {
      const tenantId = assertCan(ctx, 'member.read');
      const row = await db.withTenant(tenantId, (tx) =>
        membershipsRepo.findMember(tx, tenantId, userId),
      );
      if (!row) throw new MemberNotFoundError();
      return row;
    },

    /** PATCH /members/:userId/role: institution_admin <-> member; revokes the user's sessions here. */
    async changeRole(ctx: RequestContext, userId: string, role: string): Promise<Member> {
      const tenantId = assertCan(ctx, 'member.update_role');
      if (!isMembershipRole(role)) throw new InvalidMembershipRoleError();
      if (userId === ctx.userId) throw new CannotModifySelfError();
      const r = await change(ctx, tenantId, userId, {
        set: { role },
        revokeSessions: true,
        action: 'member.role_changed',
      });
      if (!r.found || !r.member) throw new MemberNotFoundError();
      return r.member; // changed === false: already had that role, nothing written
    },

    /** POST /members/:userId/suspend: active -> suspended; revokes sessions; blocks login. */
    async suspend(ctx: RequestContext, userId: string): Promise<Member> {
      const tenantId = assertCan(ctx, 'member.suspend');
      if (userId === ctx.userId) throw new CannotModifySelfError();
      const r = await change(ctx, tenantId, userId, {
        set: { status: 'suspended' },
        requireStatus: ['active'],
        revokeSessions: true,
        action: 'member.suspended',
      });
      if (!r.found || !r.member) throw new MemberNotFoundError();
      if (!r.changed) throw new MemberNotActiveError();
      return r.member;
    },

    /** POST /members/:userId/reactivate: suspended -> active. */
    async reactivate(ctx: RequestContext, userId: string): Promise<Member> {
      const tenantId = assertCan(ctx, 'member.suspend');
      const r = await change(ctx, tenantId, userId, {
        set: { status: 'active' },
        requireStatus: ['suspended'],
        revokeSessions: false,
        action: 'member.reactivated',
      });
      if (!r.found || !r.member) throw new MemberNotFoundError();
      if (!r.changed) throw new MemberNotSuspendedError();
      return r.member;
    },

    /** DELETE /members/:userId: removes the MEMBERSHIP only; the global user may belong elsewhere. */
    async remove(ctx: RequestContext, userId: string): Promise<void> {
      const tenantId = assertCan(ctx, 'member.remove');
      if (userId === ctx.userId) throw new CannotModifySelfError();
      const r = await mutate(() =>
        db.withTenant(tenantId, (tx) =>
          membershipsRepo.remove(tx, {
            tenantId,
            userId,
            audit: { id: newId(), actorUserId: ctx.userId, action: 'member.removed' },
          }),
        ),
      );
      if (!r.removed) throw new MemberNotFoundError();
    },
  };
}
export type MembershipsService = ReturnType<typeof createMembershipsService>;

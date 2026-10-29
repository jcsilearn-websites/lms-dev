import { buildPage, normalizePage, type Page, type PageRequest } from '../../core/pagination';
import { newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import { UserNotFoundError } from './users.errors';
import type { UsersRepository } from './users.repository';

export interface User {
  id: string;
  email: string;
  displayName: string;
  isPlatformAdmin: boolean;
  createdAt: Date;
}

export function createUsersService(deps: {
  db: Pick<Database, 'withTenant' | 'withUser' | 'withoutTenant'>;
  usersRepo: UsersRepository;
}) {
  const { db, usersRepo } = deps;
  return {
    /** Finds or creates a user by (normalized) email; used by the invite flow. */
    ensureUser(email: string, displayName: string): Promise<{ userId: string; created: boolean }> {
      return db.withoutTenant((exec) =>
        usersRepo.ensure(exec, { id: newId(), email, displayName }),
      );
    },

    /** The signed-in user themself (works without a tenant, e.g. platform admins). */
    async getSelf(userId: string): Promise<User> {
      const user = await db.withUser(userId, (tx) => usersRepo.findById(tx, userId));
      if (!user) throw new UserNotFoundError();
      return user;
    },

    /** A user visible in this tenant (a member of it, or `actingUserId` themselves). */
    async getUser(
      tenantId: string,
      userId: string,
      opts?: { actingUserId?: string },
    ): Promise<User> {
      const user = await db.withTenant(
        tenantId,
        (tx) => usersRepo.findById(tx, userId),
        opts?.actingUserId ? { userId: opts.actingUserId } : undefined,
      );
      if (!user) throw new UserNotFoundError();
      return user;
    },

    async listUsers(tenantId: string, request?: PageRequest): Promise<Page<User>> {
      const { limit, after } = normalizePage(request);
      const rows = await db.withTenant(tenantId, (tx) =>
        usersRepo.list(tx, { limit: limit + 1, after }),
      );
      return buildPage(rows, limit);
    },
  };
}
export type UsersService = ReturnType<typeof createUsersService>;

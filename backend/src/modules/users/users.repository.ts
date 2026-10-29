import { asc, eq, gt, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { users } from './users.model';

const columns = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  isPlatformAdmin: users.isPlatformAdmin,
  createdAt: users.createdAt,
};

export function createUsersRepository() {
  return {
    /** Finds the user for an email, creating it when missing (SECURITY DEFINER; emails normalized in SQL). */
    async ensure(
      db: Executor,
      input: { id: string; email: string; displayName: string },
    ): Promise<{ userId: string; created: boolean }> {
      const result = await db.execute(
        sql`select user_id, created from lms.auth_ensure_user(${input.id}::uuid, ${input.email}::text, ${input.displayName}::text)`,
      );
      const row = result.rows[0] as { user_id: string; created: boolean };
      return { userId: row.user_id, created: row.created };
    },

    async findById(tx: Executor, id: string) {
      const [row] = await tx.select(columns).from(users).where(eq(users.id, id)).limit(1);
      return row;
    },

    /** Keyset page over id; `limit` is the number of rows to fetch (callers pass page size + 1). */
    list(tx: Executor, page: { limit: number; after?: string | undefined }) {
      const query = tx.select(columns).from(users);
      return (page.after ? query.where(gt(users.id, page.after)) : query)
        .orderBy(asc(users.id))
        .limit(page.limit);
    },
  };
}
export type UsersRepository = ReturnType<typeof createUsersRepository>;

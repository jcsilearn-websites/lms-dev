import { type Mock, vi } from 'vitest';
import type { Database, Executor } from '../src/db/client';

/** The transaction handed to repositories in unit tests (never actually used by fakes). */
export const tx = {} as Executor;

type FakeDb = Pick<Database, 'withTenant' | 'withUser' | 'withoutTenant'> & {
  withTenant: Mock;
  withUser: Mock;
  withoutTenant: Mock;
};

/** Fake db for service unit tests: runs the callback immediately and records the call. */
export function fakeDb(): FakeDb {
  const withTenant = vi.fn(async (_tenantId: string, fn: (tx: Executor) => Promise<unknown>) =>
    fn(tx),
  );
  const withUser = vi.fn(async (_userId: string, fn: (tx: Executor) => Promise<unknown>) => fn(tx));
  const withoutTenant = vi.fn(async (fn: (db: Executor) => Promise<unknown>) => fn(tx));
  return { withTenant, withUser, withoutTenant } as unknown as FakeDb;
}

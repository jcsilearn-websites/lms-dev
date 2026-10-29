import { describe, expect, it, vi } from 'vitest';
import { fakeDb, tx } from '../../../../test/fakes';
import { newId } from '../../../core/uuid';
import { UserNotFoundError } from '../users.errors';
import type { UsersRepository } from '../users.repository';
import { createUsersService } from '../users.service';

const fakeRepo = (o: Partial<UsersRepository> = {}) =>
  ({ findById: vi.fn(), list: vi.fn(), ...o }) as unknown as UsersRepository;

describe('users service (fake repository)', () => {
  it('getUser returns the user; passes acting user id as app.user_id when given', async () => {
    const tenantId = newId();
    const actingUserId = newId();
    const user = { id: newId(), email: 'a@b.c', displayName: 'A', isPlatformAdmin: false };
    const db = fakeDb();
    const usersRepo = fakeRepo({ findById: vi.fn().mockResolvedValue(user) });
    const result = await createUsersService({ db, usersRepo }).getUser(tenantId, user.id, {
      actingUserId,
    });
    expect(result).toBe(user);
    expect(db.withTenant).toHaveBeenCalledWith(tenantId, expect.any(Function), {
      userId: actingUserId,
    });
  });

  it('getUser throws UserNotFoundError (404) when the user is not visible in the tenant', async () => {
    const usersRepo = fakeRepo({ findById: vi.fn().mockResolvedValue(undefined) });
    const err = await createUsersService({ db: fakeDb(), usersRepo })
      .getUser(newId(), newId())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserNotFoundError);
    expect(err).toMatchObject({ statusCode: 404, code: 'user_not_found' });
  });

  it('listUsers is bounded: clamps the limit and fetches one extra row for the cursor', async () => {
    const list = vi.fn().mockResolvedValue([]);
    const page = await createUsersService({
      db: fakeDb(),
      usersRepo: fakeRepo({ list }),
    }).listUsers(newId(), { limit: 100_000 });
    expect(list).toHaveBeenCalledWith(tx, { limit: 101, after: undefined });
    expect(page).toEqual({ items: [], nextCursor: null });
  });
});

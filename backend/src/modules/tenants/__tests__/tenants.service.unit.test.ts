import { describe, expect, it, vi } from 'vitest';
import { fakeDb, tx } from '../../../../test/fakes';
import { newId } from '../../../core/uuid';
import { TenantNotFoundError, TenantSettingNotFoundError } from '../tenants.errors';
import type { TenantsRepository } from '../tenants.repository';
import { createTenantsService } from '../tenants.service';

function fakeRepo(overrides: Partial<TenantsRepository> = {}): TenantsRepository {
  return {
    findById: vi.fn(),
    listSettings: vi.fn(),
    upsertSetting: vi.fn(),
    deleteSetting: vi.fn(),
    ...overrides,
  } as unknown as TenantsRepository;
}

describe('tenants service (fake repository)', () => {
  it('getTenant opens the tenant context and returns the row', async () => {
    const tenantId = newId();
    const row = { id: tenantId, slug: 'a', name: 'A', createdAt: new Date() };
    const db = fakeDb();
    const tenantsRepo = fakeRepo({ findById: vi.fn().mockResolvedValue(row) });
    const result = await createTenantsService({ db, tenantsRepo }).getTenant(tenantId);
    expect(result).toBe(row);
    expect(db.withTenant).toHaveBeenCalledWith(tenantId, expect.any(Function));
    expect(tenantsRepo.findById).toHaveBeenCalledWith(tx, tenantId);
  });

  it('getTenant throws TenantNotFoundError when RLS hides the row', async () => {
    const tenantsRepo = fakeRepo({ findById: vi.fn().mockResolvedValue(undefined) });
    const err = await createTenantsService({ db: fakeDb(), tenantsRepo })
      .getTenant(newId())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenantNotFoundError);
    expect(err).toMatchObject({ statusCode: 404, code: 'tenant_not_found' });
  });

  it('listSettings fetches limit+1 rows and returns a keyset cursor', async () => {
    const rows = Array.from({ length: 3 }, () => ({ id: newId(), key: 'k' }));
    const listSettings = vi.fn().mockResolvedValue(rows);
    const service = createTenantsService({ db: fakeDb(), tenantsRepo: fakeRepo({ listSettings }) });
    const page = await service.listSettings(newId(), { limit: 2 });
    expect(listSettings).toHaveBeenCalledWith(tx, { limit: 3, after: undefined });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe(rows[1]?.id);
  });

  it('deleteSetting throws TenantSettingNotFoundError when nothing was removed', async () => {
    const tenantsRepo = fakeRepo({ deleteSetting: vi.fn().mockResolvedValue(false) });
    await expect(
      createTenantsService({ db: fakeDb(), tenantsRepo }).deleteSetting(newId(), 'missing'),
    ).rejects.toBeInstanceOf(TenantSettingNotFoundError);
  });

  it('setSetting generates a UUIDv7 id and passes the tenant id to the repository', async () => {
    const tenantId = newId();
    const upsertSetting = vi.fn().mockResolvedValue({ id: 'x', key: 'k' });
    await createTenantsService({
      db: fakeDb(),
      tenantsRepo: fakeRepo({ upsertSetting }),
    }).setSetting(tenantId, { key: 'k', value: { a: 1 } });
    expect(upsertSetting).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ tenantId, key: 'k', id: expect.stringMatching(/^[0-9a-f-]{36}$/) }),
    );
  });
});

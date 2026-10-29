import { describe, expect, it, vi } from 'vitest';
import { fakeDb, tx } from '../../../../test/fakes';
import type { RequestContext } from '../../../core/context';
import { BadRequestError, ForbiddenError } from '../../../core/errors';
import { newId } from '../../../core/uuid';
import { InvalidAuditEntryError } from '../audit.errors';
import type { AuditRepository } from '../audit.repository';
import { createAuditService } from '../audit.service';

const fakeRepo = (o: Partial<AuditRepository> = {}) =>
  ({
    insert: vi.fn(),
    insertPlatform: vi.fn(),
    listTenant: vi.fn(),
    listPlatform: vi.fn(),
    ...o,
  }) as unknown as AuditRepository;

describe('audit service (fake repository)', () => {
  it('record() stamps the tenant id and defaults actor/target/metadata', async () => {
    const tenantId = newId();
    const insert = vi.fn().mockResolvedValue(undefined);
    await createAuditService({ db: fakeDb(), auditRepo: fakeRepo({ insert }) }).record(tenantId, {
      action: 'tenant.updated',
      targetType: 'tenant',
    });
    expect(insert).toHaveBeenCalledWith(tx, {
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      tenantId,
      actorUserId: null,
      action: 'tenant.updated',
      targetType: 'tenant',
      targetId: null,
      metadata: {},
    });
  });

  it('record() rejects empty or over-long actions without writing', async () => {
    const insert = vi.fn();
    const service = createAuditService({ db: fakeDb(), auditRepo: fakeRepo({ insert }) });
    for (const action of ['', 'x'.repeat(101)]) {
      await expect(service.record(newId(), { action, targetType: 't' })).rejects.toBeInstanceOf(
        InvalidAuditEntryError,
      );
    }
    expect(insert).not.toHaveBeenCalled();
  });

  const admin = {
    userId: 'u1',
    tenantId: 'T',
    role: 'institution_admin',
    isPlatformAdmin: false,
  } as unknown as RequestContext;
  const member = { ...admin, role: 'member' } as unknown as RequestContext;
  const root = {
    ...admin,
    tenantId: null,
    role: null,
    isPlatformAdmin: true,
  } as unknown as RequestContext;

  it('listTenantLog() needs audit.read, bounds the page and fetches one extra row', async () => {
    const listTenant = vi.fn().mockResolvedValue([]);
    const service = createAuditService({ db: fakeDb(), auditRepo: fakeRepo({ listTenant }) });
    await expect(service.listTenantLog(member, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.listTenantLog(root, {})).rejects.toBeInstanceOf(ForbiddenError);
    await service.listTenantLog(admin, { limit: 5, action: 'member.suspended' });
    expect(listTenant).toHaveBeenCalledWith(
      tx,
      'T',
      expect.objectContaining({ limit: 6, action: 'member.suspended' }),
    );
  });

  it('listPlatformLog() is for platform admins on the admin host only', async () => {
    const listPlatform = vi.fn().mockResolvedValue([]);
    const service = createAuditService({ db: fakeDb(), auditRepo: fakeRepo({ listPlatform }) });
    await expect(service.listPlatformLog(admin, {})).rejects.toBeInstanceOf(ForbiddenError);
    await service.listPlatformLog(root, {});
    expect(listPlatform).toHaveBeenCalledOnce();
  });

  it('rejects a malformed or inverted date range and a bad cursor before querying', async () => {
    const listTenant = vi.fn();
    const service = createAuditService({ db: fakeDb(), auditRepo: fakeRepo({ listTenant }) });
    await expect(service.listTenantLog(admin, { from: 'yesterday' })).rejects.toBeInstanceOf(
      BadRequestError,
    );
    await expect(
      service.listTenantLog(admin, { from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(service.listTenantLog(admin, { after: 'garbage' })).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(listTenant).not.toHaveBeenCalled();
  });

  it('withPlatformAdminAccess writes the tenant log AND the platform log in the same transaction', async () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const insertPlatform = vi.fn().mockResolvedValue(undefined);
    const db = fakeDb();
    const service = createAuditService({ db, auditRepo: fakeRepo({ insert, insertPlatform }) });
    const result = await service.withPlatformAdminAccess(
      { userId: 'root', isPlatformAdmin: true },
      'T',
      { action: 'platform.tenant_members_read', targetType: 'tenant', targetId: 'T' },
      async () => 'done',
    );
    expect(result).toBe('done');
    expect(db.withTenant).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledOnce();
    expect(insertPlatform).toHaveBeenCalledOnce();
    await expect(
      service.withPlatformAdminAccess(
        { userId: 'x', isPlatformAdmin: false },
        'T',
        { action: 'a', targetType: 't' },
        async () => 1,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

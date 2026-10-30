import { describe, expect, it, vi } from 'vitest';
import { fakeDb, tx } from '../../../../test/fakes';
import type { RequestContext } from '../../../core/context';
import { ForbiddenError } from '../../../core/errors';
import { newId } from '../../../core/uuid';
import {
  CannotModifySelfError,
  InvalidMembershipRoleError,
  LastAdminError,
  MemberNotActiveError,
  MemberNotFoundError,
  MemberNotSuspendedError,
  MembershipAlreadyExistsError,
} from '../memberships.errors';
import type { MemberRow, MembershipsRepository } from '../memberships.repository';
import { createMembershipsService } from '../memberships.service';

const fakeRepo = (o: Partial<MembershipsRepository> = {}) =>
  ({
    list: vi.fn(),
    findMember: vi.fn(),
    change: vi.fn(),
    remove: vi.fn(),
    insert: vi.fn(),
    updateRole: vi.fn(),
    findByUserId: vi.fn(),
    ...o,
  }) as unknown as MembershipsRepository;

const T = newId();
const ADMIN = newId();
const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
  userId: ADMIN,
  tenantId: T,
  role: 'institution_admin',
  isPlatformAdmin: false,
  sessionId: 's',
  email: 'a@x.test',
  displayName: 'A',
  ip: null,
  userAgent: null,
  ...over,
});
const member = (over: Partial<MemberRow> = {}): MemberRow => ({
  id: newId(),
  userId: newId(),
  email: 'm@x.test',
  displayName: 'M',
  role: 'member',
  status: 'active',
  createdAt: new Date(),
  profileType: null,
  registerNumber: null,
  employeeId: null,
  departmentId: null,
  batchId: null,
  sectionId: null,
  ...over,
});
const changed = (m: MemberRow, over = {}) => ({
  found: true,
  changed: true,
  member: m,
  before: { role: m.role, status: m.status },
  ...over,
});

describe('memberships service (fake repository)', () => {
  it('addMember defaults to the member role and sets the tenant id', async () => {
    const userId = newId();
    const insert = vi.fn().mockResolvedValue({ id: 'm', userId, role: 'member' });
    await createMembershipsService({
      db: fakeDb(),
      membershipsRepo: fakeRepo({ insert }),
    }).addMember(T, { userId });
    expect(insert).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ tenantId: T, userId, role: 'member' }),
    );
  });

  it('rejects any role other than institution_admin | member before touching the database', async () => {
    const db = fakeDb();
    const service = createMembershipsService({ db, membershipsRepo: fakeRepo() });
    for (const role of ['student', 'faculty', 'platform_admin', 'MEMBER', '']) {
      await expect(service.addMember(T, { userId: newId(), role })).rejects.toBeInstanceOf(
        InvalidMembershipRoleError,
      );
      await expect(service.changeRole(ctx(), newId(), role)).rejects.toBeInstanceOf(
        InvalidMembershipRoleError,
      );
    }
    expect(db.withTenant).not.toHaveBeenCalled();
  });

  it('maps a unique-violation to MembershipAlreadyExistsError (409)', async () => {
    const insert = vi.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    const err = await createMembershipsService({
      db: fakeDb(),
      membershipsRepo: fakeRepo({ insert }),
    })
      .addMember(T, { userId: newId() })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MembershipAlreadyExistsError);
    expect(err).toMatchObject({ statusCode: 409, code: 'membership_already_exists' });
  });

  it('invite creates a PENDING membership; an active or suspended member is a conflict; a pending one is re-used', async () => {
    const userId = newId();
    const insert = vi
      .fn()
      .mockResolvedValue({ id: 'new', userId, role: 'member', status: 'pending' });
    const service = (found: unknown) =>
      createMembershipsService({
        db: fakeDb(),
        membershipsRepo: fakeRepo({
          findByUserId: vi.fn().mockResolvedValue(found),
          insert,
          updateRole: vi
            .fn()
            .mockResolvedValue({ id: 'old', userId, role: 'institution_admin', status: 'pending' }),
        }),
      });
    await service(undefined).invite(T, { userId, role: 'member' });
    expect(insert).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ status: 'pending', tenantId: T, userId }),
    );
    for (const status of ['active', 'suspended']) {
      await expect(
        service({ id: 'a', userId, role: 'member', status }).invite(T, { userId, role: 'member' }),
      ).rejects.toBeInstanceOf(MembershipAlreadyExistsError);
    }
    const reused = await service({ id: 'old', userId, role: 'member', status: 'pending' }).invite(
      T,
      { userId, role: 'institution_admin' },
    );
    expect(reused.id).toBe('old');
  });
});

describe('member management (permissions re-checked in the service)', () => {
  const memberCtx = ctx({ role: 'member' });
  const platformCtx = ctx({ tenantId: null, role: null, isPlatformAdmin: true });

  it('every operation refuses callers without the permission, without touching the database', async () => {
    const db = fakeDb();
    const s = createMembershipsService({ db, membershipsRepo: fakeRepo() });
    const target = newId();
    for (const c of [memberCtx, platformCtx]) {
      await expect(s.list(c, {})).rejects.toBeInstanceOf(ForbiddenError);
      await expect(s.get(c, target)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(s.changeRole(c, target, 'member')).rejects.toBeInstanceOf(ForbiddenError);
      await expect(s.suspend(c, target)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(s.reactivate(c, target)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(s.remove(c, target)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(db.withTenant).not.toHaveBeenCalled();
  });

  it('an admin cannot demote, suspend or remove themselves', async () => {
    const db = fakeDb();
    const s = createMembershipsService({ db, membershipsRepo: fakeRepo() });
    await expect(s.changeRole(ctx(), ADMIN, 'member')).rejects.toBeInstanceOf(
      CannotModifySelfError,
    );
    await expect(s.suspend(ctx(), ADMIN)).rejects.toBeInstanceOf(CannotModifySelfError);
    await expect(s.remove(ctx(), ADMIN)).rejects.toBeInstanceOf(CannotModifySelfError);
    expect(db.withTenant).not.toHaveBeenCalled();
  });

  it('changeRole revokes sessions and audits as member.role_changed', async () => {
    const m = member({ role: 'institution_admin' });
    const change = vi.fn().mockResolvedValue(changed(m));
    await createMembershipsService({
      db: fakeDb(),
      membershipsRepo: fakeRepo({ change }),
    }).changeRole(ctx(), m.userId, 'institution_admin');
    expect(change).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        tenantId: T,
        userId: m.userId,
        set: { role: 'institution_admin' },
        revokeSessions: true,
        audit: expect.objectContaining({ actorUserId: ADMIN, action: 'member.role_changed' }),
      }),
    );
  });

  it('suspend requires an active member, revokes sessions; reactivate requires a suspended one', async () => {
    const m = member();
    const change = vi
      .fn()
      .mockResolvedValueOnce(changed({ ...m, status: 'suspended' }))
      .mockResolvedValueOnce(changed(m, { changed: false }))
      .mockResolvedValueOnce(changed(m, { changed: false }));
    const s = createMembershipsService({ db: fakeDb(), membershipsRepo: fakeRepo({ change }) });
    expect((await s.suspend(ctx(), m.userId)).status).toBe('suspended');
    expect(change).toHaveBeenLastCalledWith(
      tx,
      expect.objectContaining({
        set: { status: 'suspended' },
        requireStatus: ['active'],
        revokeSessions: true,
      }),
    );
    await expect(s.suspend(ctx(), m.userId)).rejects.toBeInstanceOf(MemberNotActiveError);
    await expect(s.reactivate(ctx(), m.userId)).rejects.toBeInstanceOf(MemberNotSuspendedError);
    expect(change).toHaveBeenLastCalledWith(
      tx,
      expect.objectContaining({ requireStatus: ['suspended'], revokeSessions: false }),
    );
  });

  it('an unknown member is a 404 for every operation', async () => {
    const none = { found: false, changed: false, member: null, before: null };
    const s = createMembershipsService({
      db: fakeDb(),
      membershipsRepo: fakeRepo({
        change: vi.fn().mockResolvedValue(none),
        findMember: vi.fn().mockResolvedValue(null),
      }),
    });
    const u = newId();
    await expect(s.get(ctx(), u)).rejects.toBeInstanceOf(MemberNotFoundError);
    await expect(s.changeRole(ctx(), u, 'member')).rejects.toBeInstanceOf(MemberNotFoundError);
    await expect(s.suspend(ctx(), u)).rejects.toBeInstanceOf(MemberNotFoundError);
    await expect(s.reactivate(ctx(), u)).rejects.toBeInstanceOf(MemberNotFoundError);
    await expect(s.remove(ctx(), u)).rejects.toBeInstanceOf(MemberNotFoundError);
  });

  it('removal is a SOFT removal: status removed, sessions revoked, only for members that are not removed yet', async () => {
    const change = vi
      .fn()
      .mockResolvedValue({ found: true, changed: true, member: member(), before: null });
    const s = createMembershipsService({ db: fakeDb(), membershipsRepo: fakeRepo({ change }) });
    await s.remove(ctx(), newId());
    expect(change).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        set: { status: 'removed' },
        requireStatus: ['active', 'pending', 'suspended'],
        revokeSessions: true,
      }),
    );
    // already removed: nothing changed -> 404
    change.mockResolvedValue({ found: true, changed: false, member: member(), before: null });
    await expect(s.remove(ctx(), newId())).rejects.toBeInstanceOf(MemberNotFoundError);
  });

  it('maps the last-admin trigger violation to 409 last_admin', async () => {
    const violation = Object.assign(new Error('a tenant must keep ...'), {
      code: '23514',
      constraint: 'tenant_last_admin',
    });
    const s = createMembershipsService({
      db: fakeDb(),
      membershipsRepo: fakeRepo({
        change: vi.fn().mockRejectedValue(violation),
      }),
    });
    const err = await s.changeRole(ctx(), newId(), 'member').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LastAdminError);
    expect(err).toMatchObject({ statusCode: 409, code: 'last_admin' });
    await expect(s.remove(ctx(), newId())).rejects.toBeInstanceOf(LastAdminError);
  });

  it('list bounds the page, fetches one extra row, escapes the search term and validates filters', async () => {
    const rows = [member(), member(), member()];
    const list = vi.fn().mockResolvedValue(rows);
    const s = createMembershipsService({ db: fakeDb(), membershipsRepo: fakeRepo({ list }) });
    const page = await s.list(ctx(), { limit: 2, role: 'member', q: ' 50%_Off ' });
    expect(list).toHaveBeenCalledWith(
      tx,
      T,
      expect.objectContaining({ limit: 3, role: 'member', pattern: '50\\%\\_off%' }),
    );
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe(rows[1]?.id);
    await expect(s.list(ctx(), { q: 'a' })).rejects.toMatchObject({ code: 'search_too_short' });
    await expect(s.list(ctx(), { role: 'student' })).rejects.toBeInstanceOf(
      InvalidMembershipRoleError,
    );
    await expect(s.list(ctx(), { after: 'nope' })).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
  });
});

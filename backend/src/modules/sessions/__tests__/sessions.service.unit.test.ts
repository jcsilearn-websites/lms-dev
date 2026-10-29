import { describe, expect, it, vi } from 'vitest';
import { fakeDb, tx } from '../../../../test/fakes';
import { hashToken } from '../../../core/tokens';
import { newId } from '../../../core/uuid';
import { SessionNotFoundError } from '../sessions.errors';
import type { SessionsRepository } from '../sessions.repository';
import { createSessionsService } from '../sessions.service';

const config = { idleSeconds: 3600, absoluteSeconds: 7200, touchSeconds: 300 };
const fakeRepo = (o: Partial<SessionsRepository> = {}) =>
  ({
    insert: vi.fn(),
    listMine: vi.fn(),
    revoke: vi.fn(),
    lookup: vi.fn(),
    revokeUserSessions: vi.fn(),
    ...o,
  }) as unknown as SessionsRepository;
const ctx = (over: object = {}) => ({
  userId: newId(),
  tenantId: newId() as string | null,
  role: 'member' as const,
  isPlatformAdmin: false,
  sessionId: newId(),
  email: 'a@b.co',
  displayName: 'A',
  ip: null,
  userAgent: null,
  ...over,
});

describe('sessions service (fake repository)', () => {
  it('completeLogin makes ONE call with only the SHA-256 of a fresh 32-byte token and a fresh session id', async () => {
    const loginComplete = vi.fn().mockResolvedValue({
      r_status: 'ok',
      r_email: 'a@b.co',
      r_display_name: 'A',
      r_role: 'member',
      r_expires_at: '2026-02-01T00:00:00.000Z',
    });
    const db = fakeDb();
    const service = createSessionsService({
      db,
      sessionsRepo: fakeRepo({ loginComplete }),
      config: { idleSeconds: 3600, absoluteSeconds: 7200, touchSeconds: 300 },
    });
    const tenantId = newId();
    const userId = newId();
    const a = await service.completeLogin({ userId, tenantId, ip: '1.2.3.4', userAgent: 'ua' });
    const b = await service.completeLogin({ userId, tenantId, ip: null, userAgent: null });
    expect(loginComplete).toHaveBeenCalledTimes(2);
    expect(db.withoutTenant).toHaveBeenCalledTimes(2); // one pre-tenant statement each, no transaction
    expect(db.withTenant).not.toHaveBeenCalled();
    expect(a?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a?.token).not.toBe(b?.token); // login always rotates
    expect(a).toMatchObject({ email: 'a@b.co', displayName: 'A', role: 'member' });
    const args = loginComplete.mock.calls[0]?.[1];
    expect(args.tokenHash.equals(hashToken(a?.token as string))).toBe(true);
    expect(JSON.stringify(args)).not.toContain(a?.token);
    expect(args).toMatchObject({
      userId,
      tenantId,
      idleSeconds: 3600,
      absoluteSeconds: 7200,
      ip: '1.2.3.4',
    });
    expect(args.sessionId).toBe(a?.sessionId);
  });

  it('completeLogin returns null when the database refuses (membership/tenant changed)', async () => {
    const loginComplete = vi.fn().mockResolvedValue({ r_status: 'denied' });
    const service = createSessionsService({
      db: fakeDb(),
      sessionsRepo: fakeRepo({ loginComplete }),
      config,
    });
    expect(
      await service.completeLogin({ userId: newId(), tenantId: null, ip: null, userAgent: null }),
    ).toBeNull();
  });

  it('logout is one statement that revokes and audits', async () => {
    const logout = vi.fn().mockResolvedValue(true);
    const db = fakeDb();
    const c = ctx();
    await createSessionsService({ db, sessionsRepo: fakeRepo({ logout }), config }).logout(c);
    expect(logout).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ sessionId: c.sessionId, userId: c.userId, tenantId: c.tenantId }),
    );
    expect(db.withoutTenant).toHaveBeenCalledTimes(1);
  });

  it('purgeDead loops bounded batches until a short batch, and never exceeds maxBatches', async () => {
    const purge = vi
      .fn()
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(3);
    const service = createSessionsService({
      db: fakeDb(),
      sessionsRepo: fakeRepo({ purge }),
      config,
    });
    expect(await service.purgeDead({ retentionDays: 30, batchSize: 500 })).toBe(1003);
    expect(purge).toHaveBeenCalledWith(tx, 30, 500);
    const endless = vi.fn().mockResolvedValue(500);
    const bounded = createSessionsService({
      db: fakeDb(),
      sessionsRepo: fakeRepo({ purge: endless }),
      config,
    });
    await bounded.purgeDead({ retentionDays: 30, batchSize: 500, maxBatches: 5 });
    expect(endless).toHaveBeenCalledTimes(5);
  });

  it('lookup maps the single joined row to an AuthContext and returns null when nothing matches', async () => {
    const row = {
      session_id: 's',
      user_id: 'u',
      tenant_id: 't',
      membership_role: 'member',
      is_platform_admin: false,
      email: 'e',
      display_name: 'D',
    };
    const lookup = vi.fn().mockResolvedValueOnce(row).mockResolvedValueOnce(undefined);
    const service = createSessionsService({
      db: fakeDb(),
      sessionsRepo: fakeRepo({ lookup }),
      config,
    });
    const hash = hashToken('x');
    expect(await service.lookup(hash, 't')).toEqual({
      sessionId: 's',
      userId: 'u',
      tenantId: 't',
      membershipRole: 'member',
      isPlatformAdmin: false,
      email: 'e',
      displayName: 'D',
    });
    expect(lookup).toHaveBeenCalledWith(tx, {
      tokenHash: hash,
      tenantId: 't',
      touchSeconds: 300,
      idleSeconds: 3600,
    });
    expect(await service.lookup(hash, 't')).toBeNull();
  });

  it('listMine marks the current session and paginates with a keyset cursor', async () => {
    const c = ctx();
    const rows = [c.sessionId, newId(), newId()].map((id) => ({
      id,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      ip: null,
      userAgent: null,
    }));
    const listMine = vi.fn().mockResolvedValue(rows);
    const page = await createSessionsService({
      db: fakeDb(),
      sessionsRepo: fakeRepo({ listMine }),
      config,
    }).listMine(c, { limit: 2 });
    expect(listMine).toHaveBeenCalledWith(tx, { limit: 3, after: undefined });
    expect(page.items.map((s) => s.current)).toEqual([true, false]);
    expect(page.nextCursor).toBe(rows[1]?.id);
  });

  it("revokeMine throws SessionNotFoundError when the session is not the caller's (RLS hides it)", async () => {
    const service = createSessionsService({
      db: fakeDb(),
      sessionsRepo: fakeRepo({ revoke: vi.fn().mockResolvedValue(false) }),
      config,
    });
    await expect(service.revokeMine(ctx(), newId())).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('revokeAllForUser passes the optional exceptions through to the SECURITY DEFINER call', async () => {
    const revokeUserSessions = vi.fn().mockResolvedValue(2);
    const service = createSessionsService({
      db: fakeDb(),
      sessionsRepo: fakeRepo({ revokeUserSessions }),
      config,
    });
    const userId = newId();
    const keep = newId();
    expect(await service.revokeAllForUser(userId, { exceptSessionId: keep })).toBe(2);
    expect(revokeUserSessions).toHaveBeenCalledWith(tx, {
      userId,
      exceptSessionId: keep,
      tenantId: null,
    });
  });
});

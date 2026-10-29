import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../../test/fakes';
import { createBackgroundTasks } from '../../../core/mailer';
import type { PasswordHasher } from '../../../core/password';
import { newId } from '../../../core/uuid';
import { InvalidCredentialsError, InvalidTokenError, PasswordRequiredError } from '../auth.errors';
import type { AuthRepository } from '../auth.repository';
import { createAuthService } from '../auth.service';

const tenant = { id: newId(), slug: 'alpha' };
const client = { ip: '10.0.0.1', userAgent: 'vitest' };
const userId = newId();

/** What lms.auth_login_begin returns for a normal active member. */
const begin = (over: object = {}) => ({
  userId,
  passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$abc$def',
  lockedUntil: null,
  isPlatformAdmin: false,
  tenantActive: true,
  membershipRole: 'member',
  membershipStatus: 'active',
  ...over,
});
const unknownAccount = () =>
  begin({
    userId: null,
    passwordHash: null,
    membershipRole: null,
    membershipStatus: null,
    isPlatformAdmin: false,
  });

const ctxOf = (over: object = {}) => ({
  userId,
  tenantId: tenant.id as string | null,
  role: 'institution_admin' as 'institution_admin' | 'member' | null,
  isPlatformAdmin: false,
  sessionId: newId(),
  email: 'adm@x.co',
  displayName: 'Adm',
  ...client,
  ...over,
});

function setup(
  opts: { repo?: Partial<AuthRepository>; verify?: boolean; completeLogin?: unknown } = {},
) {
  const hasher: PasswordHasher = {
    hash: vi.fn().mockResolvedValue('NEWHASH'),
    verify: vi.fn().mockResolvedValue(opts.verify ?? true),
    verifyDummy: vi.fn().mockResolvedValue(false),
    needsRehash: vi.fn().mockReturnValue(false),
  };
  const authRepo = {
    loginBegin: vi.fn().mockResolvedValue(begin()),
    loginFailed: vi.fn().mockResolvedValue({ failedAttempts: 1, justLocked: false }),
    findLogin: vi.fn().mockResolvedValue({
      userId,
      passwordHash: 'HASH',
      lockedUntil: null,
      isPlatformAdmin: false,
    }),
    clearFailures: vi.fn().mockResolvedValue(undefined),
    setPassword: vi.fn().mockResolvedValue(undefined),
    resetPassword: vi.fn().mockResolvedValue(userId),
    changePassword: vi.fn().mockResolvedValue(undefined),
    createToken: vi.fn().mockResolvedValue(undefined),
    acceptInvite: vi.fn().mockResolvedValue({ status: 'ok', userId, tenantId: tenant.id }),
    purgeTokens: vi.fn().mockResolvedValue(0),
    ...opts.repo,
  } as unknown as AuthRepository;
  const mailer = { send: vi.fn().mockResolvedValue(undefined) };
  const background = createBackgroundTasks(() => {});
  const sessionsService = {
    completeLogin: vi.fn().mockResolvedValue(
      opts.completeLogin === undefined
        ? {
            token: 'T'.repeat(43),
            sessionId: newId(),
            expiresAt: new Date(),
            email: 'ada@example.com',
            displayName: 'Ada',
            role: 'member',
          }
        : opts.completeLogin,
    ),
    logout: vi.fn().mockResolvedValue(undefined),
  };
  const membershipsService = {
    getMembership: vi.fn().mockResolvedValue({ id: 'm', role: 'member', status: 'active' }),
    invite: vi.fn().mockResolvedValue({ id: newId(), userId, role: 'member', status: 'pending' }),
  };
  const auditService = {
    record: vi.fn().mockResolvedValue(undefined),
    recordPlatform: vi.fn().mockResolvedValue(undefined),
  };
  const usersService = { ensureUser: vi.fn().mockResolvedValue({ userId, created: true }) };
  const service = createAuthService({
    db: fakeDb(),
    authRepo,
    hasher,
    mailer,
    background,
    sessionsService,
    usersService,
    membershipsService,
    auditService,
    config: { maxAttempts: 3 },
  });
  return {
    service,
    hasher,
    authRepo,
    mailer,
    background,
    sessionsService,
    membershipsService,
    auditService,
  };
}

describe('auth service: login (fake repositories)', () => {
  it('begin -> verify -> complete: two database calls on success, nothing deferred', async () => {
    const s = setup();
    const result = await s.service.login({
      email: ' Ada@Example.com ',
      password: 'pw',
      tenant,
      client,
    });
    expect(s.authRepo.loginBegin).toHaveBeenCalledWith(
      expect.anything(),
      'ada@example.com',
      tenant.id,
    );
    expect(s.hasher.verify).toHaveBeenCalledOnce();
    expect(s.hasher.verifyDummy).not.toHaveBeenCalled();
    expect(s.sessionsService.completeLogin).toHaveBeenCalledWith({
      userId,
      tenantId: tenant.id,
      ip: '10.0.0.1',
      userAgent: 'vitest',
    });
    expect(result.me).toMatchObject({
      role: 'member',
      tenant,
      user: { id: userId, displayName: 'Ada' },
    });
    await s.background.drain();
    expect(s.authRepo.loginFailed).not.toHaveBeenCalled();
    expect(s.authRepo.clearFailures).not.toHaveBeenCalled(); // done inside auth_login_complete
  });

  it('a suspended or unknown tenant (fresh status from the database) is a 404, not a login', async () => {
    const s = setup({
      repo: { loginBegin: vi.fn().mockResolvedValue(begin({ tenantActive: false })) },
    });
    await expect(
      s.service.login({ email: 'a@b.co', password: 'pw', tenant, client }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'tenant_not_found' });
    expect(s.hasher.verify).not.toHaveBeenCalled();
    expect(s.sessionsService.completeLogin).not.toHaveBeenCalled();
  });

  it('unknown email: still runs a (dummy) verification, same generic error, no bookkeeping', async () => {
    const s = setup({ repo: { loginBegin: vi.fn().mockResolvedValue(unknownAccount()) } });
    const err = await s.service
      .login({ email: 'ghost@example.com', password: 'pw', tenant, client })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidCredentialsError);
    expect(s.hasher.verifyDummy).toHaveBeenCalledOnce();
    expect(s.hasher.verify).not.toHaveBeenCalled();
    await s.background.drain();
    expect(s.authRepo.loginFailed).not.toHaveBeenCalled(); // no audit rows for unknown emails
  });

  it('wrong password: verifies, fails with the identical error, one deferred statement counts it', async () => {
    const s = setup({ verify: false });
    const wrong = await s.service
      .login({ email: 'a@b.co', password: 'bad', tenant, client })
      .catch((e: unknown) => e);
    const unknown = await setup({
      repo: { loginBegin: vi.fn().mockResolvedValue(unknownAccount()) },
    })
      .service.login({ email: 'a@b.co', password: 'bad', tenant, client })
      .catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(InvalidCredentialsError);
    expect({ ...(wrong as object) }).toEqual({ ...(unknown as object) }); // same status, code, message
    expect(s.hasher.verify).toHaveBeenCalledOnce();
    await s.background.drain();
    expect(s.authRepo.loginFailed).toHaveBeenCalledTimes(1);
    expect(s.authRepo.loginFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId,
        tenantId: tenant.id,
        countAttempt: true,
        reason: 'bad_password',
        maxAttempts: 3,
        baseSeconds: 60,
        maxSeconds: 900,
        ip: '10.0.0.1',
      }),
    );
  });

  it('a locked account fails generically even with the right password, and is not counted again', async () => {
    const s = setup({
      repo: {
        loginBegin: vi
          .fn()
          .mockResolvedValue(begin({ lockedUntil: new Date(Date.now() + 60_000) })),
      },
    });
    await expect(
      s.service.login({ email: 'a@b.co', password: 'right', tenant, client }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(s.hasher.verify).toHaveBeenCalledOnce(); // same cost as any other attempt
    await s.background.drain();
    expect(s.authRepo.loginFailed).not.toHaveBeenCalled();
    expect(s.sessionsService.completeLogin).not.toHaveBeenCalled();
  });

  it('right password but no active membership: generic failure, audited but NOT counted towards lockout', async () => {
    for (const membershipStatus of [null, 'pending']) {
      const s = setup({
        repo: { loginBegin: vi.fn().mockResolvedValue(begin({ membershipStatus })) },
      });
      await expect(
        s.service.login({ email: 'a@b.co', password: 'right', tenant, client }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
      await s.background.drain();
      expect(s.sessionsService.completeLogin).not.toHaveBeenCalled();
      expect(s.authRepo.loginFailed).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ countAttempt: false, reason: 'no_membership' }),
      );
    }
  });

  it('the database re-validating at completion (race) also ends in the generic error', async () => {
    const s = setup({ completeLogin: null });
    await expect(
      s.service.login({ email: 'a@b.co', password: 'pw', tenant, client }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('on the admin host only platform admins may log in', async () => {
    const denied = setup({
      repo: { loginBegin: vi.fn().mockResolvedValue(begin({ tenantActive: null })) },
    });
    await expect(
      denied.service.login({ email: 'a@b.co', password: 'pw', tenant: null, client }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    const allowed = setup({
      repo: {
        loginBegin: vi.fn().mockResolvedValue(
          begin({
            tenantActive: null,
            isPlatformAdmin: true,
            membershipStatus: null,
          }),
        ),
      },
      completeLogin: {
        token: 'T'.repeat(43),
        sessionId: newId(),
        expiresAt: new Date(),
        email: 'root@x.co',
        displayName: 'Root',
        role: null,
      },
    });
    const res = await allowed.service.login({
      email: 'a@b.co',
      password: 'pw',
      tenant: null,
      client,
    });
    expect(res.me).toMatchObject({ tenant: null, role: null, isPlatformAdmin: true });
    expect(allowed.sessionsService.completeLogin).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: null }),
    );
  });

  it('rehashes transparently when the stored hash uses old parameters', async () => {
    const s = setup();
    vi.mocked(s.hasher.needsRehash).mockReturnValue(true);
    await s.service.login({ email: 'a@b.co', password: 'pw', tenant, client });
    expect(s.hasher.hash).toHaveBeenCalledWith('pw');
    expect(s.authRepo.setPassword).toHaveBeenCalledWith(expect.anything(), userId, 'NEWHASH');
  });

  it('logout is one call to the sessions service', async () => {
    const s = setup();
    const ctx = ctxOf({ role: 'member' });
    await s.service.logout(ctx);
    expect(s.sessionsService.logout).toHaveBeenCalledWith(ctx);
  });
});

describe('auth service: password reset, change, invites (fake repositories)', () => {
  const scope = { tenant, origin: 'http://alpha.localhost:5173' };

  it('forgot for an unknown email creates nothing and sends nothing; for a known one it emails a link', async () => {
    const unknown = setup({ repo: { findLogin: vi.fn().mockResolvedValue(undefined) } });
    await unknown.service.requestPasswordReset({ email: 'x@y.zz', scope, client });
    await unknown.background.drain();
    expect(unknown.authRepo.createToken).not.toHaveBeenCalled();
    expect(unknown.mailer.send).not.toHaveBeenCalled();

    const known = setup();
    await known.service.requestPasswordReset({ email: 'x@y.zz', scope, client });
    await known.background.drain();
    expect(known.authRepo.createToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purpose: 'password_reset', ttlSeconds: 1800 }),
    );
    const mail = known.mailer.send.mock.calls[0]?.[0] as { text: string };
    expect(mail.text).toMatch(
      /^.*http:\/\/alpha\.localhost:5173\/reset-password\?token=[A-Za-z0-9_-]{43}/m,
    );
  });

  it('reset rejects weak passwords before touching the token, and unknown tokens generically', async () => {
    const s = setup();
    await expect(
      s.service.resetPassword({ token: 't'.repeat(30), newPassword: 'short', scope, client }),
    ).rejects.toMatchObject({ code: 'weak_password' });
    expect(s.authRepo.resetPassword).not.toHaveBeenCalled();
    const bad = setup({ repo: { resetPassword: vi.fn().mockResolvedValue(undefined) } });
    await expect(
      bad.service.resetPassword({
        token: 't'.repeat(30),
        newPassword: 'a long enough passphrase',
        scope,
        client,
      }),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('a successful reset is ONE atomic database call (token + password + sessions + audit)', async () => {
    const s = setup();
    await s.service.resetPassword({
      token: 't'.repeat(30),
      newPassword: 'a long enough passphrase',
      scope,
      client,
    });
    expect(s.authRepo.resetPassword).toHaveBeenCalledTimes(1);
    expect(s.authRepo.resetPassword).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ passwordHash: 'NEWHASH', tenantId: tenant.id, ip: '10.0.0.1' }),
    );
    expect(s.authRepo.setPassword).not.toHaveBeenCalled();
  });

  it('change password: verifies the current one, then ONE call sets, revokes others and audits', async () => {
    const ctx = ctxOf({ role: 'member' });
    const ok = setup();
    await ok.service.changePassword(ctx, {
      currentPassword: 'current',
      newPassword: 'a long enough passphrase',
    });
    expect(ok.authRepo.changePassword).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId, passwordHash: 'NEWHASH', exceptSessionId: ctx.sessionId }),
    );
    const wrong = setup({ verify: false });
    await expect(
      wrong.service.changePassword(ctx, {
        currentPassword: 'x',
        newPassword: 'a long enough passphrase',
      }),
    ).rejects.toMatchObject({ code: 'invalid_current_password' });
    expect(wrong.authRepo.changePassword).not.toHaveBeenCalled();
  });

  it('createInvite is institution-admin only, validates the role and never returns user existence', async () => {
    const s = setup();
    const admin = ctxOf();
    await expect(
      s.service.createInvite(ctxOf({ role: 'member' }), {
        email: 'new@x.co',
        role: 'member',
        scope,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      s.service.createInvite(admin, { email: 'new@x.co', role: 'student', scope }),
    ).rejects.toMatchObject({ code: 'invalid_membership_role' });
    await expect(
      s.service.createInvite(admin, { email: 'not-an-email', role: 'member', scope }),
    ).rejects.toMatchObject({ code: 'invalid_email' });
    await expect(
      s.service.createInvite(admin, { email: 'New@X.co', role: 'member', scope }),
    ).resolves.toBeUndefined();
    expect(s.authRepo.createToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purpose: 'invite', ttlSeconds: 604_800, tenantId: tenant.id }),
    );
    expect(s.mailer.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'new@x.co' }));
  });

  it('acceptInvite maps the database status to the right error', async () => {
    const make = (status: string) =>
      setup({
        repo: { acceptInvite: vi.fn().mockResolvedValue({ status, userId: null, tenantId: null }) },
      }).service;
    const input = { token: 't'.repeat(30), tenantId: tenant.id, client };
    await expect(make('password_required').acceptInvite(input)).rejects.toBeInstanceOf(
      PasswordRequiredError,
    );
    await expect(make('invalid').acceptInvite(input)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(
      setup().service.acceptInvite({ ...input, password: 'too short' }),
    ).rejects.toMatchObject({ code: 'weak_password' });
  });

  it('unlock: institution admins only for members of their tenant; platform admins from the admin host; audited', async () => {
    const adminCtx = ctxOf();
    const target = newId();
    const ok = setup();
    await ok.service.unlockMember(adminCtx, target);
    expect(ok.authRepo.clearFailures).toHaveBeenCalledWith(expect.anything(), target);
    expect(ok.auditService.record).toHaveBeenCalledWith(
      tenant.id,
      expect.objectContaining({ action: 'auth.account_unlocked', targetId: target }),
    );

    const stranger = setup();
    vi.mocked(stranger.membershipsService.getMembership).mockResolvedValue(null as never);
    await expect(stranger.service.unlockMember(adminCtx, target)).rejects.toMatchObject({
      code: 'member_not_found',
    });
    expect(stranger.authRepo.clearFailures).not.toHaveBeenCalled();

    await expect(
      setup().service.unlockMember(ctxOf({ role: 'member' }), target),
    ).rejects.toMatchObject({ statusCode: 403 });

    const platform = setup();
    await platform.service.unlockMember(
      ctxOf({ tenantId: null, role: null, isPlatformAdmin: true }),
      target,
    );
    expect(platform.auditService.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.account_unlocked' }),
    );
  });

  it('purgeTokens deletes in bounded batches until a batch comes back short', async () => {
    const purgeTokens = vi
      .fn()
      .mockResolvedValueOnce(1000)
      .mockResolvedValueOnce(1000)
      .mockResolvedValueOnce(7);
    const s = setup({ repo: { purgeTokens } });
    const total = await s.service.purgeTokens({ retentionDays: 30, batchSize: 1000 });
    expect(total).toBe(2007);
    expect(purgeTokens).toHaveBeenCalledTimes(3);
    expect(purgeTokens).toHaveBeenCalledWith(expect.anything(), 30, 1000);
  });

  it('purgeTokens stops after maxBatches so a run is always bounded', async () => {
    const purgeTokens = vi.fn().mockResolvedValue(1000);
    const s = setup({ repo: { purgeTokens } });
    await s.service.purgeTokens({ retentionDays: 30, batchSize: 1000, maxBatches: 4 });
    expect(purgeTokens).toHaveBeenCalledTimes(4);
  });
});

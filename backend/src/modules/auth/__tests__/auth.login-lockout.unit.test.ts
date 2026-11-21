import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../../test/fakes';
import { createBackgroundTasks } from '../../../core/background';
import type { PasswordHasher } from '../../../core/password';
import { newId } from '../../../core/uuid';
import { InvalidCredentialsError } from '../auth.errors';
import type { AuthRepository } from '../auth.repository';
import { createAuthService } from '../auth.service';

// Parallel guesses at ONE account, with a model of the database function lms.auth_record_login_failure (row lock = the calls are
// applied one after the other; attempts while locked are not counted) and a hasher that runs ONE verification at a time in arrival
// order, like PASSWORD_HASH_CONCURRENCY=1 (the real queue is in core/password.ts, tested there).

const tenant = { id: newId(), slug: 'alpha' };
const userId = newId();
const MAX = 5;
const GOOD = 'the right password';

function setup() {
  const account = { failed: 0, lockedUntil: null as number | null, lockEvents: 0 };
  const counted: string[] = []; // order in which failures were recorded
  let argon2Runs = 0;
  let sessions = 0;
  const events: string[] = [];

  const authRepo = {
    // every call reads the account AS IT IS NOW (the model of the database); the service decides "locked" from this read
    loginBegin: vi.fn(async () => ({
      userId,
      passwordHash: 'HASH',
      lockedUntil: account.lockedUntil === null ? null : new Date(account.lockedUntil),
      isPlatformAdmin: false,
      tenantActive: true,
      membershipRole: 'member',
      membershipStatus: 'active',
    })),
    loginFailed: vi.fn(async (_db: unknown, a: { countAttempt: boolean }) => {
      events.push('failure recorded');
      let justLocked = false;
      if (a.countAttempt && !(account.lockedUntil !== null && account.lockedUntil > Date.now())) {
        account.failed += 1;
        counted.push(String(account.failed));
        if (account.failed >= MAX) {
          account.lockedUntil = Date.now() + 60_000;
          account.lockEvents += 1;
          justLocked = true;
        }
      }
      return { failedAttempts: account.failed, justLocked };
    }),
  } as unknown as AuthRepository;

  // one verification at a time, in arrival order; the stale-read window is the time spent waiting for a slot
  let tail: Promise<unknown> = Promise.resolve();
  const hasher: PasswordHasher = {
    hash: vi.fn(),
    verifyDummy: vi.fn(async () => false as const),
    needsRehash: vi.fn(() => false),
    verify: (_hash, password, skipIf) => {
      const run = tail.then(async () => {
        if (skipIf?.()) return false;
        argon2Runs += 1;
        await new Promise((r) => setImmediate(r)); // "the argon2 work": lets the other requests run their statements
        return password === GOOD;
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };

  const sessionsService = {
    completeLogin: vi.fn(async () => {
      // like auth_login_complete: re-reads the lockout under the row lock
      if (account.lockedUntil !== null && account.lockedUntil > Date.now()) return undefined;
      sessions += 1;
      return {
        token: 'T'.repeat(43),
        sessionId: newId(),
        expiresAt: new Date(),
        email: 'ada@example.com',
        displayName: 'Ada',
        role: 'member',
      };
    }),
    logout: vi.fn(),
  };

  const service = createAuthService({
    db: fakeDb(),
    authRepo,
    hasher,
    securityMail: { enqueue: vi.fn() },
    background: createBackgroundTasks(() => {}),
    sessionsService,
    usersService: { ensureUser: vi.fn() },
    membershipsService: { getMembership: vi.fn(), invite: vi.fn() },
    auditService: { recordIn: vi.fn() },
    config: { maxAttempts: MAX },
  } as never);

  const login = (password: string) =>
    service
      .login({
        email: 'ada@example.com',
        password,
        tenant,
        client: { ip: '10.0.0.1', userAgent: 'x' },
      })
      .then(
        () => 'ok' as const,
        (e: unknown) => (e instanceof InvalidCredentialsError ? ('401' as const) : (e as Error)),
      );
  return {
    account,
    counted,
    login,
    events,
    runs: () => argon2Runs,
    sessions: () => sessions,
    authRepo,
  };
}

describe('login lockout under parallel guesses (fake database model)', () => {
  it('N parallel wrong guesses: the lock is set exactly once, only MAX are counted, and the rest never run argon2', async () => {
    const s = setup();
    const N = 20;
    const results = await Promise.all(Array.from({ length: N }, () => s.login('wrong')));

    expect(results.every((r) => r === '401')).toBe(true);
    expect(s.account.lockEvents).toBe(1);
    expect(s.account.failed).toBe(MAX);
    expect(s.counted).toHaveLength(MAX);
    // The guesses that queued behind the one that locked the account were dropped before argon2. The only extra work is the
    // verification that had already been given its slot while the locking failure was still being recorded: at most one per slot
    // (this model has one slot; production has PASSWORD_HASH_CONCURRENCY = 2).
    expect(s.runs()).toBeGreaterThanOrEqual(MAX);
    expect(s.runs()).toBeLessThanOrEqual(MAX + 1);
    expect(s.runs()).toBeLessThanOrEqual(N - 1);
  });

  it('a failure is recorded BEFORE its 401 is returned (nothing is left to a background task)', async () => {
    const s = setup();
    let recorded = false;
    // a slow database: the failure statement finishes 25 ms after it was sent
    (s.authRepo.loginFailed as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 25));
      recorded = true;
      return { failedAttempts: 1, justLocked: false };
    });
    const r = await s.login('wrong');
    expect(r).toBe('401');
    // no drain() of any background queue: the answer came AFTER the statement finished
    expect(recorded).toBe(true);
  });

  it('the right password sent in the same burst never gets a session once the lock is set', async () => {
    const s = setup();
    // MAX wrong guesses first in arrival order, then the right one, then more wrong ones, all started together
    const burst = [
      ...Array.from({ length: MAX }, () => s.login('wrong')),
      s.login(GOOD),
      ...Array.from({ length: 5 }, () => s.login('wrong')),
    ];
    const results = await Promise.all(burst);
    expect(results.every((r) => r === '401')).toBe(true);
    expect(s.sessions()).toBe(0);
    expect(s.account.lockEvents).toBe(1);
    expect(s.account.failed).toBe(MAX);
  });
});

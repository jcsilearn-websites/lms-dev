import type { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../../core/context';
import { newId } from '../../../core/uuid';
import { ExportLimitError, NotAnActiveMemberError } from '../privacy.errors';
import type { PrivacyRepository } from '../privacy.repository';
import { createPrivacyService } from '../privacy.service';

const tenantId = newId();
const userId = newId();
const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
  userId,
  tenantId,
  role: 'member',
  isPlatformAdmin: false,
  sessionId: newId(),
  email: 'ada@example.com',
  displayName: 'Ada',
  ip: '10.0.0.1',
  userAgent: null,
  ...over,
});
const NOW = new Date('2026-03-10T09:00:00Z');

function setup(
  over: {
    repo?: Partial<Record<keyof PrivacyRepository, unknown>>;
    put?: () => Promise<number>;
  } = {},
) {
  const calls: string[] = [];
  const repo = {
    request: vi.fn(async () => ({
      result: 'ok',
      id: newId(),
      status: 'queued',
      requestedAt: NOW.toISOString(),
    })),
    claim: vi.fn(async () => ({ result: 'ok', userId })),
    collect: vi.fn(async () => ({ enrolments: [] })),
    finish: vi.fn(async () => 'ready'),
    fail: vi.fn(async () => 'failed'),
    expireList: vi.fn(async () => []),
    purged: vi.fn(async () => 0),
    ...over.repo,
  } as unknown as PrivacyRepository;
  const passwords = { confirm: vi.fn(async () => undefined) };
  const storage = {
    put: vi.fn(
      over.put ??
        (async (_k: string, body: Readable) => {
          let n = 0;
          for await (const c of body) n += (c as Buffer).length;
          return n;
        }),
    ),
    remove: vi.fn(async (_keys: string[]) => undefined),
    createDownloadTarget: vi.fn(),
  };
  const jobs = { notifyEnqueued: vi.fn() };
  const db = {
    withoutTenant: async (fn: (e: unknown) => unknown) => fn({}),
    withTenant: async (_t: string, fn: (e: unknown) => unknown) => fn({}),
  };
  const service = createPrivacyService({
    db: db as never,
    privacyRepo: repo,
    passwords,
    storage: storage as never,
    jobsService: jobs,
    now: () => NOW,
  });
  return { service, repo, passwords, storage, jobs, calls };
}

describe('requesting an export', () => {
  it('asks for the password BEFORE anything is written, and a refusal writes nothing', async () => {
    const s = setup();
    s.passwords.confirm.mockRejectedValueOnce(new Error('wrong'));
    await expect(s.service.requestExport(ctx(), { password: 'x' })).rejects.toThrow('wrong');
    expect(s.repo.request).not.toHaveBeenCalled();
    expect(s.jobs.notifyEnqueued).not.toHaveBeenCalled();
  });

  it('wakes the worker only for a NEW export, not for one already in progress', async () => {
    const s = setup();
    expect((await s.service.requestExport(ctx(), { password: 'x' })).alreadyInProgress).toBe(false);
    expect(s.jobs.notifyEnqueued).toHaveBeenCalledWith('privacy.export');
    const again = setup({
      repo: {
        request: async () => ({
          result: 'in_progress',
          id: newId(),
          status: 'building',
          requestedAt: NOW.toISOString(),
        }),
      },
    });
    expect((await again.service.requestExport(ctx(), { password: 'x' })).alreadyInProgress).toBe(
      true,
    );
    expect(again.jobs.notifyEnqueued).not.toHaveBeenCalled();
  });

  it('maps the daily limit and a non-member, and refuses the admin host and a platform administrator at once', async () => {
    const limited = setup({ repo: { request: async () => ({ result: 'too_many' }) } });
    await expect(limited.service.requestExport(ctx(), { password: 'x' })).rejects.toBeInstanceOf(
      ExportLimitError,
    );
    const gone = setup({ repo: { request: async () => ({ result: 'not_a_member' }) } });
    await expect(gone.service.requestExport(ctx(), { password: 'x' })).rejects.toBeInstanceOf(
      NotAnActiveMemberError,
    );
    const s = setup();
    await expect(
      s.service.requestExport(ctx({ tenantId: null }), { password: 'x' }),
    ).rejects.toBeInstanceOf(NotAnActiveMemberError);
    await expect(
      s.service.requestExport(ctx({ isPlatformAdmin: true }), { password: 'x' }),
    ).rejects.toBeInstanceOf(NotAnActiveMemberError);
    expect(s.passwords.confirm).not.toHaveBeenCalled();
  });
});

describe('building an export (the worker)', () => {
  const job = (attempt: number, maxAttempts = 3) => ({ attempt, maxAttempts });

  it('stores the archive under a fixed key and records size, hash and counts; a skipped claim does nothing', async () => {
    const s = setup();
    expect(await s.service.buildExport(tenantId, 'e1', job(1))).toEqual({ built: 1 });
    const fin = (s.repo.finish as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(fin).toMatchObject({ tenantId, id: 'e1', now: NOW, ttlSeconds: 7 * 24 * 3600 });
    expect(fin.key).toBe(`${tenantId}/e1`);
    expect(fin.size).toBeGreaterThan(100);
    expect(fin.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fin.counts.enrolments).toBe(0);

    const skipped = setup({ repo: { claim: async () => ({ result: 'skip', status: 'ready' }) } });
    expect(await skipped.service.buildExport(tenantId, 'e1', job(1))).toEqual({ built: 0 });
    expect(skipped.storage.put).not.toHaveBeenCalled();
  });

  it('a failure before the last attempt is retried by the queue (rethrown, NOT marked failed); on the last attempt it is marked failed', async () => {
    const boom = async () => {
      throw new Error('disk');
    };
    const early = setup({ put: boom });
    await expect(early.service.buildExport(tenantId, 'e1', job(1))).rejects.toThrow('disk');
    expect(early.repo.fail).not.toHaveBeenCalled();
    const last = setup({ put: boom });
    await expect(last.service.buildExport(tenantId, 'e1', job(3))).rejects.toThrow('disk');
    expect(last.repo.fail).toHaveBeenCalledWith(expect.anything(), tenantId, 'e1', 'build failed');
  });

  it('an archive that is too large fails at once (no retry) with a generic reason', async () => {
    const big = setup({
      put: async () => {
        const e = new Error('too large');
        e.name = 'TooLargeError';
        throw e;
      },
    });
    expect(await big.service.buildExport(tenantId, 'e1', job(1))).toEqual({ built: 0 });
    expect(big.repo.fail).toHaveBeenCalledWith(
      expect.anything(),
      tenantId,
      'e1',
      'archive too large',
    );
  });
});

describe('expiring exports', () => {
  it('deletes the objects BEFORE clearing the keys, in batches, until nothing is due', async () => {
    const order: string[] = [];
    const due = (n: number) =>
      Array.from({ length: n }, () => ({ id: newId(), tenantId, key: `${tenantId}/${newId()}` }));
    const batches = [due(200), due(3), []];
    const s = setup({
      repo: {
        expireList: async () => batches.shift() ?? [],
        purged: async (_e: unknown, ids: string[]) => {
          order.push(`purged ${ids.length}`);
          return ids.length;
        },
      },
    });
    s.storage.remove.mockImplementation(async (keys: string[]) => {
      order.push(`remove ${keys.length}`);
    });
    expect(await s.service.expireExports()).toBe(203);
    expect(order).toEqual(['remove 200', 'purged 200', 'remove 3', 'purged 3']);
  });
});

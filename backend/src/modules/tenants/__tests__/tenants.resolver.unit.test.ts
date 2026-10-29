import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../../test/fakes';
import type { TenantsRepository } from '../tenants.repository';
import { createTenantsService } from '../tenants.service';

const row = { id: 'a1', slug: 'alpha', status: 'active' };
const repo = (resolveBySlug: unknown) => ({ resolveBySlug }) as unknown as TenantsRepository;

describe('tenant slug resolver (cache)', () => {
  it('caches hits for the TTL, then looks the slug up again', async () => {
    let t = 1000;
    const resolveBySlug = vi.fn().mockResolvedValue(row);
    const service = createTenantsService({
      db: fakeDb(),
      tenantsRepo: repo(resolveBySlug),
      cache: { ttlMs: 60_000, maxEntries: 10 },
      now: () => t,
    });
    expect(await service.resolveBySlug('alpha')).toEqual(row);
    expect(await service.resolveBySlug('alpha')).toEqual(row);
    expect(resolveBySlug).toHaveBeenCalledTimes(1);
    t += 60_001;
    await service.resolveBySlug('alpha');
    expect(resolveBySlug).toHaveBeenCalledTimes(2);
  });

  it('caches unknown slugs too (scanners cannot hammer the database)', async () => {
    const resolveBySlug = vi.fn().mockResolvedValue(undefined);
    const service = createTenantsService({ db: fakeDb(), tenantsRepo: repo(resolveBySlug) });
    expect(await service.resolveBySlug('ghost')).toBeNull();
    expect(await service.resolveBySlug('ghost')).toBeNull();
    expect(resolveBySlug).toHaveBeenCalledTimes(1);
  });

  it('is bounded: the oldest entry is evicted when the cache is full', async () => {
    const resolveBySlug = vi
      .fn()
      .mockImplementation(async (_e: unknown, slug: string) => ({ ...row, slug }));
    const service = createTenantsService({
      db: fakeDb(),
      tenantsRepo: repo(resolveBySlug),
      cache: { ttlMs: 60_000, maxEntries: 2 },
    });
    await service.resolveBySlug('one');
    await service.resolveBySlug('two');
    await service.resolveBySlug('three'); // evicts "one"
    expect(resolveBySlug).toHaveBeenCalledTimes(3);
    await service.resolveBySlug('two'); // still cached
    expect(resolveBySlug).toHaveBeenCalledTimes(3);
    await service.resolveBySlug('one'); // was evicted
    expect(resolveBySlug).toHaveBeenCalledTimes(4);
  });

  it('shares one in-flight lookup between concurrent requests for the same slug', async () => {
    let release: (v: unknown) => void = () => {};
    const resolveBySlug = vi.fn().mockReturnValue(new Promise((r) => (release = r)));
    const service = createTenantsService({ db: fakeDb(), tenantsRepo: repo(resolveBySlug) });
    const calls = [
      service.resolveBySlug('alpha'),
      service.resolveBySlug('alpha'),
      service.resolveBySlug('alpha'),
    ];
    release(row);
    expect(await Promise.all(calls)).toEqual([row, row, row]);
    expect(resolveBySlug).toHaveBeenCalledTimes(1);
  });

  it('ttl 0 disables caching and clearCache() forgets everything', async () => {
    const resolveBySlug = vi.fn().mockResolvedValue(row);
    const off = createTenantsService({
      db: fakeDb(),
      tenantsRepo: repo(resolveBySlug),
      cache: { ttlMs: 0, maxEntries: 5 },
    });
    await off.resolveBySlug('alpha');
    await off.resolveBySlug('alpha');
    expect(resolveBySlug).toHaveBeenCalledTimes(2);

    const on = createTenantsService({ db: fakeDb(), tenantsRepo: repo(resolveBySlug) });
    await on.resolveBySlug('alpha');
    on.clearCache();
    await on.resolveBySlug('alpha');
    expect(resolveBySlug).toHaveBeenCalledTimes(4);
  });
});

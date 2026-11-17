import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../../test/fakes';
import type { RequestContext } from '../../../core/context';
import { newId } from '../../../core/uuid';
import type { UsageDbRow, UsageRepository } from '../usage.repository';
import { createUsageService, currentMonth, parseRenditionMix, USAGE_NOTE } from '../usage.service';

// Metering rules with a fake repository: the rendition mix parser, the month default, unit conversions and rounding, the
// export columns (state of a month in words) and the close job's pass-through.

const ctx: RequestContext = {
  userId: newId(),
  tenantId: null,
  role: null,
  isPlatformAdmin: true,
  sessionId: 's',
  email: 'p@x.test',
  displayName: 'P',
  ip: null,
  userAgent: null,
};

const row = (over: Partial<UsageDbRow> = {}): UsageDbRow => ({
  tenant_id: newId(),
  slug: 'alpha',
  name: 'Alpha College',
  status: 'active',
  provisional: false,
  revision: 1,
  time_zone: 'Asia/Kolkata',
  billable_learners: 120,
  active_users: 140,
  video_seconds: '45000',
  video_gb_estimate: '12.34567',
  storage_bytes: '2500000000',
  offerings: 10,
  active_offerings: 7,
  members: 160,
  ...over,
});

const fakeRepo = (rows: UsageDbRow[] = [row()]) =>
  ({
    platformUsage: vi.fn(async () => rows),
    closeDue: vi.fn(async () => 2),
  }) as unknown as UsageRepository;

const MIX = { '360p': 0.2, '480p': 0.3, '720p': 0.5 };

describe('parseRenditionMix', () => {
  it('keeps non-negative numbers and drops everything else', () => {
    expect(parseRenditionMix('{"360p":0.5,"720p":"x","1080p":-1,"480p":0.5}')).toEqual({
      '360p': 0.5,
      '480p': 0.5,
    });
  });
  it('falls back to the default for invalid JSON or an all-zero mix', () => {
    expect(parseRenditionMix('not json')).toEqual(MIX);
    expect(parseRenditionMix('{"360p":0}')).toEqual(MIX);
  });
});

describe('currentMonth', () => {
  it('is the first day of the UTC month', () => {
    expect(currentMonth(new Date('2026-11-30T23:59:59Z'))).toBe('2026-11-01');
    expect(currentMonth(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01-01');
  });
});

describe('usage list', () => {
  it('defaults to the current month and converts seconds, bytes and GB with fixed rounding', async () => {
    const repo = fakeRepo();
    const service = createUsageService({
      db: fakeDb(),
      usageRepo: repo,
      config: { renditionMix: MIX },
      now: () => new Date('2026-11-16T10:00:00Z'),
    });
    const u = await service.list(ctx);
    expect(u.month).toBe('2026-11-01');
    expect(repo.platformUsage).toHaveBeenCalledWith(
      expect.anything(),
      ctx.userId,
      '2026-11-01',
      MIX,
    );
    expect(u.rows[0]).toMatchObject({
      videoHours: 12.5,
      videoGbEstimate: 12.346,
      storageGb: 2.5,
      billableLearners: 120,
      revision: 1,
      provisional: false,
    });
    expect(u.note).toBe(USAGE_NOTE);
    expect(u.renditionMix).toEqual(MIX);
  });

  it('the CSV says whether a month is open or closed, with the revision', async () => {
    const service = createUsageService({
      db: fakeDb(),
      usageRepo: fakeRepo([row(), row({ slug: 'beta', name: '=Beta', provisional: true })]),
      config: { renditionMix: MIX },
    });
    const csv = await service.csv(ctx, '2026-10-01');
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('closed (revision 1)');
    expect(lines[1]).toContain('2026-10');
    expect(lines[2]).toContain('open (provisional)');
    expect(lines[2]).toContain(`'=Beta`); // formula-safe
  });

  it('the close job passes the clock and the mix through and returns the count', async () => {
    const repo = fakeRepo();
    const at = new Date('2026-12-01T02:00:00Z');
    const service = createUsageService({
      db: fakeDb(),
      usageRepo: repo,
      config: { renditionMix: MIX },
      now: () => at,
    });
    await expect(service.closeDueMonths()).resolves.toBe(2);
    expect(repo.closeDue).toHaveBeenCalledWith(expect.anything(), at, MIX);
  });
});

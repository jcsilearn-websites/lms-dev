import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../../test/fakes';
import type { RequestContext } from '../../../core/context';
import { ForbiddenError } from '../../../core/errors';
import { createUnsubscribeTokens } from '../../../core/mail';
import { newId } from '../../../core/uuid';
import {
  CategoryMandatoryError,
  InvalidUnsubscribeLinkError,
  UnsubscribeNotMemberError,
} from '../notifications.errors';
import type { NotificationsRepository, StoredSettings } from '../notifications.repository';
import { createNotificationsService, unreadEtag } from '../notifications.service';

// The notifications service with a fake repository: paging, the bell's ETag, preferences (defaults, overrides, mandatory),
// settings merge, unsubscribe token checks (host college, category), the scan loop and the purge loop.

const T = newId();
const U = newId();
const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
  userId: U,
  tenantId: T,
  role: 'member',
  isPlatformAdmin: false,
  sessionId: 's',
  email: 'm@x.test',
  displayName: 'M',
  ip: null,
  userAgent: null,
  ...over,
});
const SETTINGS: StoredSettings = {
  defaults: {
    learning_deadlines: { email: true, inApp: true },
    learning_grades: { email: true, inApp: true },
    learning_content: { email: false, inApp: true },
    teaching_grading: { email: true, inApp: true },
    teaching_updates: { email: true, inApp: true },
    admin: { email: true, inApp: true },
  },
  quietHours: { enabled: true, start: '22:00', end: '07:00' },
  digestHour: 7,
  fromName: null,
  replyTo: null,
};
const tokens = createUnsubscribeTokens('k'.repeat(64), { ttlSeconds: 3600 });

function make(o: Record<string, unknown> = {}) {
  const repo = {
    page: vi.fn(async () => []),
    unread: vi.fn(async () => ({ unread: 3, newest: 'n1' })),
    markRead: vi.fn(async () => 1),
    preferences: vi.fn(async () => ({
      settings: SETTINGS,
      rows: [{ category: 'learning_grades', email: false, in_app: true }],
    })),
    upsertPreference: vi.fn(async () => ({ settings: SETTINGS, rows: [] })),
    settings: vi.fn(async () => ({ settings: SETTINGS, tz: 'Asia/Kolkata', emailFrom: null })),
    lockSettings: vi.fn(async () => undefined),
    setSettings: vi.fn(async () => undefined),
    unsubscribeInfo: vi.fn(async () => ({
      college: 'Alpha',
      email_masked: 'me***@x.test',
      subscribed: true,
    })),
    unsubscribe: vi.fn(async () => 'ok'),
    scanTenants: vi.fn(async () => [newId(), newId()]),
    scanTenant: vi.fn(async () => ({ assignmentReminders: 2, contentDigests: 1 })),
    purgeRead: vi.fn(async () => 0),
    platformPage: vi.fn(async () => []),
    platformUnread: vi.fn(async () => ({ unread: 0, newest: null })),
    platformRead: vi.fn(async () => 0),
    ...o,
  } as unknown as NotificationsRepository & Record<string, ReturnType<typeof vi.fn>>;
  const service = createNotificationsService({
    db: fakeDb(),
    notificationsRepo: repo,
    unsubscribe: tokens,
    config: { readRetentionDays: 90, purgeBatchSize: 2 },
  });
  return { service, repo };
}

describe('the list and the bell', () => {
  it('pages with a cursor only when there is more', async () => {
    const row = (id: string) => ({
      id,
      category: 'learning_grades',
      type: 't',
      params: {},
      link: null,
      created_at: new Date(0),
      read_at: null,
    });
    const { service } = make({ page: vi.fn(async () => [row('c'), row('b'), row('a')]) });
    const p = await service.list(ctx(), { limit: 2 });
    expect(p.items.map((i) => i.id)).toEqual(['c', 'b']);
    expect(p.nextCursor).toBe('b');
    expect(p.items[0]?.createdAt).toBe('1970-01-01T00:00:00.000Z');
  });
  it('the ETag follows count and newest; a platform admin uses their own inbox; no college and not platform = 403', async () => {
    expect(unreadEtag({ unread: 3, newest: 'n1' })).toBe('W/"3.n1"');
    expect(unreadEtag({ unread: 0, newest: null })).toBe('W/"0.0"');
    const { service, repo } = make();
    expect(await service.unread(ctx())).toEqual({ unread: 3, etag: 'W/"3.n1"' });
    await service.unread(ctx({ tenantId: null, isPlatformAdmin: true, role: null }));
    expect(repo.platformUnread).toHaveBeenCalled();
    await expect(service.unread(ctx({ tenantId: null }))).rejects.toThrow(ForbiddenError);
  });
});

describe('preferences', () => {
  it('shows the college default unless the member chose otherwise; security is fixed', async () => {
    const { service } = make();
    const p = await service.preferences(ctx());
    expect(p.items[0]).toMatchObject({
      category: 'security',
      mandatory: true,
      email: true,
      inApp: true,
    });
    expect(p.items.find((i) => i.category === 'learning_grades')).toMatchObject({
      email: false,
      inApp: true,
      overridden: true,
    });
    expect(p.items.find((i) => i.category === 'learning_content')).toMatchObject({
      email: false,
      overridden: false,
      collegeDefault: { email: false, inApp: true },
    });
  });
  it('security cannot be changed (409) and is never written', async () => {
    const { service, repo } = make();
    await expect(
      service.updatePreference(ctx(), { category: 'security', email: false, inApp: false }),
    ).rejects.toThrow(CategoryMandatoryError);
    expect(repo.upsertPreference).not.toHaveBeenCalled();
  });
});

describe('college settings', () => {
  it('needs notification.settings.manage; merges a partial patch; audits before / after', async () => {
    const { service, repo } = make();
    await expect(service.settings(ctx())).rejects.toThrow(ForbiddenError);
    const out = await service.updateSettings(ctx({ role: 'institution_admin' }), {
      defaults: { admin: { email: false, inApp: true } },
      digestHour: 9,
    });
    expect(out.digestHour).toBe(9);
    expect(out.defaults.admin).toEqual({ email: false, inApp: true });
    expect(out.defaults.learning_content).toEqual({ email: false, inApp: true });
    expect(out.quietHours).toEqual({ enabled: true, start: '22:00', end: '07:00' });
    const call = (repo.setSettings as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(call.before.digestHour).toBe(7);
    expect(call.value.digestHour).toBe(9);
  });
});

describe('unsubscribe', () => {
  const tok = (category = 'learning_grades', tenantId = T) =>
    tokens.sign({ tenantId, userId: U, category });
  it("works on the token's own college only; security tokens are refused before any database call", async () => {
    const { service, repo } = make();
    expect(await service.unsubscribe(T, tok())).toEqual({ categoryLabel: 'Grades and results' });
    await expect(service.unsubscribe(newId(), tok())).rejects.toThrow(InvalidUnsubscribeLinkError);
    await expect(service.unsubscribe(null, tok())).rejects.toThrow(InvalidUnsubscribeLinkError);
    await expect(service.unsubscribe(T, tok('security'))).rejects.toThrow(CategoryMandatoryError);
    await expect(service.unsubscribe(T, tok('made_up'))).rejects.toThrow(CategoryMandatoryError);
    await expect(service.unsubscribe(T, 'v1.garbage.x')).rejects.toThrow(
      InvalidUnsubscribeLinkError,
    );
    expect(repo.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('a member who left the college: 404', async () => {
    const { service } = make({
      unsubscribe: vi.fn(async () => 'not_member'),
      unsubscribeInfo: vi.fn(async () => null),
    });
    await expect(service.unsubscribe(T, tok())).rejects.toThrow(UnsubscribeNotMemberError);
    await expect(service.unsubscribeInfo(T, tok())).rejects.toThrow(UnsubscribeNotMemberError);
  });
});

describe('the worker', () => {
  it('scans every active college once and sums the counts; stops when aborted', async () => {
    const { service, repo } = make();
    expect(await service.scan({ now: new Date(0) })).toEqual({
      colleges: 2,
      assignmentReminders: 4,
      contentDigests: 2,
    });
    const ac = new AbortController();
    ac.abort();
    expect(await service.scan({ signal: ac.signal })).toEqual({ colleges: 0 });
    expect(repo.scanTenant).toHaveBeenCalledTimes(2);
  });
  it('purges in batches until a short one', async () => {
    const counts = [2, 2, 1];
    const { service, repo } = make({ purgeRead: vi.fn(async () => counts.shift() ?? 0) });
    expect(await service.purgeRead()).toBe(5);
    expect(repo.purgeRead).toHaveBeenCalledTimes(3);
  });
});

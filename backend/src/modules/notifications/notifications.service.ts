import {
  NOTIFICATION_CATEGORIES,
  type Notification,
  type NotificationCategory,
  type NotificationPage,
  type NotificationSettings,
  type OptionalCategory,
  type Preferences,
  type UnsubscribeInfo,
  type UpdateNotificationSettingsRequest,
  type UpdatePreferenceRequest,
} from '../../contracts';
import { can } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { ForbiddenError } from '../../core/errors';
import { CATEGORY_LABELS, type UnsubscribeTokens } from '../../core/mail';
import { newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import {
  CategoryMandatoryError,
  InvalidUnsubscribeLinkError,
  UnsubscribeNotMemberError,
} from './notifications.errors';
import type {
  NotificationRow,
  NotificationsRepository,
  StoredSettings,
} from './notifications.repository';

export interface NotificationsConfig {
  readRetentionDays: number;
  purgeBatchSize: number;
}

const toIso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();
const MAX_PURGE_BATCHES = 100;
const OPTIONAL = NOTIFICATION_CATEGORIES.filter((c) => c !== 'security') as OptionalCategory[];

function toNotification(r: NotificationRow): Notification {
  return {
    id: r.id,
    category: r.category as NotificationCategory,
    type: r.type,
    params: r.params ?? {},
    link: r.link,
    createdAt: toIso(r.created_at),
    readAt: r.read_at ? toIso(r.read_at) : null,
  };
}

/** The ETag of the bell: changes when the count or the newest unread notification changes. */
export function unreadEtag(u: { unread: number; newest: string | null }): string {
  return `W/"${u.unread}.${u.newest ?? '0'}"`;
}

export function createNotificationsService(deps: {
  db: Pick<Database, 'withTenant' | 'withoutTenant'>;
  notificationsRepo: NotificationsRepository;
  unsubscribe: UnsubscribeTokens;
  config: NotificationsConfig;
  now?: () => Date;
}) {
  const { db, notificationsRepo: repo, config } = deps;
  const clock = deps.now ?? (() => new Date());

  const member = (ctx: RequestContext): string => {
    if (!ctx.tenantId) throw new ForbiddenError();
    return ctx.tenantId;
  };
  const platform = (ctx: RequestContext) => {
    if (ctx.tenantId !== null || !ctx.isPlatformAdmin) throw new ForbiddenError();
  };

  /** A verified token whose college is THIS host's college; anything else is one generic refusal. */
  function claimsFor(tenantId: string | null, token: string) {
    const v = deps.unsubscribe.verify(token);
    if (!v.ok) throw new InvalidUnsubscribeLinkError(v.reason === 'expired');
    if (!tenantId || v.claims.tenantId !== tenantId) throw new InvalidUnsubscribeLinkError(false);
    if (
      v.claims.category === 'security' ||
      !OPTIONAL.includes(v.claims.category as OptionalCategory)
    ) {
      throw new CategoryMandatoryError();
    }
    return v.claims;
  }

  return {
    // ---------------------------------------------------------------- in-app
    async list(
      ctx: RequestContext,
      q: { after?: string | undefined; limit?: number | undefined; unread?: boolean | undefined },
    ): Promise<NotificationPage> {
      const tenantId = member(ctx);
      const limit = q.limit ?? 20;
      const rows = await db.withTenant(
        tenantId,
        (tx) =>
          repo.page(tx, {
            tenantId,
            userId: ctx.userId,
            after: q.after ?? null,
            limit: limit + 1,
            unread: q.unread === true,
          }),
        { userId: ctx.userId },
      );
      const items = rows.slice(0, limit).map(toNotification);
      return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
    },

    /** The bell: 2 round trips (session lookup + one definer call). */
    async unread(ctx: RequestContext): Promise<{ unread: number; etag: string }> {
      if (ctx.tenantId === null && ctx.isPlatformAdmin) {
        const u = await db.withoutTenant((c) => repo.platformUnread(c, ctx.userId));
        return { unread: u.unread, etag: unreadEtag(u) };
      }
      const tenantId = member(ctx);
      const u = await db.withoutTenant((c) => repo.unread(c, tenantId, ctx.userId));
      return { unread: u.unread, etag: unreadEtag(u) };
    },

    async markRead(ctx: RequestContext, id: string | null): Promise<number> {
      const tenantId = member(ctx);
      return db.withTenant(
        tenantId,
        (tx) => repo.markRead(tx, { tenantId, userId: ctx.userId, id }),
        { userId: ctx.userId },
      );
    },

    // ---------------------------------------------------------------- preferences
    async preferences(ctx: RequestContext): Promise<Preferences> {
      const tenantId = member(ctx);
      const p = await db.withTenant(tenantId, (tx) => repo.preferences(tx, tenantId, ctx.userId), {
        userId: ctx.userId,
      });
      return toPreferences(p.settings, p.rows);
    },

    /** Effective at once: the fan-out and the send both read the stored preference. ONE statement (write + read back). */
    async updatePreference(
      ctx: RequestContext,
      body: UpdatePreferenceRequest,
    ): Promise<Preferences> {
      const tenantId = member(ctx);
      if (body.category === 'security') throw new CategoryMandatoryError();
      const p = await db.withTenant(
        tenantId,
        (tx) =>
          repo.upsertPreference(tx, {
            tenantId,
            userId: ctx.userId,
            category: body.category,
            email: body.email,
            inApp: body.inApp,
          }),
        { userId: ctx.userId },
      );
      return toPreferences(p.settings, p.rows ?? []);
    },

    // ---------------------------------------------------------------- college settings
    async settings(ctx: RequestContext): Promise<NotificationSettings> {
      const tenantId = member(ctx);
      if (!can(ctx, 'notification.settings.manage')) throw new ForbiddenError();
      const s = await db.withTenant(tenantId, (tx) => repo.settings(tx, tenantId));
      return toSettings(s.settings, s.tz, s.emailFrom);
    },

    async updateSettings(
      ctx: RequestContext,
      patch: UpdateNotificationSettingsRequest,
    ): Promise<NotificationSettings> {
      const tenantId = member(ctx);
      if (!can(ctx, 'notification.settings.manage')) throw new ForbiddenError();
      return db.withTenant(tenantId, async (tx) => {
        const cur = await repo.settings(tx, tenantId);
        const before = stored(cur.settings);
        const defaults = { ...before.defaults };
        for (const [k, v] of Object.entries(patch.defaults ?? {})) if (v) defaults[k] = v;
        const value: StoredSettings = {
          defaults,
          quietHours: patch.quietHours ?? before.quietHours,
          digestHour: patch.digestHour ?? before.digestHour,
          fromName: patch.fromName === undefined ? before.fromName : patch.fromName,
          replyTo: patch.replyTo === undefined ? before.replyTo : patch.replyTo,
        };
        await repo.setSettings(tx, {
          tenantId,
          userId: ctx.userId,
          auditId: newId(),
          value,
          before,
        });
        return toSettings(value, cur.tz, cur.emailFrom);
      });
    },

    // ---------------------------------------------------------------- unsubscribe (public, the token is the authority)
    async unsubscribeInfo(tenantId: string | null, token: string): Promise<UnsubscribeInfo> {
      const c = claimsFor(tenantId, token);
      const r = await db.withoutTenant((x) =>
        repo.unsubscribeInfo(x, { tenantId: c.tenantId, userId: c.userId, category: c.category }),
      );
      if (!r) throw new UnsubscribeNotMemberError();
      return {
        college: r.college,
        emailMasked: r.email_masked,
        category: c.category as OptionalCategory,
        categoryLabel: CATEGORY_LABELS[c.category] ?? c.category,
        subscribed: r.subscribed,
      };
    },

    /** Idempotent: unsubscribing twice is still a success. */
    async unsubscribe(tenantId: string | null, token: string): Promise<{ categoryLabel: string }> {
      const c = claimsFor(tenantId, token);
      const r = await db.withoutTenant((x) =>
        repo.unsubscribe(x, {
          tenantId: c.tenantId,
          userId: c.userId,
          category: c.category,
          auditId: newId(),
        }),
      );
      if (r === 'mandatory') throw new CategoryMandatoryError();
      if (r === 'not_member') throw new UnsubscribeNotMemberError();
      return { categoryLabel: CATEGORY_LABELS[c.category] ?? c.category };
    },

    // ---------------------------------------------------------------- platform admins
    async platformList(
      ctx: RequestContext,
      q: { after?: string | undefined; limit?: number | undefined; unread?: boolean | undefined },
    ): Promise<NotificationPage> {
      platform(ctx);
      const limit = q.limit ?? 20;
      const rows = await db.withoutTenant((c) =>
        repo.platformPage(c, {
          actorUserId: ctx.userId,
          after: q.after ?? null,
          limit: limit + 1,
          unread: q.unread === true,
        }),
      );
      const items = rows.slice(0, limit).map(toNotification);
      return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
    },
    async platformRead(ctx: RequestContext, id: string | null): Promise<number> {
      platform(ctx);
      return db.withoutTenant((c) => repo.platformRead(c, ctx.userId, id));
    },

    // ---------------------------------------------------------------- the worker
    /** One pass over the active colleges: ONE statement each (reminders, quizzes, results, digests, summaries). */
    async scan(opts: { signal?: AbortSignal; now?: Date } = {}): Promise<Record<string, number>> {
      const tenants = await db.withoutTenant((c) => repo.scanTenants(c));
      const totals: Record<string, number> = { colleges: 0 };
      for (const tenantId of tenants) {
        if (opts.signal?.aborted) break;
        const out = await db.withoutTenant((c) =>
          repo.scanTenant(c, tenantId, opts.now ?? clock()),
        );
        totals.colleges = (totals.colleges ?? 0) + 1;
        for (const [k, v] of Object.entries(out)) totals[k] = (totals[k] ?? 0) + Number(v);
      }
      return totals;
    },
    /** tests and the benchmark: one college at a given instant */
    async scanTenant(tenantId: string, now: Date): Promise<Record<string, number>> {
      return db.withoutTenant((c) => repo.scanTenant(c, tenantId, now));
    },

    async purgeRead(): Promise<number> {
      let total = 0;
      for (let i = 0; i < MAX_PURGE_BATCHES; i++) {
        const n = await db.withoutTenant((c) =>
          repo.purgeRead(c, config.readRetentionDays, config.purgeBatchSize),
        );
        total += n;
        if (n < config.purgeBatchSize) break;
      }
      return total;
    },
  };
}
export type NotificationsService = ReturnType<typeof createNotificationsService>;

/** Every category with the member's value, the college default, and whether the member overrode it. */
function toPreferences(
  settings: StoredSettings,
  rows: { category: string; email: boolean; in_app: boolean }[],
): Preferences {
  const own = new Map(rows.map((r) => [r.category, r]));
  return {
    items: NOTIFICATION_CATEGORIES.map((category) => {
      if (category === 'security') {
        return {
          category,
          email: true,
          inApp: true,
          mandatory: true,
          collegeDefault: { email: true, inApp: true },
          overridden: false,
        };
      }
      const d = settings.defaults[category] ?? { email: true, inApp: true };
      const mine = own.get(category);
      const email = mine ? mine.email : d.email;
      const inApp = mine ? mine.in_app : d.inApp;
      return {
        category,
        email,
        inApp,
        mandatory: false,
        collegeDefault: { email: d.email, inApp: d.inApp },
        overridden: email !== d.email || inApp !== d.inApp,
      };
    }),
  };
}

/** The stored shape (what notify_settings merged), normalised. */
function stored(s: StoredSettings): StoredSettings {
  const defaults: StoredSettings['defaults'] = {};
  for (const c of OPTIONAL) {
    const d = s.defaults?.[c];
    defaults[c] = { email: d?.email !== false, inApp: d?.inApp !== false };
  }
  return {
    defaults,
    quietHours: {
      enabled: s.quietHours?.enabled !== false,
      start: s.quietHours?.start ?? '22:00',
      end: s.quietHours?.end ?? '07:00',
    },
    digestHour: Number(s.digestHour ?? 7),
    fromName: s.fromName ?? null,
    replyTo: s.replyTo ?? null,
  };
}

function toSettings(s: StoredSettings, tz: string, emailFrom: string | null): NotificationSettings {
  const v = stored(s);
  return {
    defaults: v.defaults as NotificationSettings['defaults'],
    quietHours: v.quietHours,
    digestHour: v.digestHour,
    fromName: v.fromName,
    replyTo: v.replyTo,
    fromAddress: emailFrom,
    timeZone: tz,
  };
}

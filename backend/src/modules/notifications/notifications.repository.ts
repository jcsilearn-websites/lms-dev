import { sql } from 'drizzle-orm';
import { SETTINGS_LOCK_CLASS, settingsLockKey } from '../../core/locks';
import type { Executor } from '../../db/client';
import { auditInsertFrom } from '../audit';

// SQL only. In-app reads and "mark read" run under RLS (the member's own rows: tenant AND app.user_id); everything that
// crosses members or colleges (the bell's count, unsubscribe, the scan, the purge, the platform inbox) is a definer function
// of migrations 0052 / 0053. Each call is ONE statement.

export interface NotificationRow {
  id: string;
  category: string;
  type: string;
  params: Record<string, unknown>;
  link: string | null;
  created_at: Date | string;
  read_at: Date | string | null;
}

export interface StoredSettings {
  defaults: Record<string, { email: boolean; inApp: boolean }>;
  quietHours: { enabled: boolean; start: string; end: string };
  digestHour: number;
  fromName: string | null;
  replyTo: string | null;
}

const T = (id: string | null) => sql`${id}::uuid`;

export function createNotificationsRepository() {
  return {
    async page(
      tx: Executor,
      o: { tenantId: string; userId: string; after: string | null; limit: number; unread: boolean },
    ): Promise<NotificationRow[]> {
      const r = await tx.execute(sql`
        SELECT n.id, n.category, n.type, n.params, n.link, n.created_at, n.read_at
          FROM lms.notifications n
         WHERE n.tenant_id = ${T(o.tenantId)} AND n.user_id = ${T(o.userId)}
           ${o.unread ? sql`AND n.read_at IS NULL` : sql``}
           ${o.after ? sql`AND n.id < ${T(o.after)}` : sql``}
         ORDER BY n.id DESC
         LIMIT ${o.limit}::int`);
      return r.rows as unknown as NotificationRow[];
    },

    async unread(
      exec: Executor,
      tenantId: string,
      userId: string,
    ): Promise<{ unread: number; newest: string | null }> {
      const r = await exec.execute(
        sql`SELECT * FROM lms.notify_unread(${T(tenantId)}, ${T(userId)})`,
      );
      const x = r.rows[0] as { unread: number; newest: string | null };
      return { unread: Number(x.unread), newest: x.newest };
    },

    /** id null = every unread notification of the member */
    async markRead(
      tx: Executor,
      o: { tenantId: string; userId: string; id: string | null },
    ): Promise<number> {
      const r = await tx.execute(sql`
        UPDATE lms.notifications SET read_at = now()
         WHERE tenant_id = ${T(o.tenantId)} AND user_id = ${T(o.userId)} AND read_at IS NULL
           ${o.id ? sql`AND id = ${T(o.id)}` : sql``}`);
      return r.rowCount ?? 0;
    },

    /** The college's merged settings and the member's own overrides, ONE statement. */
    async preferences(
      tx: Executor,
      tenantId: string,
      userId: string,
    ): Promise<{
      settings: StoredSettings;
      rows: { category: string; email: boolean; in_app: boolean }[];
    }> {
      const r = await tx.execute(sql`
        SELECT lms.notify_settings(${T(tenantId)}) AS settings,
               coalesce((SELECT jsonb_agg(jsonb_build_object('category', p.category, 'email', p.email, 'in_app', p.in_app))
                           FROM lms.notification_preferences p
                          WHERE p.tenant_id = ${T(tenantId)} AND p.user_id = ${T(userId)}), '[]'::jsonb) AS rows`);
      const x = r.rows[0] as {
        settings: StoredSettings;
        rows: { category: string; email: boolean; in_app: boolean }[];
      };
      return x;
    },

    /**
     * ONE statement: write the category and read back everything the page shows (a CTE's write is not visible to the same
     * statement's reads, so the written row is merged in from RETURNING).
     */
    async upsertPreference(
      tx: Executor,
      o: { tenantId: string; userId: string; category: string; email: boolean; inApp: boolean },
    ): Promise<{
      settings: StoredSettings;
      rows: { category: string; email: boolean; in_app: boolean }[];
    }> {
      const r = await tx.execute(sql`
        WITH up AS (
          INSERT INTO lms.notification_preferences (tenant_id, user_id, category, email, in_app)
          VALUES (${T(o.tenantId)}, ${T(o.userId)}, ${o.category}::text, ${o.email}, ${o.inApp})
          ON CONFLICT (tenant_id, user_id, category)
          DO UPDATE SET email = EXCLUDED.email, in_app = EXCLUDED.in_app, updated_at = now()
          RETURNING category, email, in_app)
        SELECT lms.notify_settings(${T(o.tenantId)}) AS settings,
               (SELECT jsonb_agg(jsonb_build_object('category', x.category, 'email', x.email, 'in_app', x.in_app))
                  FROM (SELECT category, email, in_app FROM up
                        UNION ALL
                        SELECT p.category, p.email, p.in_app FROM lms.notification_preferences p
                         WHERE p.tenant_id = ${T(o.tenantId)} AND p.user_id = ${T(o.userId)}
                           AND p.category <> ${o.category}::text) x) AS rows`);
      return r.rows[0] as {
        settings: StoredSettings;
        rows: { category: string; email: boolean; in_app: boolean }[];
      };
    },

    /**
     * First statement of a settings PATCH: one writer at a time per college. The read that follows is a NEW statement (a new
     * snapshot), so it sees what the previous writer committed: without this two admins changing different fields lost one change.
     */
    async lockSettings(tx: Executor, tenantId: string): Promise<void> {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${settingsLockKey(tenantId)}::text, ${SETTINGS_LOCK_CLASS}::bigint))`,
      );
    },

    /** settings + zone + the verified From address, ONE statement */
    async settings(
      tx: Executor,
      tenantId: string,
    ): Promise<{ settings: StoredSettings; tz: string; emailFrom: string | null }> {
      const r = await tx.execute(sql`
        SELECT lms.notify_settings(${T(tenantId)}) AS settings, lms.tenant_tz(${T(tenantId)}) AS tz,
               (SELECT t.email_from FROM lms.tenants t WHERE t.id = ${T(tenantId)}) AS email_from`);
      const x = r.rows[0] as { settings: StoredSettings; tz: string; email_from: string | null };
      return { settings: x.settings, tz: x.tz, emailFrom: x.email_from };
    },

    /** ONE statement: upsert the 'notifications' key and audit with before and after. */
    async setSettings(
      tx: Executor,
      o: {
        tenantId: string;
        userId: string;
        auditId: string;
        value: StoredSettings;
        before: StoredSettings;
      },
    ): Promise<void> {
      const audit = auditInsertFrom(
        {
          id: o.auditId,
          tenantId: o.tenantId,
          actorUserId: o.userId,
          action: 'notification.settings_updated',
          targetType: 'tenant',
        },
        {
          from: sql`up`,
          targetId: sql`${o.tenantId}::text`,
          metadata: sql`jsonb_build_object('before', ${JSON.stringify(o.before)}::jsonb, 'after', ${JSON.stringify(o.value)}::jsonb)`,
        },
      );
      await tx.execute(sql`
        WITH up AS (
          INSERT INTO lms.tenant_settings (id, tenant_id, key, value)
          VALUES (lms.uuid_v7(), ${T(o.tenantId)}, 'notifications', ${JSON.stringify(o.value)}::jsonb)
          ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
          RETURNING 1)
        ${audit}`);
    },

    async unsubscribeInfo(
      exec: Executor,
      o: { tenantId: string; userId: string; category: string },
    ): Promise<{ college: string; email_masked: string; subscribed: boolean } | null> {
      const r = await exec.execute(
        sql`SELECT * FROM lms.notify_unsubscribe_info(${T(o.tenantId)}, ${T(o.userId)}, ${o.category}::text)`,
      );
      return (r.rows[0] as { college: string; email_masked: string; subscribed: boolean }) ?? null;
    },

    async unsubscribe(
      exec: Executor,
      o: { tenantId: string; userId: string; category: string; auditId: string },
    ): Promise<'ok' | 'mandatory' | 'not_member'> {
      const r = await exec.execute(
        sql`SELECT lms.notify_unsubscribe(${T(o.tenantId)}, ${T(o.userId)}, ${o.category}::text, ${T(o.auditId)}) AS r`,
      );
      return (r.rows[0] as { r: 'ok' | 'mandatory' | 'not_member' }).r;
    },

    async scanTenants(exec: Executor): Promise<string[]> {
      const r = await exec.execute(sql`SELECT id FROM lms.notify_scan_tenants() AS id`);
      return (r.rows as { id: string }[]).map((x) => x.id);
    },

    async scanTenant(exec: Executor, tenantId: string, now: Date): Promise<Record<string, number>> {
      const r = await exec.execute(
        sql`SELECT lms.notify_scan_tenant(${T(tenantId)}, ${now.toISOString()}::timestamptz) AS out`,
      );
      return (r.rows[0] as { out: Record<string, number> }).out ?? {};
    },

    async purgeRead(exec: Executor, days: number, batch: number): Promise<number> {
      const r = await exec.execute(
        sql`SELECT lms.notify_purge_read(${days}::int, ${batch}::int) AS n`,
      );
      return Number((r.rows[0] as { n: number }).n);
    },

    // ---------------------------------------------------------------- platform admins (definer functions re-check the actor)
    async platformPage(
      exec: Executor,
      o: { actorUserId: string; after: string | null; limit: number; unread: boolean },
    ): Promise<NotificationRow[]> {
      const r = await exec.execute(
        sql`SELECT * FROM lms.platform_notifications_page(${T(o.actorUserId)}, ${T(o.after)}, ${o.limit}::int, ${o.unread})`,
      );
      return (r.rows as unknown as Omit<NotificationRow, 'category'>[]).map((x) => ({
        ...x,
        category: 'admin',
      }));
    },
    async platformUnread(
      exec: Executor,
      actorUserId: string,
    ): Promise<{ unread: number; newest: string | null }> {
      const r = await exec.execute(
        sql`SELECT * FROM lms.platform_notifications_unread(${T(actorUserId)})`,
      );
      const x = r.rows[0] as { unread: number; newest: string | null };
      return { unread: Number(x.unread), newest: x.newest };
    },
    async platformRead(exec: Executor, actorUserId: string, id: string | null): Promise<number> {
      const r = await exec.execute(
        sql`SELECT lms.platform_notifications_read(${T(actorUserId)}, ${T(id)}) AS n`,
      );
      return Number((r.rows[0] as { n: number }).n);
    },
  };
}
export type NotificationsRepository = ReturnType<typeof createNotificationsRepository>;

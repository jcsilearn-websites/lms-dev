import type pg from 'pg';
import type { TestApp } from './app';
import { deliverEmails } from './client';

// Shared helpers of the step 13 tests (notifications, outbox, scan).

/** The college's notification settings, merged into what is stored (quiet hours OFF unless a test says otherwise). */
export async function setNotifySettings(
  owner: pg.Pool,
  tenantId: string,
  value: Record<string, unknown>,
): Promise<void> {
  await owner.query(
    `INSERT INTO lms.tenant_settings (id, tenant_id, key, value)
     VALUES (lms.uuid_v7(), $1, 'notifications', $2::jsonb)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = lms.tenant_settings.value || EXCLUDED.value`,
    [tenantId, JSON.stringify(value)],
  );
}

export const quietOff = (owner: pg.Pool, tenantId: string) =>
  setNotifySettings(owner, tenantId, {
    quietHours: { enabled: false, start: '22:00', end: '07:00' },
  });

export interface NotificationDbRow {
  user_id: string;
  category: string;
  type: string;
  params: Record<string, unknown>;
  link: string | null;
  dedupe_key: string;
  read_at: Date | null;
}

export async function notificationsOf(
  owner: pg.Pool,
  userId: string,
  type?: string,
): Promise<NotificationDbRow[]> {
  const { rows } = await owner.query<NotificationDbRow>(
    `SELECT user_id, category, type, params, link, dedupe_key, read_at FROM lms.notifications
      WHERE user_id = $1 ${type ? 'AND type = $2' : ''} ORDER BY id`,
    type ? [userId, type] : [userId],
  );
  return rows;
}

export interface OutboxDbRow {
  id: string;
  tenant_id: string | null;
  user_id: string | null;
  to_email: string;
  category: string;
  template: string;
  params: Record<string, unknown>;
  status: string;
  run_after: Date;
  expires_at: Date | null;
  skip_reason: string | null;
  attempts: number;
  idempotency_key: string;
}

export async function outboxOf(
  owner: pg.Pool,
  where: { userId?: string; template?: string; tenantId?: string } = {},
): Promise<OutboxDbRow[]> {
  const cond: string[] = [];
  const args: unknown[] = [];
  if (where.userId) cond.push(`user_id = $${args.push(where.userId)}`);
  if (where.template) cond.push(`template = $${args.push(where.template)}`);
  if (where.tenantId) cond.push(`tenant_id = $${args.push(where.tenantId)}`);
  const { rows } = await owner.query<OutboxDbRow>(
    `SELECT * FROM lms.email_outbox ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''} ORDER BY created_at, id`,
    args,
  );
  return rows;
}

export async function participantOf(
  owner: pg.Pool,
  offeringId: string,
  userId: string,
): Promise<string> {
  const { rows } = await owner.query(
    `SELECT p.id FROM lms.course_participants p
       JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
      WHERE p.offering_id = $1 AND m.user_id = $2`,
    [offeringId, userId],
  );
  return rows[0].id as string;
}

/** Delivers the queued mail and returns what reached `to`. */
export async function mailTo(t: TestApp, to: string) {
  await deliverEmails(t);
  return t.mailer.sent.filter((m) => m.to === to);
}

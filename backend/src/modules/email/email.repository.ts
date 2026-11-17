import { sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';

// SQL only. The outbox, the suppression list and the provider events are reachable ONLY through the hardened definer
// functions of migration 0052 (lms_app has no privilege on those tables): every call here is ONE statement.

export interface ClaimRow {
  verdict: 'send' | 'deferred' | 'done' | 'suppressed' | 'skipped' | 'expired';
  tenantId: string | null;
  userId: string | null;
  toEmail: string | null;
  category: string | null;
  template: string | null;
  params: Record<string, unknown> | null;
  attempts: number | null;
  tenantSlug: string | null;
  tenantName: string | null;
  branding: { displayName?: string; primaryColor?: string } | null;
  emailFrom: string | null;
  fromName: string | null;
  replyTo: string | null;
  timeZone: string | null;
}

export interface SuppressionRow {
  id: string;
  email: string;
  reason: 'bounce' | 'complaint' | 'manual';
  detail: string | null;
  created_at: Date | string;
  user_id?: string;
  display_name?: string;
  provider?: string | null;
  source_tenant_slug?: string | null;
}

const T = (id: string | null) => sql`${id}::uuid`;

export function createEmailRepository() {
  return {
    async enqueueSecurity(
      exec: Executor,
      o: {
        tenantId: string | null;
        userId: string;
        template: string;
        params: Record<string, unknown>;
        key: string;
      },
    ): Promise<boolean> {
      const r = await exec.execute(
        sql`SELECT lms.email_enqueue_security(${T(o.tenantId)}, ${T(o.userId)}, ${o.template}::text,
                                              ${JSON.stringify(o.params)}::jsonb, ${o.key}::text) AS queued`,
      );
      return (r.rows[0] as { queued: boolean }).queued === true;
    },

    async claim(exec: Executor, outboxId: string): Promise<ClaimRow> {
      const r = await exec.execute(sql`SELECT * FROM lms.email_claim(${T(outboxId)})`);
      const x = r.rows[0] as Record<string, unknown>;
      return {
        verdict: x.verdict as ClaimRow['verdict'],
        tenantId: (x.tenant_id as string | null) ?? null,
        userId: (x.user_id as string | null) ?? null,
        toEmail: (x.to_email as string | null) ?? null,
        category: (x.category as string | null) ?? null,
        template: (x.template as string | null) ?? null,
        params: (x.params as Record<string, unknown> | null) ?? null,
        attempts: (x.attempts as number | null) ?? null,
        tenantSlug: (x.tenant_slug as string | null) ?? null,
        tenantName: (x.tenant_name as string | null) ?? null,
        branding: (x.branding as ClaimRow['branding']) ?? null,
        emailFrom: (x.email_from as string | null) ?? null,
        fromName: (x.from_name as string | null) ?? null,
        replyTo: (x.reply_to as string | null) ?? null,
        timeZone: (x.time_zone as string | null) ?? null,
      };
    },

    async mark(
      exec: Executor,
      o: {
        outboxId: string;
        outcome: 'sent' | 'retry' | 'dead' | 'skipped';
        provider: string | null;
        messageId: string | null;
        error: string | null;
      },
    ): Promise<void> {
      await exec.execute(
        sql`SELECT lms.email_mark(${T(o.outboxId)}, ${o.outcome}::text, ${o.provider}::text, ${o.messageId}::text,
                                  ${o.error}::text)`,
      );
    },

    async ingest(exec: Executor, provider: string, events: unknown[]): Promise<number> {
      const r = await exec.execute(
        sql`SELECT lms.email_webhook_ingest(${provider}::text, ${JSON.stringify(events)}::jsonb) AS n`,
      );
      return Number((r.rows[0] as { n: number }).n);
    },

    async myStatus(
      exec: Executor,
      userId: string,
    ): Promise<{ email: string; reason: string; created_at: Date | string } | null> {
      const r = await exec.execute(sql`SELECT * FROM lms.email_suppression_status(${T(userId)})`);
      return (r.rows[0] as { email: string; reason: string; created_at: Date | string }) ?? null;
    },

    async tenantList(
      exec: Executor,
      tenantId: string,
      after: string | null,
      limit: number,
    ): Promise<SuppressionRow[]> {
      const r = await exec.execute(
        sql`SELECT * FROM lms.email_suppressions_for_tenant(${T(tenantId)}, ${T(after)}, ${limit}::int)`,
      );
      return r.rows as unknown as SuppressionRow[];
    },

    async tenantClear(
      exec: Executor,
      o: { tenantId: string; actorUserId: string; id: string; auditId: string },
    ): Promise<'ok' | 'not_found'> {
      const r = await exec.execute(
        sql`SELECT lms.email_suppression_clear_tenant(${T(o.tenantId)}, ${T(o.actorUserId)}, ${T(o.id)},
                                                      ${T(o.auditId)}) AS r`,
      );
      return (r.rows[0] as { r: 'ok' | 'not_found' }).r;
    },

    async platformList(
      exec: Executor,
      actorUserId: string,
      after: string | null,
      limit: number,
    ): Promise<SuppressionRow[]> {
      const r = await exec.execute(
        sql`SELECT * FROM lms.platform_email_suppressions(${T(actorUserId)}, ${T(after)}, ${limit}::int)`,
      );
      return r.rows as unknown as SuppressionRow[];
    },

    async platformClear(
      exec: Executor,
      o: { actorUserId: string; id: string; auditId: string; ip: string | null },
    ): Promise<'ok' | 'not_found'> {
      const r = await exec.execute(
        sql`SELECT lms.platform_email_suppression_clear(${T(o.actorUserId)}, ${T(o.id)}, ${T(o.auditId)},
                                                        ${o.ip}::inet) AS r`,
      );
      return (r.rows[0] as { r: 'ok' | 'not_found' }).r;
    },

    async setSender(
      exec: Executor,
      o: {
        actorUserId: string;
        tenantId: string;
        from: string | null;
        auditId: string;
        ip: string | null;
      },
    ): Promise<'ok' | 'not_found'> {
      const r = await exec.execute(
        sql`SELECT lms.platform_set_email_sender(${T(o.actorUserId)}, ${T(o.tenantId)}, ${o.from}::text,
                                                 ${T(o.auditId)}, ${o.ip}::inet) AS r`,
      );
      return (r.rows[0] as { r: 'ok' | 'not_found' }).r;
    },

    async purge(exec: Executor, days: number, batch: number): Promise<number> {
      const r = await exec.execute(
        sql`SELECT lms.email_outbox_purge(${days}::int, ${batch}::int) AS n`,
      );
      return Number((r.rows[0] as { n: number }).n);
    },
  };
}
export type EmailRepository = ReturnType<typeof createEmailRepository>;

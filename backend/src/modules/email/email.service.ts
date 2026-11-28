import type { MyEmailStatus, Suppression, SuppressionPage } from '../../contracts';
import { can } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { ForbiddenError } from '../../core/errors';
import { DeferJobError } from '../../core/handlers';
import { buildOrigin } from '../../core/host';
import {
  type BounceWebhookAdapter,
  displayName,
  type EmailProvider,
  EmailSendError,
  type OutgoingEmail,
  type RateLimiter,
  render,
  TemplateError,
  type UnsubscribeTokens,
  type WebhookRequest,
} from '../../core/mail';
import { CircuitOpenError } from '../../core/resilience';
import { newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import {
  CollegeNotFoundError,
  SuppressionNotFoundError,
  UnknownWebhookProviderError,
  WebhookNotConfiguredError,
  WebhookSignatureError,
} from './email.errors';
import type { ClaimRow, EmailRepository, SuppressionRow } from './email.repository';

export interface EmailServiceConfig {
  baseDomain: string;
  secure: boolean;
  /** development: the port of the web app in links */
  publicPort: number | undefined;
  /** the From of mail without a verified college address */
  fromDefault: string;
  /** the product name in From names ("<College> via JCS iLearn") */
  fromName: string;
  unsubscribeTtlSeconds: number;
  outboxRetentionDays: number;
  purgeBatchSize: number;
}

/** The worker's way to mint the single-use tokens of security mail right before sending (auth module). */
export interface SecurityTokens {
  invite(tenantId: string, membershipId: string): Promise<{ token: string; days: number } | null>;
  reset(userId: string): Promise<{ token: string; minutes: number }>;
  /** the two-factor enrolment link; tenantId null = the admin host */
  mfaEnrol(userId: string, tenantId: string | null): Promise<{ token: string; minutes: number }>;
}

export interface SendJob {
  attempt: number;
  maxAttempts: number;
  signal?: AbortSignal;
}

const toIso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();
const MAX_PURGE_BATCHES = 100;

function suppression(r: SuppressionRow): Suppression {
  return {
    id: r.id,
    email: r.email,
    reason: r.reason,
    detail: r.detail ?? null,
    createdAt: toIso(r.created_at),
    ...(r.user_id ? { userId: r.user_id } : {}),
    ...(r.display_name ? { displayName: r.display_name } : {}),
    ...(r.provider !== undefined ? { provider: r.provider ?? null } : {}),
    ...(r.source_tenant_slug !== undefined ? { sourceCollege: r.source_tenant_slug ?? null } : {}),
  };
}

export function createEmailService(deps: {
  db: Pick<Database, 'withoutTenant'>;
  emailRepo: EmailRepository;
  provider: EmailProvider;
  rate: RateLimiter;
  unsubscribe: UnsubscribeTokens;
  webhooks: readonly BounceWebhookAdapter[];
  tokens: SecurityTokens;
  config: EmailServiceConfig;
  now?: () => number;
}) {
  const { db, emailRepo: repo, provider, config } = deps;
  const now = deps.now ?? Date.now;
  const portSuffix = config.publicPort ? `:${config.publicPort}` : '';
  const fromDomain = config.fromDefault.split('@')[1] ?? config.baseDomain;
  const adapters = new Map(deps.webhooks.map((a) => [a.provider, a]));

  const originFor = (slug: string | null): string =>
    buildOrigin(
      slug ? { kind: 'tenant', slug, portSuffix } : { kind: 'admin', portSuffix },
      config.baseDomain,
      config.secure,
    ) ?? '';

  function fromOf(row: ClaimRow): string {
    if (!row.tenantId) return `"${displayName(config.fromName)}" <${config.fromDefault}>`;
    const college = row.fromName ?? row.branding?.displayName ?? row.tenantName ?? config.fromName;
    return row.emailFrom
      ? `"${displayName(college)}" <${row.emailFrom}>`
      : `"${displayName(`${college} via ${config.fromName}`)}" <${config.fromDefault}>`;
  }

  /** Adds the freshly minted token of security mail; null = nothing to send any more (invite no longer pending). */
  async function paramsFor(row: ClaimRow): Promise<Record<string, unknown> | null> {
    const params = { ...(row.params ?? {}) };
    if (row.template === 'invite') {
      const membershipId = typeof params.membershipId === 'string' ? params.membershipId : null;
      if (!row.tenantId || !membershipId) return null;
      const minted = await deps.tokens.invite(row.tenantId, membershipId);
      return minted ? { ...params, token: minted.token, days: minted.days } : null;
    }
    if (row.template === 'password_reset') {
      if (!row.userId) return null;
      const minted = await deps.tokens.reset(row.userId);
      return { token: minted.token, minutes: minted.minutes };
    }
    if (row.template === 'mfa_enrol') {
      if (!row.userId) return null;
      const minted = await deps.tokens.mfaEnrol(row.userId, row.tenantId ?? null);
      return { token: minted.token, minutes: minted.minutes };
    }
    return params;
  }

  async function mark(
    outboxId: string,
    outcome: 'sent' | 'retry' | 'dead' | 'skipped',
    extra: { messageId?: string | null; error?: string | null } = {},
  ) {
    await db.withoutTenant((c) =>
      repo.mark(c, {
        outboxId,
        outcome,
        provider: provider.name,
        messageId: extra.messageId ?? null,
        error: extra.error ?? null,
      }),
    );
  }

  return {
    /**
     * The `email.send` job: claim (the database decides what changed since the event), mint a token for security mail,
     * render, respect the per-provider rate, hand over, record. A transient failure is recorded and re-thrown (the job queue
     * retries with backoff); a permanent one, an invalid template or the last attempt ends the row as `dead`.
     */
    async deliver(outboxId: string, job: SendJob): Promise<Record<string, number>> {
      const row = await db.withoutTenant((c) => repo.claim(c, outboxId));
      if (row.verdict !== 'send') return { [row.verdict]: 1 };
      const category = row.category ?? 'security';
      const origin = originFor(row.tenantSlug);
      let message: OutgoingEmail;
      try {
        const params = await paramsFor(row);
        if (!params) {
          await mark(outboxId, 'skipped', { error: 'invite_not_pending' });
          return { skipped: 1 };
        }
        const unsub =
          category !== 'security' && row.tenantId && row.userId
            ? deps.unsubscribe.sign({ tenantId: row.tenantId, userId: row.userId, category })
            : null;
        const rendered = render(row.template ?? '', params, {
          college: row.tenantId
            ? {
                name: row.branding?.displayName ?? row.tenantName ?? '',
                color: row.branding?.primaryColor ?? null,
              }
            : null,
          origin,
          timeZone: row.timeZone ?? 'UTC',
          category,
          unsubscribeUrl: unsub ? `${origin}/unsubscribe?t=${unsub}` : null,
        });
        message = {
          from: fromOf(row),
          to: row.toEmail ?? '',
          replyTo: row.replyTo ?? undefined,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          headers: {
            'Auto-Submitted': 'auto-generated',
            ...(unsub
              ? {
                  'List-Unsubscribe': `<${origin}/api/notifications/unsubscribe/one-click?t=${unsub}>`,
                  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                }
              : {}),
          },
          messageId: `<${outboxId}@${fromDomain}>`,
        };
      } catch (err) {
        if (err instanceof TemplateError) {
          await mark(outboxId, 'dead', { error: err.message });
          return { dead: 1 };
        }
        throw err;
      }

      await deps.rate.take(job.signal);
      try {
        const result = await provider.send(message);
        await mark(outboxId, 'sent', { messageId: result.providerMessageId });
        return { sent: 1 };
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          // The provider is known to be down: the call was NOT made. Put the row back and let the queue run the job again when a
          // trial call is due, with NO attempt charged: an outage of any length must not dead-letter mail. A little jitter keeps
          // the whole backlog from arriving at the half-open circuit together.
          await mark(outboxId, 'retry', { error: 'provider unavailable (circuit open)' });
          const wait = Math.ceil(err.retryAfterMs / 1000) + Math.floor(Math.random() * 10);
          throw new DeferJobError(Math.max(5, wait), `circuit ${err.circuit} is open`);
        }
        const text = err instanceof Error ? err.message : String(err);
        const permanent = err instanceof EmailSendError && err.permanent;
        if (permanent || job.attempt >= job.maxAttempts) {
          await mark(outboxId, 'dead', { error: text });
          return { dead: 1 };
        }
        await mark(outboxId, 'retry', { error: text });
        throw err;
      }
    },

    /** Security mail (reset request, an imported member's invite): ONE definer call; false = not queued. */
    async enqueueSecurity(o: {
      tenantId: string | null;
      userId: string;
      template: 'invite' | 'password_reset';
      params: Record<string, unknown>;
      key: string;
    }): Promise<boolean> {
      return db.withoutTenant((c) => repo.enqueueSecurity(c, o));
    },

    // ---------------------------------------------------------------- provider webhooks
    async ingestWebhook(providerName: string, req: WebhookRequest): Promise<number> {
      const adapter = adapters.get(providerName);
      if (!adapter) throw new UnknownWebhookProviderError();
      const verdict = adapter.verifyAndParse(req, now());
      if (!verdict.ok) {
        if (verdict.reason === 'not_configured') throw new WebhookNotConfiguredError();
        throw new WebhookSignatureError();
      }
      if (verdict.events.length === 0) return 0;
      return db.withoutTenant((c) => repo.ingest(c, adapter.provider, verdict.events));
    },

    // ---------------------------------------------------------------- suppressions
    /** The banner: is MY address suppressed? (both hosts) */
    async myStatus(ctx: RequestContext): Promise<MyEmailStatus> {
      const r = await db.withoutTenant((c) => repo.myStatus(c, ctx.userId));
      return r
        ? {
            email: r.email,
            suppressed: true,
            reason: r.reason as MyEmailStatus['reason'],
            since: toIso(r.created_at),
          }
        : { email: ctx.email, suppressed: false, reason: null, since: null };
    },

    async tenantList(
      ctx: RequestContext,
      q: { after?: string | undefined; limit?: number | undefined },
    ): Promise<SuppressionPage> {
      if (!ctx.tenantId || !can(ctx, 'email.suppression.manage')) throw new ForbiddenError();
      const tenantId = ctx.tenantId;
      const limit = q.limit ?? 50;
      const rows = await db.withoutTenant((c) =>
        repo.tenantList(c, tenantId, q.after ?? null, limit + 1),
      );
      const items = rows.slice(0, limit).map(suppression);
      return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
    },

    async tenantClear(ctx: RequestContext, id: string): Promise<void> {
      if (!ctx.tenantId || !can(ctx, 'email.suppression.manage')) throw new ForbiddenError();
      const tenantId = ctx.tenantId;
      const r = await db.withoutTenant((c) =>
        repo.tenantClear(c, { tenantId, actorUserId: ctx.userId, id, auditId: newId() }),
      );
      if (r !== 'ok') throw new SuppressionNotFoundError();
    },

    async platformList(
      ctx: RequestContext,
      q: { after?: string | undefined; limit?: number | undefined },
    ): Promise<SuppressionPage> {
      if (ctx.tenantId !== null || !can(ctx, 'platform.email.manage')) throw new ForbiddenError();
      const limit = q.limit ?? 50;
      const rows = await db.withoutTenant((c) =>
        repo.platformList(c, ctx.userId, q.after ?? null, limit + 1),
      );
      const items = rows.slice(0, limit).map(suppression);
      return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
    },

    async platformClear(ctx: RequestContext, id: string): Promise<void> {
      if (ctx.tenantId !== null || !can(ctx, 'platform.email.manage')) throw new ForbiddenError();
      const r = await db.withoutTenant((c) =>
        repo.platformClear(c, { actorUserId: ctx.userId, id, auditId: newId(), ip: ctx.ip }),
      );
      if (r !== 'ok') throw new SuppressionNotFoundError();
    },

    /** A college's verified From address (null = back to the JCS default sender). Platform admins only, audited. */
    async setSender(ctx: RequestContext, tenantId: string, from: string | null): Promise<void> {
      if (ctx.tenantId !== null || !can(ctx, 'platform.email.manage')) throw new ForbiddenError();
      const r = await db.withoutTenant((c) =>
        repo.setSender(c, {
          actorUserId: ctx.userId,
          tenantId,
          from: from ? from.trim().toLowerCase() : null,
          auditId: newId(),
          ip: ctx.ip,
        }),
      );
      if (r !== 'ok') throw new CollegeNotFoundError();
    },

    // ---------------------------------------------------------------- retention
    async purge(): Promise<number> {
      let total = 0;
      for (let i = 0; i < MAX_PURGE_BATCHES; i++) {
        const n = await db.withoutTenant((c) =>
          repo.purge(c, config.outboxRetentionDays, config.purgeBatchSize),
        );
        total += n;
        if (n < config.purgeBatchSize) break;
      }
      return total;
    },
  };
}
export type EmailService = ReturnType<typeof createEmailService>;

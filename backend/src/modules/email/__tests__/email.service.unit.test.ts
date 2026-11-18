import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../../test/fakes';
import type { RequestContext } from '../../../core/context';
import { ForbiddenError } from '../../../core/errors';
import {
  type BounceWebhookAdapter,
  createCapturingProvider,
  createUnsubscribeTokens,
  EmailSendError,
} from '../../../core/mail';
import { newId } from '../../../core/uuid';
import {
  SuppressionNotFoundError,
  UnknownWebhookProviderError,
  WebhookNotConfiguredError,
  WebhookSignatureError,
} from '../email.errors';
import type { ClaimRow, EmailRepository } from '../email.repository';
import { createEmailService } from '../email.service';

// The send pipeline with a fake repository and the capturing provider: what is sent for each claim verdict, minting of
// security tokens, From / Message-ID / unsubscribe headers, failure handling (retry vs dead), webhooks, permissions.

const T = newId();
const U = newId();
const OUT = newId();

const claim = (over: Partial<ClaimRow> = {}): ClaimRow => ({
  verdict: 'send',
  tenantId: T,
  userId: U,
  toEmail: 'learner@alpha.test',
  category: 'learning_grades',
  template: 'grade_released',
  params: {
    course: 'Maths',
    item: 'Quiz 1',
    kind: 'assessment',
    hasFeedback: false,
    link: '/offerings/o',
  },
  attempts: 1,
  tenantSlug: 'alpha',
  tenantName: 'Alpha College',
  branding: { displayName: 'Alpha', primaryColor: '#1d4ed8' },
  emailFrom: null,
  fromName: null,
  replyTo: 'office@alpha.test',
  timeZone: 'Asia/Kolkata',
  ...over,
});

const fakeRepo = (row: ClaimRow, o: Partial<Record<keyof EmailRepository, unknown>> = {}) =>
  ({
    claim: vi.fn(async () => row),
    mark: vi.fn(async () => undefined),
    enqueueSecurity: vi.fn(async () => true),
    ingest: vi.fn(async (_c: unknown, _p: string, ev: unknown[]) => ev.length),
    myStatus: vi.fn(async () => null),
    tenantList: vi.fn(async () => []),
    tenantClear: vi.fn(async () => 'ok'),
    platformList: vi.fn(async () => []),
    platformClear: vi.fn(async () => 'ok'),
    setSender: vi.fn(async () => 'ok'),
    purge: vi.fn(async () => 0),
    ...o,
  }) as unknown as EmailRepository & Record<string, ReturnType<typeof vi.fn>>;

function make(
  row: ClaimRow,
  o: Parameters<typeof fakeRepo>[1] = {},
  webhooks: BounceWebhookAdapter[] = [],
) {
  const repo = fakeRepo(row, o);
  const provider = createCapturingProvider();
  const tokens = {
    invite: vi.fn(async () => ({ token: 'INVITE-TOKEN', days: 7 })),
    reset: vi.fn(async () => ({ token: 'RESET-TOKEN', minutes: 30 })),
  };
  const service = createEmailService({
    db: fakeDb(),
    emailRepo: repo,
    provider,
    rate: { take: async () => {} },
    unsubscribe: createUnsubscribeTokens('k'.repeat(64), { ttlSeconds: 3600 }),
    webhooks,
    tokens,
    config: {
      baseDomain: 'lms.example',
      secure: true,
      publicPort: undefined,
      fromDefault: 'no-reply@notify.lms.example',
      fromName: 'JCS iLearn',
      unsubscribeTtlSeconds: 3600,
      outboxRetentionDays: 30,
      purgeBatchSize: 1000,
    },
  });
  return { service, repo, provider, tokens };
}
const job = { attempt: 1, maxAttempts: 5 };
const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
  userId: U,
  tenantId: T,
  role: 'institution_admin',
  isPlatformAdmin: false,
  sessionId: 's',
  email: 'a@alpha.test',
  displayName: 'A',
  ip: null,
  userAgent: null,
  ...over,
});

describe('deliver', () => {
  it('renders, sends with From / Reply-To / Message-ID / one-click unsubscribe, and marks sent', async () => {
    const { service, repo, provider } = make(claim());
    expect(await service.deliver(OUT, job)).toEqual({ sent: 1 });
    const [m] = provider.sent;
    expect(m?.from).toBe('"Alpha via JCS iLearn" <no-reply@notify.lms.example>');
    expect(m?.replyTo).toBe('office@alpha.test');
    expect(m?.messageId).toBe(`<${OUT}@notify.lms.example>`);
    expect(m?.headers['List-Unsubscribe']).toMatch(
      /^<https:\/\/alpha\.lms\.example\/api\/notifications\/unsubscribe\/one-click\?t=v2\.k0\./,
    );
    expect(m?.text).toContain('https://alpha.lms.example/offerings/o');
    expect(repo.mark).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'sent', provider: 'capturing' }),
    );
  });

  it('a verified college address is the From (no "via")', async () => {
    const { service, provider } = make(
      claim({ emailFrom: 'lms@alpha.edu', fromName: 'Alpha Exams Office' }),
    );
    await service.deliver(OUT, job);
    expect(provider.sent[0]?.from).toBe('"Alpha Exams Office" <lms@alpha.edu>');
  });

  it('every non-send verdict sends nothing', async () => {
    for (const verdict of ['done', 'deferred', 'suppressed', 'skipped', 'expired'] as const) {
      const { service, provider, repo } = make(claim({ verdict }));
      expect(await service.deliver(OUT, job)).toEqual({ [verdict]: 1 });
      expect(provider.sent).toEqual([]);
      expect(repo.mark).not.toHaveBeenCalled();
    }
  });

  it('security mail: the token is minted at send time; no unsubscribe header; an invite no longer pending is skipped', async () => {
    const reset = make(claim({ category: 'security', template: 'password_reset', params: {} }));
    await reset.service.deliver(OUT, job);
    expect(reset.tokens.reset).toHaveBeenCalledWith(U);
    expect(reset.provider.sent[0]?.text).toContain(
      'https://alpha.lms.example/reset-password?token=RESET-TOKEN',
    );
    expect(reset.provider.sent[0]?.headers['List-Unsubscribe']).toBeUndefined();

    const inv = make(
      claim({ category: 'security', template: 'invite', params: { membershipId: newId() } }),
    );
    inv.tokens.invite.mockResolvedValueOnce(null as never);
    expect(await inv.service.deliver(OUT, job)).toEqual({ skipped: 1 });
    expect(inv.provider.sent).toEqual([]);
    expect(inv.repo.mark).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'skipped' }),
    );
  });

  it('admin-host mail (no college) links to the admin host and has no unsubscribe', async () => {
    const { service, provider } = make(
      claim({
        tenantId: null,
        tenantSlug: null,
        category: 'security',
        template: 'password_changed',
        params: {},
      }),
    );
    await service.deliver(OUT, job);
    expect(provider.sent[0]?.from).toBe('"JCS iLearn" <no-reply@notify.lms.example>');
    expect(provider.sent[0]?.text).toContain('https://admin.lms.example/forgot-password');
  });

  it('a transient failure is recorded and re-thrown (the job retries); permanent or last attempt = dead, no throw', async () => {
    const a = make(claim());
    a.provider.failNext(1, new Error('ECONNRESET'));
    await expect(a.service.deliver(OUT, job)).rejects.toThrow('ECONNRESET');
    expect(a.repo.mark).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'retry', error: 'ECONNRESET' }),
    );

    const b = make(claim());
    b.provider.failNext(1, new EmailSendError('550 no such user', true));
    expect(await b.service.deliver(OUT, job)).toEqual({ dead: 1 });

    const c = make(claim());
    c.provider.failNext(1, new Error('timeout'));
    expect(await c.service.deliver(OUT, { attempt: 5, maxAttempts: 5 })).toEqual({ dead: 1 });
  });

  it('params a template does not declare (e.g. a score) make the row dead instead of an email', async () => {
    const { service, provider, repo } = make(
      claim({
        params: {
          course: 'M',
          item: 'Q',
          kind: 'assessment',
          hasFeedback: false,
          link: '/o',
          score: 87,
        },
      }),
    );
    expect(await service.deliver(OUT, job)).toEqual({ dead: 1 });
    expect(provider.sent).toEqual([]);
    expect(repo.mark).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'dead' }),
    );
  });
});

describe('webhooks', () => {
  const adapter = (
    verdict: ReturnType<BounceWebhookAdapter['verifyAndParse']>,
  ): BounceWebhookAdapter => ({
    provider: 'acme',
    verifyAndParse: () => verdict,
  });
  const req = { headers: {}, rawBody: Buffer.from('[]') };

  it('unknown provider 404, not configured 503, bad signature 401, ok -> ingested', async () => {
    await expect(make(claim()).service.ingestWebhook('acme', req)).rejects.toThrow(
      UnknownWebhookProviderError,
    );
    await expect(
      make(claim(), {}, [adapter({ ok: false, reason: 'not_configured' })]).service.ingestWebhook(
        'acme',
        req,
      ),
    ).rejects.toThrow(WebhookNotConfiguredError);
    for (const reason of ['bad_signature', 'stale', 'missing_signature', 'malformed'] as const) {
      await expect(
        make(claim(), {}, [adapter({ ok: false, reason })]).service.ingestWebhook('acme', req),
      ).rejects.toThrow(WebhookSignatureError);
    }
    const ev = {
      id: 'e',
      kind: 'bounce' as const,
      email: 'x@y.z',
      messageId: null,
      outboxId: null,
      occurredAt: null,
      detail: null,
    };
    const ok = make(claim(), {}, [adapter({ ok: true, events: [ev] })]);
    expect(await ok.service.ingestWebhook('acme', req)).toBe(1);
    expect(ok.repo.ingest).toHaveBeenCalledWith(expect.anything(), 'acme', [ev]);
  });
});

describe('suppressions and the sender', () => {
  it('the college list needs the permission and a college; clearing an unknown entry is 404', async () => {
    const { service } = make(claim(), { tenantClear: vi.fn(async () => 'not_found') });
    await expect(service.tenantList(ctx({ role: 'member' }), {})).rejects.toThrow(ForbiddenError);
    await expect(service.tenantList(ctx({ tenantId: null }), {})).rejects.toThrow(ForbiddenError);
    await expect(service.tenantClear(ctx(), newId())).rejects.toThrow(SuppressionNotFoundError);
  });
  it('platform operations need a platform admin on the admin host', async () => {
    const { service, repo } = make(claim());
    await expect(service.setSender(ctx(), T, 'x@y.z')).rejects.toThrow(ForbiddenError);
    await service.setSender(
      ctx({ tenantId: null, role: null, isPlatformAdmin: true }),
      T,
      ' LMS@Alpha.EDU ',
    );
    expect(repo.setSender).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: 'lms@alpha.edu' }),
    );
  });
  it('my status: not suppressed shows my own address', async () => {
    const { service } = make(claim());
    expect(await service.myStatus(ctx())).toEqual({
      email: 'a@alpha.test',
      suppressed: false,
      reason: null,
      since: null,
    });
  });
});

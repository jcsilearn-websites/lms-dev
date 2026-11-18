import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createTokenBucket } from '../rate';
import { createSendgridProvider, parseAddress } from '../sendgrid';
import { createSendgridWebhookAdapter } from '../sendgrid-webhook';
import { smtpErrorIsPermanent } from '../smtp';
import { EmailSendError, type OutgoingEmail } from '../types';
import { createUnsubscribeTokens, unsubscribeKey } from '../unsubscribe';

const T = '01a1e4a2-0000-7000-8000-000000000001';
const U = '01a1e4a2-0000-7000-8000-000000000002';

describe('unsubscribe tokens', () => {
  const now = 1_800_000_000_000;
  const tokens = createUnsubscribeTokens('k'.repeat(64), { ttlSeconds: 3600, now: () => now });

  it('a valid token round-trips its claims', () => {
    const tok = tokens.sign({ tenantId: T, userId: U, category: 'learning_grades' });
    expect(tok).toMatch(/^v2\.k0\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(tokens.verify(tok)).toEqual({
      ok: true,
      claims: { tenantId: T, userId: U, category: 'learning_grades', exp: now / 1000 + 3600 },
    });
  });
  it('a changed payload, a changed MAC or another key is forged; garbage is malformed; an old one expired', () => {
    const tok = tokens.sign({ tenantId: T, userId: U, category: 'learning_grades' });
    const [v, kid, payload, mac] = tok.split('.') as [string, string, string, string];
    const other = Buffer.from(
      JSON.stringify({ t: T, u: U, c: 'learning_content', e: now / 1000 + 3600 }),
    ).toString('base64url');
    expect(tokens.verify(`${v}.${kid}.${other}.${mac}`)).toEqual({ ok: false, reason: 'forged' });
    expect(tokens.verify(`${v}.${kid}.${payload}.${mac.slice(0, -1)}A`)).toMatchObject({
      ok: false,
      reason: 'forged',
    });
    const otherKey = createUnsubscribeTokens('z'.repeat(64), { ttlSeconds: 3600, now: () => now });
    expect(otherKey.verify(tok)).toMatchObject({ ok: false, reason: 'forged' });
    expect(tokens.verify('nonsense')).toEqual({ ok: false, reason: 'malformed' });
    expect(tokens.verify(`v2.${payload}.${mac}`)).toEqual({ ok: false, reason: 'malformed' });
    const later = createUnsubscribeTokens('k'.repeat(64), {
      ttlSeconds: 3600,
      now: () => now + 3_601_000,
    });
    expect(later.verify(tok)).toEqual({ ok: false, reason: 'expired' });
  });
  it('the key is the configured secret, else derived from the storage key (own label)', () => {
    expect(unsubscribeKey({ notifySecret: 'n'.repeat(40), storageSecret: 's'.repeat(40) })).toBe(
      'n'.repeat(40),
    );
    const derived = unsubscribeKey({ storageSecret: 's'.repeat(40) });
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    expect(derived).not.toContain('s'.repeat(10));
  });
});

describe('the send-rate limit (token bucket per worker process)', () => {
  it('lets a burst of one second through, then spaces the rest at the rate, in order', async () => {
    let clock = 0;
    const waits: number[] = [];
    const bucket = createTokenBucket(2, {
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    for (let i = 0; i < 5; i++) await bucket.take();
    expect(waits).toEqual([500, 500, 500]);
    expect(clock).toBe(1500);
  });
  it('an aborted wait rejects', async () => {
    const bucket = createTokenBucket(0.1);
    await bucket.take();
    const ac = new AbortController();
    const p = bucket.take(ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow('aborted');
  });
});

describe('SMTP error classification', () => {
  it('5xx replies are permanent; 4xx and network errors are retried', () => {
    expect(smtpErrorIsPermanent({ responseCode: 550 })).toBe(true);
    expect(smtpErrorIsPermanent({ responseCode: 421 })).toBe(false);
    expect(smtpErrorIsPermanent(new Error('ECONNRESET'))).toBe(false);
  });
});

const email: OutgoingEmail = {
  from: '"Alpha College via JCS iLearn" <no-reply@notify.example>',
  to: 'learner@alpha.example',
  replyTo: 'office@alpha.example',
  subject: 'Due in 1 hour: Lab 3',
  text: 'text',
  html: '<p>html</p>',
  headers: {
    'List-Unsubscribe': '<https://alpha.example/api/notifications/unsubscribe/one-click?t=v1.x.y>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  },
  messageId: '<01a1e4a2-0000-7000-8000-000000000009@notify.example>',
};

describe('SendGrid provider (HTTP API, no SDK)', () => {
  it('sends our headers, the outbox id as a custom arg, no tracking; returns X-Message-Id', async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 202, headers: { 'x-message-id': 'sg-123' } }),
    );
    const p = createSendgridProvider({
      apiKey: 'SG.key',
      apiUrl: 'https://api.eu.sendgrid.com/',
      timeoutMs: 1000,
      fetch,
    });
    await expect(p.send(email)).resolves.toEqual({ providerMessageId: 'sg-123' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.eu.sendgrid.com/v3/mail/send');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer SG.key');
    const body = JSON.parse(String(init.body));
    expect(body.from).toEqual({
      email: 'no-reply@notify.example',
      name: 'Alpha College via JCS iLearn',
    });
    expect(body.reply_to).toEqual({ email: 'office@alpha.example' });
    expect(body.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(body.headers['Message-ID']).toBe(email.messageId);
    expect(body.custom_args).toEqual({ outbox_id: '01a1e4a2-0000-7000-8000-000000000009' });
    expect(body.tracking_settings.click_tracking.enable).toBe(false);
  });
  it('400 is permanent; 429 / 5xx / network are retried', async () => {
    const make = (status: number) =>
      createSendgridProvider({
        apiKey: 'k',
        apiUrl: 'https://api.sendgrid.com',
        timeoutMs: 1000,
        fetch: vi.fn(async () => new Response('{"errors":[]}', { status })),
      });
    await expect(make(400).send(email)).rejects.toMatchObject({ permanent: true });
    await expect(make(429).send(email)).rejects.toMatchObject({ permanent: false });
    await expect(make(503).send(email)).rejects.toMatchObject({ permanent: false });
    const down = createSendgridProvider({
      apiKey: 'k',
      apiUrl: 'https://api.sendgrid.com',
      timeoutMs: 1000,
      fetch: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    });
    await expect(down.send(email)).rejects.toBeInstanceOf(EmailSendError);
  });
  it('parseAddress', () => {
    expect(parseAddress('a@b.c')).toEqual({ email: 'a@b.c' });
    expect(parseAddress('"X Y" <a@b.c>')).toEqual({ email: 'a@b.c', name: 'X Y' });
  });
});

describe('SendGrid signed event webhook adapter', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const adapter = createSendgridWebhookAdapter({ publicKey: pem, toleranceSeconds: 300 });
  const now = 1_800_000_000_000;
  const req = (body: unknown, tsSec = now / 1000, key = privateKey) => {
    const raw = Buffer.from(JSON.stringify(body));
    const ts = String(tsSec);
    return {
      headers: {
        'x-twilio-email-event-webhook-signature': sign(
          'sha256',
          Buffer.concat([Buffer.from(ts), raw]),
          {
            key,
            dsaEncoding: 'der',
          },
        ).toString('base64'),
        'x-twilio-email-event-webhook-timestamp': ts,
      },
      rawBody: raw,
    };
  };

  it('verifies and normalises: hard bounce, blocked (= deferred), spam report, dropped bounced address, delivered', () => {
    const v = adapter.verifyAndParse(
      req([
        {
          sg_event_id: 'e1',
          event: 'bounce',
          type: 'bounce',
          email: 'A@X.TEST',
          sg_message_id: 'abc.filter0',
          timestamp: 1,
          outbox_id: '01a1e4a2-0000-7000-8000-000000000009',
        },
        { sg_event_id: 'e2', event: 'bounce', type: 'blocked', email: 'b@x.test' },
        { sg_event_id: 'e3', event: 'spamreport', email: 'c@x.test' },
        { sg_event_id: 'e4', event: 'dropped', reason: 'Bounced Address', email: 'd@x.test' },
        { sg_event_id: 'e5', event: 'open', email: 'e@x.test' },
        { event: 'bounce', email: 'no-id@x.test' },
      ]),
      now,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.events.map((e) => [e.id, e.kind, e.email])).toEqual([
      ['e1', 'bounce', 'a@x.test'],
      ['e2', 'deferred', 'b@x.test'],
      ['e3', 'complaint', 'c@x.test'],
      ['e4', 'bounce', 'd@x.test'],
      ['e5', 'other', 'e@x.test'],
    ]);
    expect(v.events[0]).toMatchObject({
      messageId: 'abc',
      outboxId: '01a1e4a2-0000-7000-8000-000000000009',
    });
  });
  it('refuses a wrong key, a changed body, an old timestamp, missing headers; no key configured = not configured', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    expect(adapter.verifyAndParse(req([], now / 1000, other), now)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    const r = req([{ sg_event_id: 'x', event: 'bounce', email: 'a@b.c' }]);
    expect(adapter.verifyAndParse({ ...r, rawBody: Buffer.from('[]') }, now)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(adapter.verifyAndParse(req([], now / 1000 - 301), now)).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(adapter.verifyAndParse({ headers: {}, rawBody: Buffer.from('[]') }, now)).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
    expect(
      createSendgridWebhookAdapter({ publicKey: undefined, toleranceSeconds: 300 }).verifyAndParse(
        req([]),
        now,
      ),
    ).toEqual({ ok: false, reason: 'not_configured' });
    const notArray = req({ not: 'an array' });
    expect(adapter.verifyAndParse(notArray, now)).toEqual({ ok: false, reason: 'malformed' });
  });
});

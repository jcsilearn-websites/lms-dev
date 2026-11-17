import { createPublicKey, type KeyObject, verify } from 'node:crypto';
import {
  type BounceWebhookAdapter,
  type EmailEventKind,
  header,
  type NormalizedEmailEvent,
} from './webhooks';

/**
 * SendGrid Signed Event Webhook. SendGrid signs `timestamp + raw body` with ECDSA P-256 (SHA-256, DER signature, base64) and
 * sends the signature and timestamp in two headers; we verify with the PUBLIC key from the SendGrid console
 * (SENDGRID_WEBHOOK_PUBLIC_KEY, base64 DER / SPKI, or PEM). A timestamp older than `toleranceSeconds` is refused (replay).
 */
export const SIGNATURE_HEADER = 'x-twilio-email-event-webhook-signature';
export const TIMESTAMP_HEADER = 'x-twilio-email-event-webhook-timestamp';

function loadKey(value: string): KeyObject {
  const v = value.trim();
  if (v.startsWith('-----BEGIN')) return createPublicKey(v);
  return createPublicKey({ key: Buffer.from(v, 'base64'), format: 'der', type: 'spki' });
}

interface SendgridEvent {
  event?: string;
  type?: string;
  reason?: string;
  email?: string;
  sg_event_id?: string;
  sg_message_id?: string;
  timestamp?: number;
  outbox_id?: string;
}

function kindOf(e: SendgridEvent): EmailEventKind {
  switch (e.event) {
    case 'bounce':
      // 'blocked' is a temporary refusal (reputation, greylisting): not a dead address
      return e.type === 'blocked' ? 'deferred' : 'bounce';
    case 'spamreport':
      return 'complaint';
    case 'delivered':
      return 'delivered';
    case 'deferred':
      return 'deferred';
    case 'dropped':
      // SendGrid drops what is on ITS suppression lists: a known bounced / invalid address is a bounce for us too
      return /bounced address|invalid/i.test(e.reason ?? '') ? 'bounce' : 'dropped';
    default:
      return 'other';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSendgridWebhookAdapter(opts: {
  publicKey: string | undefined;
  toleranceSeconds: number;
}): BounceWebhookAdapter {
  const key = opts.publicKey ? loadKey(opts.publicKey) : null;
  return {
    provider: 'sendgrid',
    verifyAndParse(req, nowMs) {
      if (!key) return { ok: false, reason: 'not_configured' };
      const signature = header(req.headers, SIGNATURE_HEADER);
      const timestamp = header(req.headers, TIMESTAMP_HEADER);
      if (!signature || !timestamp) return { ok: false, reason: 'missing_signature' };
      const ts = Number(timestamp);
      if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > opts.toleranceSeconds) {
        return { ok: false, reason: 'stale' };
      }
      let valid = false;
      try {
        valid = verify(
          'sha256',
          Buffer.concat([Buffer.from(timestamp, 'utf8'), req.rawBody]),
          { key, dsaEncoding: 'der' },
          Buffer.from(signature, 'base64'),
        );
      } catch {
        valid = false;
      }
      if (!valid) return { ok: false, reason: 'bad_signature' };
      let parsed: unknown;
      try {
        parsed = JSON.parse(req.rawBody.toString('utf8'));
      } catch {
        return { ok: false, reason: 'malformed' };
      }
      if (!Array.isArray(parsed)) return { ok: false, reason: 'malformed' };
      const events: NormalizedEmailEvent[] = [];
      for (const raw of parsed.slice(0, 1000) as SendgridEvent[]) {
        if (!raw || typeof raw !== 'object' || !raw.sg_event_id || !raw.email) continue;
        events.push({
          id: String(raw.sg_event_id).slice(0, 300),
          kind: kindOf(raw),
          email: String(raw.email).toLowerCase().slice(0, 320),
          // sg_message_id = "<X-Message-Id>.<filter...>": the part before the first dot is what the send call returned
          messageId: raw.sg_message_id ? (String(raw.sg_message_id).split('.')[0] ?? null) : null,
          outboxId: raw.outbox_id && UUID.test(raw.outbox_id) ? raw.outbox_id : null,
          occurredAt:
            typeof raw.timestamp === 'number' ? new Date(raw.timestamp * 1000).toISOString() : null,
          detail: (raw.type ?? raw.reason ?? null)?.toString().slice(0, 300) ?? null,
        });
      }
      return { ok: true, events };
    },
  };
}

/**
 * Bounce / complaint webhooks behind ONE small interface: an adapter verifies the provider's signature over the RAW body and
 * turns the provider's events into normalized ones. Business code (the suppression list) only ever sees NormalizedEmailEvent,
 * so another provider is a new adapter file plus one line in the registry, nothing else:
 *   - Amazon SES: SNS notifications (verify the SNS message signature against the AWS signing certificate, whose URL must be on
 *     sns.<region>.amazonaws.com; confirm the subscription once), Bounce.bounceType = Permanent -> bounce, Complaint -> complaint.
 *   - Zoho ZeptoMail: webhook with a per-webhook secret (HMAC) header; hardbounce -> bounce, spam complaint -> complaint.
 * SMTP stays first-class: the provider BEHIND the SMTP relay posts its webhook to /api/email/webhooks/<its adapter>.
 */
export type EmailEventKind =
  | 'bounce'
  | 'complaint'
  | 'delivered'
  | 'deferred'
  | 'dropped'
  | 'other';

export interface NormalizedEmailEvent {
  /** the provider's unique id for the event (a replay is recognised by it) */
  id: string;
  kind: EmailEventKind;
  email: string;
  /** the provider's message id, if the event carries one */
  messageId: string | null;
  /** our outbox id, if the provider echoes custom arguments */
  outboxId: string | null;
  occurredAt: string | null;
  /** short provider text (bounce type / reason); never the message content */
  detail: string | null;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}

export type WebhookVerdict =
  | { ok: true; events: NormalizedEmailEvent[] }
  | {
      ok: false;
      reason: 'missing_signature' | 'bad_signature' | 'stale' | 'malformed' | 'not_configured';
    };

export interface BounceWebhookAdapter {
  /** the path segment: POST /api/email/webhooks/<provider> */
  readonly provider: string;
  verifyAndParse(req: WebhookRequest, nowMs: number): WebhookVerdict;
}

export const header = (h: WebhookRequest['headers'], name: string): string | undefined => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Email delivery behind one interface. Business code never names a vendor: it writes an outbox row (in SQL, in the same
 * transaction as the event) and the `email.send` worker hands the rendered message to whichever EmailProvider the
 * environment chose (EMAIL_PROVIDER = smtp | sendgrid | console | file | none). See docs/adr/0021-notifications-email.md.
 */
export interface OutgoingEmail {
  /** RFC 5322 From, already formatted: `"Name" <address>` */
  from: string;
  to: string;
  replyTo?: string | undefined;
  subject: string;
  text: string;
  html: string;
  /** extra headers: List-Unsubscribe, List-Unsubscribe-Post, Auto-Submitted */
  headers: Record<string, string>;
  /** deterministic `<outbox-id@domain>`: a resend after a crash carries the same id, so receivers collapse it */
  messageId: string;
}

export interface SendResult {
  /** the provider's id for the message (webhooks refer to it); null when the provider gives none */
  providerMessageId: string | null;
}

export interface EmailProvider {
  readonly name: string;
  send(email: OutgoingEmail): Promise<SendResult>;
}

/**
 * A failure the provider reported. `permanent` = retrying cannot help (address rejected, request invalid, sender not
 * verified): the outbox row goes straight to `dead`. Anything else is retried with backoff by the job queue.
 */
export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

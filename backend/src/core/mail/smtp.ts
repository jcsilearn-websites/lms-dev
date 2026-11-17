import { type EmailProvider, EmailSendError } from './types';

/**
 * SMTP: works with almost every provider (Amazon SES SMTP, Zoho ZeptoMail, Mailgun, Postmark, SendGrid SMTP, Google Workspace
 * relay, a college's own server). nodemailer (pinned exactly, no dependencies of its own) is loaded only when this provider is
 * chosen. TLS is required unless SMTP_TLS=off, which the env policy refuses in production.
 */
export interface SmtpConfig {
  host: string;
  port: number;
  /** 'implicit' = TLS from the first byte (465); 'starttls' = upgrade required (587); 'off' = dev only */
  tls: 'implicit' | 'starttls' | 'off';
  user: string | undefined;
  password: string | undefined;
  /** connection pool: messages are sent over a few kept-alive connections */
  maxConnections: number;
  timeoutMs: number;
}

interface NodemailerTransport {
  sendMail(m: Record<string, unknown>): Promise<{ messageId?: string; response?: string }>;
  close(): void;
}

/** SMTP reply codes that retrying cannot fix: mailbox unknown / rejected, syntax, policy. 4xx and network errors are retried. */
export function smtpErrorIsPermanent(err: unknown): boolean {
  const code = (err as { responseCode?: unknown })?.responseCode;
  return typeof code === 'number' && code >= 500 && code < 600;
}

export function createSmtpProvider(config: SmtpConfig): EmailProvider & { close(): void } {
  let transport: Promise<NodemailerTransport> | null = null;
  const open = () => {
    transport ??= import('nodemailer').then((m) => {
      const nodemailer = (m as unknown as { default?: unknown }).default ?? m;
      return (
        nodemailer as { createTransport(o: Record<string, unknown>): NodemailerTransport }
      ).createTransport({
        host: config.host,
        port: config.port,
        secure: config.tls === 'implicit',
        requireTLS: config.tls === 'starttls',
        ignoreTLS: config.tls === 'off',
        auth: config.user ? { user: config.user, pass: config.password ?? '' } : undefined,
        pool: true,
        maxConnections: config.maxConnections,
        connectionTimeout: config.timeoutMs,
        greetingTimeout: config.timeoutMs,
        socketTimeout: config.timeoutMs,
        // never log message bodies (links carry tokens)
        logger: false,
        debug: false,
      });
    });
    return transport;
  };

  return {
    name: 'smtp',
    async send(email) {
      const t = await open();
      try {
        const info = await t.sendMail({
          from: email.from,
          to: email.to,
          replyTo: email.replyTo,
          subject: email.subject,
          text: email.text,
          html: email.html,
          headers: email.headers,
          messageId: email.messageId,
        });
        return { providerMessageId: info.messageId ?? email.messageId };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new EmailSendError(`smtp: ${message.slice(0, 300)}`, smtpErrorIsPermanent(err));
      }
    },
    close() {
      void transport?.then((t) => t.close()).catch(() => {});
    },
  };
}

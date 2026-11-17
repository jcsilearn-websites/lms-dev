import { type EmailProvider, EmailSendError } from './types';

/**
 * SendGrid v3 Mail Send over HTTPS (plain fetch, no SDK). The reference HTTP-API provider: widely deployed, takes our own
 * headers (List-Unsubscribe, Message-ID) and custom args (the outbox id comes back in every webhook event), and its Event
 * Webhook is signed with ECDSA (see sendgrid-webhook.ts), so no shared webhook secret exists that could leak.
 */
export interface SendgridConfig {
  apiKey: string;
  /** https://api.sendgrid.com (default) or the EU data residency host https://api.eu.sendgrid.com */
  apiUrl: string;
  timeoutMs: number;
  /** test hook */
  fetch?: typeof fetch;
}

/** Parses `"Name" <address>` / `address` into SendGrid's {email, name}. */
export function parseAddress(value: string): { email: string; name?: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (!m) return { email: value.trim() };
  const name = (m[1] ?? '').trim();
  return name ? { email: (m[2] ?? '').trim(), name } : { email: (m[2] ?? '').trim() };
}

export function createSendgridProvider(config: SendgridConfig): EmailProvider {
  const doFetch = config.fetch ?? fetch;
  return {
    name: 'sendgrid',
    async send(email) {
      const outboxId = /^<([^@>]+)@/.exec(email.messageId)?.[1];
      const body = {
        personalizations: [{ to: [{ email: email.to }] }],
        from: parseAddress(email.from),
        ...(email.replyTo ? { reply_to: parseAddress(email.replyTo) } : {}),
        subject: email.subject,
        content: [
          { type: 'text/plain', value: email.text },
          { type: 'text/html', value: email.html },
        ],
        headers: { ...email.headers, 'Message-ID': email.messageId },
        ...(outboxId ? { custom_args: { outbox_id: outboxId } } : {}),
        // no open / click tracking: it rewrites our links and adds pixels
        tracking_settings: {
          click_tracking: { enable: false, enable_text: false },
          open_tracking: { enable: false },
          subscription_tracking: { enable: false },
        },
      };
      let res: Response;
      try {
        res = await doFetch(`${config.apiUrl.replace(/\/$/, '')}/v3/mail/send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (err) {
        throw new EmailSendError(
          `sendgrid: ${err instanceof Error ? err.message : 'network error'}`,
          false,
        );
      }
      if (res.status === 202 || res.status === 200) {
        return { providerMessageId: res.headers.get('x-message-id') };
      }
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      // 400 / 413: the request itself is wrong (address, size): retrying cannot help. 401 / 403 are configuration (a wrong
      // or revoked key, an unverified sender): retried with backoff so a fixed configuration still delivers.
      throw new EmailSendError(
        `sendgrid ${res.status}: ${detail}`,
        res.status === 400 || res.status === 413,
      );
    },
  };
}

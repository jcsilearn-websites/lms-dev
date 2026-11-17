import type { EmailProvider, OutgoingEmail } from './types';

/** Dev provider: writes the email (links included) to the log. Refused in production (env policy). */
export function createConsoleProvider(log: (obj: object, msg: string) => void): EmailProvider {
  return {
    name: 'console',
    async send(email) {
      log({ to: email.to, subject: email.subject, text: email.text }, 'email (console provider)');
      return { providerMessageId: null };
    },
  };
}

/**
 * Dev / E2E provider: appends one JSON line {to, subject, text, html, headers, at} per email to `file`, so another process
 * (the Playwright tests) can read links. It writes links to disk in clear text: refused in production (env policy).
 */
export function createFileProvider(file: string): EmailProvider {
  return {
    name: 'file',
    async send(email) {
      const { appendFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(file), { recursive: true });
      const line = {
        to: email.to,
        from: email.from,
        subject: email.subject,
        text: email.text,
        html: email.html,
        headers: email.headers,
        messageId: email.messageId,
        at: new Date().toISOString(),
      };
      await appendFile(file, `${JSON.stringify(line)}\n`);
      return { providerMessageId: email.messageId };
    },
  };
}

/** Test double: remembers every email; `fail(n)` makes the next n sends throw (a transient provider error). */
export function createCapturingProvider(): EmailProvider & {
  sent: OutgoingEmail[];
  failNext(n: number, error?: Error): void;
  clear(): void;
} {
  const sent: OutgoingEmail[] = [];
  let failures = 0;
  let failure: Error = new Error('provider unavailable');
  return {
    name: 'capturing',
    sent,
    failNext(n, error) {
      failures = n;
      if (error) failure = error;
    },
    clear() {
      sent.length = 0;
    },
    async send(email) {
      if (failures > 0) {
        failures--;
        throw failure;
      }
      sent.push(email);
      return { providerMessageId: `cap-${sent.length}` };
    },
  };
}

/** EMAIL_PROVIDER=none: delivery switched off (the outbox rows are marked sent with no provider id). Not for production. */
export function createNullProvider(): EmailProvider {
  return {
    name: 'none',
    async send() {
      return { providerMessageId: null };
    },
  };
}

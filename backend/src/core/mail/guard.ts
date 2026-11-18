import { type CircuitBreaker, createCircuitBreaker, withTimeout } from '../resilience';
import { type EmailProvider, EmailSendError } from './types';

/**
 * The email provider behind a hard deadline and a circuit breaker (step 14a). The provider's own timeouts (SMTP socket, SendGrid
 * fetch) stay; this is the backstop that guarantees `send` returns within `timeoutMs` whatever the library does. After
 * `failureThreshold` consecutive failures the circuit opens and `send` throws CircuitOpenError WITHOUT calling the provider: the
 * `email.send` handler then defers the job (no attempt charged), so an outage of minutes cannot exhaust the workers or dead-letter
 * the outbox. A PERMANENT error (a rejected recipient) is the provider answering: it does not count against its health.
 */
export function guardEmailProvider(
  provider: EmailProvider,
  opts: {
    timeoutMs: number;
    breaker?: CircuitBreaker;
    failureThreshold?: number;
    cooldownMs?: number;
    now?: () => number;
  },
): EmailProvider & { breaker: CircuitBreaker } {
  const breaker =
    opts.breaker ??
    createCircuitBreaker({
      name: `email:${provider.name}`,
      ...(opts.failureThreshold !== undefined ? { failureThreshold: opts.failureThreshold } : {}),
      ...(opts.cooldownMs !== undefined ? { cooldownMs: opts.cooldownMs } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
  const wrapped: EmailProvider & { breaker: CircuitBreaker } = {
    name: provider.name,
    breaker,
    send: (email) =>
      breaker.exec(
        () =>
          withTimeout(`email send (${provider.name})`, opts.timeoutMs, () => provider.send(email)),
        (err) => !(err instanceof EmailSendError && err.permanent),
      ),
  };
  // keep the optional close() of pooled providers (SMTP)
  const closable = provider as { close?: () => void };
  if (closable.close) (wrapped as { close?: () => void }).close = () => closable.close?.();
  return wrapped;
}

import type { HandlerMap } from '../../core/handlers';
import type { EmailService } from './email.service';

// The outbox worker: one `email.send` job per outbox row (enqueued in the business transaction), and the retention purge.
export function createEmailHandlers(deps: {
  emailService: EmailService;
  purge: { everyMs: number };
}): HandlerMap {
  const { emailService } = deps;
  return {
    'email.send': {
      run: async (payload, ctx) => {
        const outboxId = (payload as { outboxId?: string }).outboxId;
        if (!outboxId) throw new Error('email.send needs an outboxId');
        return emailService.deliver(outboxId, {
          attempt: ctx.attempt,
          maxAttempts: ctx.maxAttempts,
          signal: ctx.signal,
        });
      },
    },
    'email.purge': {
      everyMs: deps.purge.everyMs,
      run: async () => ({ deleted: await emailService.purge() }),
    },
  };
}

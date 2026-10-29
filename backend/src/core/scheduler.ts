import type { HandlerMap } from './handlers';

export interface SchedulerHooks {
  /**
   * Enqueues the scheduled job for `name` (a system job keyed by its time slot, so any number of
   * worker instances enqueue it once per slot). Implemented by the jobs module.
   */
  enqueue: (name: string, everyMs: number) => Promise<unknown>;
  onError: (name: string, err: unknown) => void;
}

/**
 * Schedules handlers that declare `everyMs`: it only ENQUEUES; the job queue runs the handler (with
 * retries, backoff and a lease). Ticks once at start (a restart does not delay the next run by up to
 * a full interval) and then every `everyMs`. stop() waits for enqueues in flight.
 */
export function startScheduler(handlers: HandlerMap, hooks: SchedulerHooks) {
  const timers: NodeJS.Timeout[] = [];
  const running = new Set<Promise<void>>();

  const tick = (name: string, everyMs: number) => {
    const p: Promise<void> = hooks
      .enqueue(name, everyMs)
      .then(() => undefined)
      .catch((err: unknown) => hooks.onError(name, err))
      .finally(() => running.delete(p));
    running.add(p);
  };

  for (const [name, handler] of Object.entries(handlers)) {
    const everyMs = handler.everyMs;
    if (!everyMs) continue;
    tick(name, everyMs);
    timers.push(setInterval(() => tick(name, everyMs), everyMs));
  }

  return {
    scheduled: timers.length,
    async stop(): Promise<void> {
      for (const t of timers) clearInterval(t);
      while (running.size > 0) await Promise.all([...running]);
    },
  };
}
export type Scheduler = ReturnType<typeof startScheduler>;

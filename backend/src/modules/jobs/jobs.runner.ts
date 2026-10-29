import type { HandlerMap, JobContext } from '../../core/handlers';
import type { ClaimedJob } from './jobs.repository';
import type { JobsConfig, JobsService } from './jobs.service';

type RunnerJobs = Pick<
  JobsService,
  'claim' | 'complete' | 'fail' | 'extendLease' | 'release' | 'onEnqueue'
>;

export interface RunnerLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

/**
 * The idle back-off of an empty queue: base -> 2x -> 5x -> max (1s, 2s, 5s, 10s with the defaults),
 * never above `maxMs`. Index 0 is the "busy" interval.
 */
export function pollSteps(baseMs: number, maxMs: number): number[] {
  const max = Math.max(maxMs, baseMs);
  const steps = [baseMs, baseMs * 2, baseMs * 5, max].filter((s) => s <= max);
  if (!steps.includes(max)) steps.push(max);
  return [...new Set(steps)].sort((a, b) => a - b);
}

interface RunningJob {
  controller: AbortController;
  done: Promise<void>;
  /** set when the job was handed back (shutdown) or its lease was lost: nobody reports on it any more */
  detached: boolean;
}

interface QueueState {
  name: string;
  concurrency: number;
  inFlight: Map<string, RunningJob>;
  step: number;
  timer: NodeJS.Timeout | undefined;
  polling: boolean;
  /** a wake-up arrived while a poll was running: poll again right after it */
  again: boolean;
}

/**
 * Pulls jobs from the queue and runs the module handlers: one poll loop per queue (handler name),
 * per-queue concurrency, a lease heartbeat for every running job, retry / backoff / dead-letter through
 * the queue functions, adaptive polling (an empty queue is polled progressively less often; a claimed
 * or enqueued job brings it back to the fast interval at once) and a graceful stop.
 */
export function createJobRunner(deps: {
  jobs: RunnerJobs;
  handlers: HandlerMap;
  config: JobsConfig;
  workerId: string;
  logger: RunnerLogger;
}) {
  const { jobs, handlers, config, workerId, logger } = deps;
  const steps = pollSteps(config.pollIntervalMs, config.pollMaxIntervalMs);
  const lastStep = steps.length - 1;
  const heartbeatMs = Math.max(50, Math.floor((config.leaseSeconds * 1000) / 3));
  const queues = new Map<string, QueueState>();
  let started = false;
  let stopped = false;
  let stopping: Promise<void> | undefined;

  for (const name of Object.keys(handlers)) {
    queues.set(name, {
      name,
      concurrency: config.concurrency[name] ?? config.concurrency.default ?? 1,
      inFlight: new Map(),
      step: 0,
      timer: undefined,
      polling: false,
      again: false,
    });
  }

  function schedule(q: QueueState): void {
    if (stopped) return;
    clearTimeout(q.timer);
    q.timer = setTimeout(() => void poll(q), steps[q.step]);
  }

  /** Back to the fast interval and poll right now. */
  function wake(queue: string): void {
    const q = queues.get(queue);
    if (!q || stopped || !started) return; // enqueues before start() do not start the polling
    q.step = 0;
    if (q.polling) {
      q.again = true;
      return;
    }
    clearTimeout(q.timer);
    void poll(q);
  }

  const unsubscribe = jobs.onEnqueue((queue) => wake(queue));

  /** Polls that are running right now: stop() waits for them (a claim may be in flight). */
  const activePolls = new Set<Promise<void>>();

  function poll(q: QueueState): Promise<void> {
    if (stopped || q.polling) return Promise.resolve();
    const p: Promise<void> = doPoll(q).finally(() => activePolls.delete(p));
    activePolls.add(p);
    return p;
  }

  async function doPoll(q: QueueState): Promise<void> {
    q.polling = true;
    q.again = false;
    try {
      const free = q.concurrency - q.inFlight.size;
      // a saturated queue is not polled: a finishing job wakes it
      if (free > 0) {
        const claimed = await jobs.claim(q.name, workerId, free);
        q.step = claimed.length > 0 ? 0 : Math.min(q.step + 1, lastStep);
        for (const job of claimed) start(q, job);
      }
    } catch (err) {
      logger.error({ err, queue: q.name }, 'job claim failed');
      q.step = Math.min(q.step + 1, lastStep);
    } finally {
      q.polling = false;
      if (q.again && !stopped) {
        q.step = 0;
        void poll(q);
      } else {
        schedule(q);
      }
    }
  }

  function start(q: QueueState, job: ClaimedJob): void {
    const handler = handlers[q.name];
    if (!handler) return;
    const controller = new AbortController();
    const running: RunningJob = { controller, done: Promise.resolve(), detached: false };
    const ctx: JobContext = {
      jobId: job.id,
      queue: job.queue,
      tenantId: job.tenantId,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      signal: controller.signal,
    };
    // heartbeat: a long job keeps renewing its lease so nobody else re-claims it while it runs
    const beat = setInterval(() => {
      jobs
        .extendLease(job.id, workerId)
        .then((ok) => {
          if (!ok && !running.detached) {
            running.detached = true;
            logger.warn({ jobId: job.id, queue: q.name }, 'job lost its lease');
            controller.abort(new Error('lease lost'));
          }
        })
        .catch((err: unknown) => logger.error({ err, jobId: job.id }, 'lease heartbeat failed'));
    }, heartbeatMs);

    running.done = (async () => {
      try {
        const result = await handler.run(job.payload, ctx);
        if (!running.detached) {
          const ok = await jobs.complete(job.id, workerId, result);
          if (!ok) logger.warn({ jobId: job.id }, 'job finished but its lease was gone');
        }
      } catch (err) {
        if (!running.detached) {
          const message = err instanceof Error ? err.message : String(err);
          const outcome = await jobs
            .fail(job.id, workerId, message)
            .catch((e: unknown) =>
              logger.error({ err: e, jobId: job.id }, 'could not record the failure'),
            );
          logger.error(
            { err, jobId: job.id, queue: q.name, attempt: job.attempts, outcome },
            'job failed',
          );
        }
      } finally {
        clearInterval(beat);
        q.inFlight.delete(job.id);
        wake(q.name); // a slot is free: look for more work now
      }
    })();
    q.inFlight.set(job.id, running);
  }

  return {
    /** Start polling every queue (the first poll is immediate). */
    start(): void {
      started = true;
      for (const q of queues.values()) void poll(q);
    },
    wake,
    /** The current poll interval of a queue in ms (tests, diagnostics). */
    pollIntervalMs(queue: string): number | undefined {
      const q = queues.get(queue);
      return q ? steps[q.step] : undefined;
    },
    steps,
    inFlight(queue?: string): number {
      if (queue) return queues.get(queue)?.inFlight.size ?? 0;
      let n = 0;
      for (const q of queues.values()) n += q.inFlight.size;
      return n;
    },
    /**
     * Graceful stop: no more claims; in-flight jobs get `graceMs` to finish; whatever is still running
     * is told to abort (ctx.signal) and handed back to the queue WITHOUT charging the attempt.
     */
    stop(graceMs = config.shutdownGraceSeconds * 1000): Promise<void> {
      stopping ??= (async () => {
        stopped = true;
        unsubscribe();
        for (const q of queues.values()) clearTimeout(q.timer);
        // a claim may be in flight: the database already shows that job as running, so it must be
        // started (and then given its grace period) rather than forgotten
        await Promise.allSettled([...activePolls]);
        const all = [...queues.values()].flatMap((q) => [...q.inFlight.entries()]);
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), graceMs);
        });
        const outcome = await Promise.race([
          Promise.all(all.map(([, r]) => r.done)).then(() => 'done' as const),
          timeout,
        ]);
        clearTimeout(timer);
        if (outcome === 'timeout') {
          const still = all.filter(([, r]) => !r.detached);
          await Promise.all(
            still.map(async ([id, r]) => {
              r.detached = true;
              r.controller.abort(new Error('worker shutting down'));
              await jobs
                .release(id, workerId)
                .catch((err: unknown) => logger.error({ err, jobId: id }, 'release failed'));
            }),
          );
          logger.warn({ released: still.length }, 'jobs released on shutdown');
        }
      })();
      return stopping;
    },
  };
}
export type JobRunner = ReturnType<typeof createJobRunner>;

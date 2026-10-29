import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandlerMap } from '../../../core/handlers';
import { createJobRunner, pollSteps } from '../jobs.runner';
import { DEFAULT_JOBS_CONFIG, type JobsConfig } from '../jobs.service';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function job(id: string, queue = 'q') {
  return {
    id,
    queue,
    tenantId: null as string | null,
    payload: { id },
    attempts: 1,
    maxAttempts: 3,
  };
}

/** A fake of the jobs service the runner talks to. */
function fakeJobs(claims: Array<ReturnType<typeof job>[]> = []) {
  const listeners = new Set<(q: string) => void>();
  const queue = [...claims];
  return {
    claim: vi.fn(async (_q: string, _w: string, limit: number) => {
      const next = queue.shift() ?? [];
      return next.slice(0, limit);
    }),
    complete: vi.fn(async () => true),
    fail: vi.fn(async () => 'retry' as const),
    extendLease: vi.fn(async () => true),
    release: vi.fn(async () => true),
    onEnqueue: (l: (q: string) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emitEnqueue: (q: string) => {
      for (const l of listeners) l(q);
    },
    push: (jobs: ReturnType<typeof job>[]) => queue.push(jobs),
  };
}

const config = (over: Partial<JobsConfig> = {}): JobsConfig => ({
  ...DEFAULT_JOBS_CONFIG,
  pollIntervalMs: 1000,
  pollMaxIntervalMs: 10_000,
  leaseSeconds: 3,
  concurrency: { default: 2 },
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pollSteps', () => {
  it('1s, 2s, 5s, 10s with the defaults and never above the configured maximum', () => {
    expect(pollSteps(1000, 10_000)).toEqual([1000, 2000, 5000, 10_000]);
    expect(pollSteps(1000, 3000)).toEqual([1000, 2000, 3000]);
    expect(pollSteps(1000, 1000)).toEqual([1000]);
    expect(pollSteps(500, 60_000)).toEqual([500, 1000, 2500, 60_000]);
    expect(pollSteps(2000, 1000)).toEqual([2000]); // a max below the base cannot shrink the base
  });
});

describe('adaptive polling', () => {
  it('backs off 1s -> 2s -> 5s -> 10s while a queue is empty and stays at the maximum', async () => {
    const jobs = fakeJobs();
    const handlers: HandlerMap = { q: { run: async () => undefined } };
    const runner = createJobRunner({ jobs, handlers, config: config(), workerId: 'w', logger });
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.claim).toHaveBeenCalledTimes(1); // the first poll is immediate
    expect(runner.pollIntervalMs('q')).toBe(2000); // empty -> next wait is the second step

    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      const before = jobs.claim.mock.calls.length;
      const wait = runner.pollIntervalMs('q') as number;
      waits.push(wait);
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(jobs.claim.mock.calls.length).toBe(before); // not polled early
      await vi.advanceTimersByTimeAsync(1);
      expect(jobs.claim.mock.calls.length).toBe(before + 1);
    }
    expect(waits).toEqual([2000, 5000, 10_000, 10_000, 10_000]);
    await runner.stop(0);
  });

  it('returns to the fast interval as soon as a job is claimed', async () => {
    const jobs = fakeJobs();
    let finish: () => void = () => {};
    const handlers: HandlerMap = {
      q: { run: () => new Promise((r) => (finish = () => r(undefined))) },
    };
    const runner = createJobRunner({ jobs, handlers, config: config(), workerId: 'w', logger });
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(runner.pollIntervalMs('q')).toBe(10_000); // backed off to the maximum
    jobs.push([job('a')]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.inFlight('q')).toBe(1);
    expect(runner.pollIntervalMs('q')).toBe(1000); // back to the fast interval
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.complete).toHaveBeenCalledTimes(1);
    await runner.stop(0);
  });

  it('returns to the fast interval immediately when a job is enqueued in this process', async () => {
    const jobs = fakeJobs();
    let finish: () => void = () => {};
    const handlers: HandlerMap = {
      q: { run: () => new Promise((r) => (finish = () => r(undefined))) },
    };
    const runner = createJobRunner({ jobs, handlers, config: config(), workerId: 'w', logger });
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000 + 5000);
    expect(runner.pollIntervalMs('q')).toBe(10_000);
    const polls = jobs.claim.mock.calls.length;

    jobs.push([job('late')]);
    jobs.emitEnqueue('q'); // enqueue in the same process: no waiting for the 10 s timer
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.claim.mock.calls.length).toBe(polls + 1); // polled at once, not after the 10 s timer
    expect(runner.inFlight('q')).toBe(1);
    expect(runner.pollIntervalMs('q')).toBe(1000);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.complete).toHaveBeenCalledTimes(1);
    // an enqueue for another queue changes nothing
    await vi.advanceTimersByTimeAsync(0);
    const afterWake = jobs.claim.mock.calls.length;
    jobs.emitEnqueue('other');
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.claim.mock.calls.length).toBe(afterWake);
    await runner.stop(0);
  });
});

describe('concurrency and results', () => {
  it('never claims more than the free slots of the queue and polls again when one finishes', async () => {
    const jobs = fakeJobs([[job('1'), job('2'), job('3'), job('4')]]);
    const releases: Array<() => void> = [];
    let running = 0;
    let peak = 0;
    const handlers: HandlerMap = {
      q: {
        run: () => {
          running++;
          peak = Math.max(peak, running);
          return new Promise((resolve) => {
            releases.push(() => {
              running--;
              resolve(undefined);
            });
          });
        },
      },
    };
    const runner = createJobRunner({
      jobs,
      handlers,
      config: config({ concurrency: { q: 2, default: 1 } }),
      workerId: 'w',
      logger,
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.claim).toHaveBeenCalledWith('q', 'w', 2); // 2 free slots -> asks for 2
    expect(runner.inFlight('q')).toBe(2);
    expect(releases).toHaveLength(2);

    jobs.push([job('3'), job('4')]);
    releases[0]?.(); // one slot frees up: the queue is polled at once, for ONE job
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.claim).toHaveBeenLastCalledWith('q', 'w', 1);
    expect(peak).toBe(2);
    for (const r of releases) r();
    await vi.advanceTimersByTimeAsync(0);
    await runner.stop(0);
  });

  it('records success with the handler result and failure with the error message', async () => {
    const jobs = fakeJobs([[job('ok'), job('bad')]]);
    const handlers: HandlerMap = {
      q: {
        run: async (payload) => {
          if ((payload as { id: string }).id === 'bad') throw new Error('boom');
          return { done: 1 };
        },
      },
    };
    const runner = createJobRunner({ jobs, handlers, config: config(), workerId: 'w', logger });
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.complete).toHaveBeenCalledWith('ok', 'w', { done: 1 });
    expect(jobs.fail).toHaveBeenCalledWith('bad', 'w', 'boom');
    await runner.stop(0);
  });

  it('hands the handler its context: tenant, attempt and an abort signal', async () => {
    const seen: unknown[] = [];
    const jobs = fakeJobs([[{ ...job('t'), tenantId: 'tenant-1', attempts: 2 }]]);
    const runner = createJobRunner({
      jobs,
      handlers: { q: { run: async (_p, ctx) => void seen.push(ctx) } },
      config: config(),
      workerId: 'w',
      logger,
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen[0]).toMatchObject({
      jobId: 't',
      queue: 'q',
      tenantId: 'tenant-1',
      attempt: 2,
      maxAttempts: 3,
    });
    expect((seen[0] as { signal: AbortSignal }).signal.aborted).toBe(false);
    await runner.stop(0);
  });
});

describe('lease heartbeat', () => {
  it('extends the lease about every third of the lease period for as long as the handler runs', async () => {
    const jobs = fakeJobs([[job('long')]]);
    let finish: () => void = () => {};
    const handlers: HandlerMap = {
      q: { run: () => new Promise((r) => (finish = () => r(undefined))) },
    };
    // lease 3 s -> heartbeat every 1 s; the job runs for 10 s = more than three lease periods
    const runner = createJobRunner({
      jobs,
      handlers,
      config: config({ leaseSeconds: 3 }),
      workerId: 'w',
      logger,
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(jobs.extendLease.mock.calls.length).toBeGreaterThanOrEqual(9);
    expect(jobs.extendLease).toHaveBeenCalledWith('long', 'w');
    expect(jobs.complete).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.complete).toHaveBeenCalledTimes(1);
    const calls = jobs.extendLease.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(jobs.extendLease.mock.calls.length).toBe(calls); // the heartbeat stops with the job
    await runner.stop(0);
  });

  it('aborts the handler and reports nothing when the lease was lost', async () => {
    const jobs = fakeJobs([[job('x')]]);
    jobs.extendLease.mockResolvedValue(false);
    let signal: AbortSignal | undefined;
    let finish: () => void = () => {};
    const runner = createJobRunner({
      jobs,
      handlers: {
        q: {
          run: (_p, ctx) => {
            signal = ctx.signal;
            return new Promise((r) => (finish = () => r(undefined)));
          },
        },
      },
      config: config(),
      workerId: 'w',
      logger,
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(1100);
    expect(signal?.aborted).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.complete).not.toHaveBeenCalled(); // the new owner reports, not us
    expect(jobs.fail).not.toHaveBeenCalled();
    await runner.stop(0);
  });
});

describe('graceful stop', () => {
  it('waits for in-flight jobs that finish within the grace period', async () => {
    const jobs = fakeJobs([[job('a')]]);
    let finish: () => void = () => {};
    const runner = createJobRunner({
      jobs,
      handlers: { q: { run: () => new Promise((r) => (finish = () => r(undefined))) } },
      config: config(),
      workerId: 'w',
      logger,
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopped = runner.stop(5000);
    await vi.advanceTimersByTimeAsync(1000);
    finish();
    await stopped;
    expect(jobs.complete).toHaveBeenCalledTimes(1);
    expect(jobs.release).not.toHaveBeenCalled();
    // and nothing is claimed after stop
    const claims = jobs.claim.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(jobs.claim.mock.calls.length).toBe(claims);
  });

  it('aborts and RELEASES jobs still running when the grace period ends (the attempt is not charged)', async () => {
    const jobs = fakeJobs([[job('slow')]]);
    let signal: AbortSignal | undefined;
    let finish: () => void = () => {};
    const runner = createJobRunner({
      jobs,
      handlers: {
        q: {
          run: (_p, ctx) => {
            signal = ctx.signal;
            return new Promise((r) => (finish = () => r(undefined)));
          },
        },
      },
      config: config(),
      workerId: 'w',
      logger,
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopped = runner.stop(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await stopped;
    expect(signal?.aborted).toBe(true);
    expect(jobs.release).toHaveBeenCalledWith('slow', 'w');
    finish(); // the handler returns late: it must not complete a job it no longer owns
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.complete).not.toHaveBeenCalled();
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it('a job claimed while stop() is called is started and waited for (the claim was already in flight)', async () => {
    const jobs = fakeJobs();
    // the claim takes 500 ms to come back: the database already shows the job as running
    jobs.claim.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 500));
      return [job('late')];
    });
    let finished = false;
    const runner = createJobRunner({
      jobs,
      handlers: {
        q: {
          run: async () => {
            await new Promise((r) => setTimeout(r, 300));
            finished = true;
            return undefined;
          },
        },
      },
      config: config(),
      workerId: 'w',
      logger,
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(100); // the claim is still in flight
    let finishedWhenStopResolved: boolean | undefined;
    const stopped = runner.stop(5000).then(() => {
      finishedWhenStopResolved = finished;
    });
    await vi.advanceTimersByTimeAsync(2000);
    await stopped;
    // stop() must not return before the job it is responsible for has finished
    expect(finishedWhenStopResolved).toBe(true);
    expect(jobs.complete).toHaveBeenCalledWith('late', 'w', undefined);
    expect(jobs.release).not.toHaveBeenCalled();
  });
});

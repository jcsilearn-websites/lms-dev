import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startScheduler } from '../scheduler';

describe('scheduler (enqueues scheduled handlers; the job queue runs them)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const noop = async () => undefined;

  it('enqueues handlers that declare everyMs once at start and then every interval; skips the others', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    const s = startScheduler(
      { 'a.purge': { run: noop, everyMs: 1000 }, 'b.on_demand': { run: noop } },
      { enqueue, onError: vi.fn() },
    );
    expect(s.scheduled).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1); // the start tick
    expect(enqueue).toHaveBeenCalledWith('a.purge', 1000);
    await vi.advanceTimersByTimeAsync(3500);
    expect(enqueue).toHaveBeenCalledTimes(4);
    expect(enqueue).not.toHaveBeenCalledWith('b.on_demand', expect.anything());
    await s.stop();
  });

  it('reports errors and keeps the schedule alive; stop() clears timers and waits for enqueues in flight', async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error('db down'));
    const onError = vi.fn();
    const s = startScheduler({ flaky: { run: noop, everyMs: 100 } }, { enqueue, onError });
    await vi.advanceTimersByTimeAsync(350);
    expect(enqueue).toHaveBeenCalledTimes(4);
    expect(onError).toHaveBeenCalledWith('flaky', expect.any(Error));

    let finished = false;
    let release: () => void = () => {};
    enqueue.mockImplementation(
      () =>
        new Promise<void>((r) => {
          release = () => {
            finished = true;
            r();
          };
        }),
    );
    await vi.advanceTimersByTimeAsync(100);
    const stopped = s.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(finished).toBe(false); // stop() is still waiting for the enqueue in flight
    release();
    await stopped;
    expect(finished).toBe(true);
    const calls = enqueue.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(enqueue.mock.calls.length).toBe(calls); // timers are cleared
  });
});

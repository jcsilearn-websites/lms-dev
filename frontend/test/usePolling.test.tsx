import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollDelay, usePolling } from '../src/shared/utils/usePolling';

describe('pollDelay: 1 s, backing off to 5 s', () => {
  it('starts at 1 s, grows, and stops growing at 5 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(pollDelay)).toEqual([
      1000, 1000, 2000, 3000, 4000, 5000, 5000, 5000,
    ]);
  });
});

/** A document stand-in whose visibility the test controls. */
function fakeDocument() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_t: 'visibilitychange', l: () => void) => void listeners.add(l),
    removeEventListener: (_t: 'visibilitychange', l: () => void) => void listeners.delete(l),
    set(state: DocumentVisibilityState) {
      doc.visibilityState = state;
      for (const l of [...listeners]) l();
    },
    listenerCount: () => listeners.size,
  };
  return doc;
}

describe('usePolling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('polls with growing delays while enabled', async () => {
    const poll = vi.fn(async () => undefined);
    const visibility = fakeDocument();
    renderHook(() => usePolling({ enabled: true, poll, visibility }));
    expect(poll).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(poll).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1000)); // second delay: still 1 s
    expect(poll).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1999)); // third delay: 2 s
    expect(poll).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(poll).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(3000)); // 3 s
    await act(() => vi.advanceTimersByTimeAsync(4000)); // 4 s
    await act(() => vi.advanceTimersByTimeAsync(5000)); // 5 s
    expect(poll).toHaveBeenCalledTimes(6);
    await act(() => vi.advanceTimersByTimeAsync(4999)); // capped at 5 s
    expect(poll).toHaveBeenCalledTimes(6);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(poll).toHaveBeenCalledTimes(7);
  });

  it('stops for good when it is disabled (a terminal status) or unmounted', async () => {
    const poll = vi.fn(async () => undefined);
    const visibility = fakeDocument();
    const { rerender, unmount } = renderHook(
      (p: { on: boolean }) => usePolling({ enabled: p.on, poll, visibility }),
      { initialProps: { on: true } },
    );
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(poll).toHaveBeenCalledTimes(1);
    rerender({ on: false });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(poll).toHaveBeenCalledTimes(1);
    rerender({ on: true });
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('pauses while the tab is hidden and polls at once, from the short delay, when it is visible again', async () => {
    const doc = fakeDocument();
    const poll = vi.fn(async () => undefined);
    renderHook(() => usePolling({ enabled: true, poll, visibility: doc }));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(poll).toHaveBeenCalledTimes(3);

    act(() => doc.set('hidden'));
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000)); // ten minutes in the background
    expect(poll).toHaveBeenCalledTimes(3); // not a single request

    act(() => doc.set('visible'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(poll).toHaveBeenCalledTimes(4); // immediately
    await act(() => vi.advanceTimersByTimeAsync(1000)); // and back to the 1 s delay
    expect(poll).toHaveBeenCalledTimes(5);
  });

  it('keeps going after a failed poll and removes its listener on unmount', async () => {
    const doc = fakeDocument();
    const poll = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(undefined);
    const { unmount } = renderHook(() => usePolling({ enabled: true, poll, visibility: doc }));
    expect(doc.listenerCount()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(poll).toHaveBeenCalledTimes(2);
    unmount();
    expect(doc.listenerCount()).toBe(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  createNotificationPoller,
  type PollerEnv,
} from '../src/features/notifications/notificationPoller';
import type { UnreadPoll } from '../src/features/notifications/notifications.api';

// The bell's poll: only while visible, 60 s +-10 % (random fixed here at 0.5 = exactly 60 s), 5 min after 30 min idle, at once
// on visible / focus (but not twice within 5 s), the ETag sent back, 304 changes nothing, 401 / 403 stop for good.

function fakeEnv() {
  let now = 0;
  let visible: DocumentVisibilityState = 'visible';
  const timers = new Map<number, { at: number; cb: () => void }>();
  let id = 0;
  const vis = new Set<() => void>();
  const focus = new Set<() => void>();
  const act = new Set<() => void>();
  const env: PollerEnv = {
    visibilityState: () => visible,
    onVisibilityChange: (cb) => {
      vis.add(cb);
      return () => vis.delete(cb);
    },
    onFocus: (cb) => {
      focus.add(cb);
      return () => focus.delete(cb);
    },
    onActivity: (cb) => {
      act.add(cb);
      return () => act.delete(cb);
    },
    setTimeout: (cb, ms) => {
      timers.set(++id, { at: now + ms, cb });
      return id;
    },
    clearTimeout: (h) => timers.delete(h as number),
    now: () => now,
    random: () => 0.5,
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    env,
    /** moves the clock, running due timers in order */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].cb();
        await flush();
      }
      now = end;
      await flush();
    },
    async setVisible(v: DocumentVisibilityState) {
      visible = v;
      for (const cb of vis) cb();
      await flush();
    },
    async focus() {
      for (const cb of focus) cb();
      await flush();
    },
    input() {
      for (const cb of act) cb();
    },
    pending: () => timers.size,
    listeners: () => vis.size + focus.size + act.size,
  };
}

const changed = (unread: number, etag: string): UnreadPoll => ({ kind: 'changed', unread, etag });

describe('notification poller', () => {
  it('polls at start and every 60 s, sends back the ETag, and ignores a 304', async () => {
    const f = fakeEnv();
    const poll = vi
      .fn<(etag: string | null) => Promise<UnreadPoll>>()
      .mockResolvedValueOnce(changed(2, 'W/"2.a"'))
      .mockResolvedValue({ kind: 'same' });
    const counts: number[] = [];
    const p = createNotificationPoller({ poll, onCount: (n) => counts.push(n), env: f.env });
    p.start();
    await f.advance(0);
    expect(poll).toHaveBeenNthCalledWith(1, null);
    await f.advance(59_999);
    expect(poll).toHaveBeenCalledTimes(1);
    await f.advance(1);
    expect(poll).toHaveBeenNthCalledWith(2, 'W/"2.a"');
    expect(counts).toEqual([2]);
    p.stop();
  });

  it('never polls while hidden; becoming visible polls at once', async () => {
    const f = fakeEnv();
    const poll = vi.fn(async () => changed(0, 'e'));
    const p = createNotificationPoller({ poll, onCount: () => {}, env: f.env, minGapMs: 5000 });
    p.start();
    await f.advance(0);
    await f.setVisible('hidden');
    expect(f.pending()).toBe(0);
    await f.advance(10 * 60_000);
    expect(poll).toHaveBeenCalledTimes(1);
    await f.setVisible('visible');
    expect(poll).toHaveBeenCalledTimes(2);
    // focus right after: not twice within 5 s
    await f.focus();
    expect(poll).toHaveBeenCalledTimes(2);
    await f.advance(6000);
    await f.focus();
    expect(poll).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it('slows to 5 minutes after 30 minutes without input, and speeds up again on input', async () => {
    const f = fakeEnv();
    const poll = vi.fn(async () => ({ kind: 'same' }) as UnreadPoll);
    const p = createNotificationPoller({ poll, onCount: () => {}, env: f.env });
    p.start();
    await f.advance(31 * 60_000); // 1 + 31 polls at 60 s
    const before = poll.mock.calls.length;
    await f.advance(4 * 60_000);
    expect(poll.mock.calls.length).toBe(before); // now every 5 minutes
    await f.advance(60_000);
    expect(poll.mock.calls.length).toBe(before + 1);
    f.input();
    await f.advance(5 * 60_000); // the timer set before the input still waits 5 min once
    const after = poll.mock.calls.length;
    await f.advance(60_000);
    expect(poll.mock.calls.length).toBe(after + 1);
    p.stop();
  });

  it('401 / 403 stop it for good (listeners removed); an error waits for the next tick', async () => {
    const f = fakeEnv();
    const poll = vi
      .fn<(etag: string | null) => Promise<UnreadPoll>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ kind: 'signed-out' });
    const p = createNotificationPoller({ poll, onCount: () => {}, env: f.env });
    p.start();
    await f.advance(0);
    expect(p.stopped).toBe(false);
    await f.advance(60_000);
    expect(p.stopped).toBe(true);
    expect(f.listeners()).toBe(0);
    await f.advance(60 * 60_000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('refresh() polls at once (after reading notifications)', async () => {
    const f = fakeEnv();
    const poll = vi.fn(async () => changed(1, 'x'));
    const p = createNotificationPoller({ poll, onCount: () => {}, env: f.env });
    p.start();
    await f.advance(0);
    p.refresh();
    await f.advance(0);
    expect(poll).toHaveBeenCalledTimes(2);
    p.stop();
  });
});

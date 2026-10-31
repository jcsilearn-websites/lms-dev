import type { HeartbeatRequest, HeartbeatResponse } from '@lms/backend/contracts';
import { MAX_HEARTBEAT_RANGES } from '@lms/backend/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HEARTBEAT_INTERVAL_MS,
  HeartbeatTracker,
  MAX_RANGES,
  mergeRanges,
  type Range,
} from '../src/features/progress/heartbeatTracker';
import { sendHeartbeat } from '../src/features/progress/progress.api';
import { ApiError } from '../src/shared/api/client';

// The heartbeat sender: what it sends, when, in what order, and what it does when the network or the server says no.
// Fake timers: nothing here waits for real time.

const VIDEO = '0a000000-0000-7000-8000-000000000001';
const OK: HeartbeatResponse = {
  result: 'ok',
  watchedSeconds: 10,
  durationSeconds: 100,
  percent: 10,
  completed: false,
  positionSeconds: 10,
};

interface Sent {
  body: HeartbeatRequest;
  keepalive: boolean;
}

function setup(over: { fail?: () => unknown } = {}) {
  const sent: Sent[] = [];
  const results: HeartbeatResponse[] = [];
  const stale = vi.fn();
  const stopped = vi.fn();
  const send = vi.fn(async (body: HeartbeatRequest, o: { keepalive: boolean }) => {
    sent.push({ body, keepalive: o.keepalive });
    const err = over.fail?.();
    if (err) throw err;
    return OK;
  });
  const tracker = new HeartbeatTracker({
    videoId: VIDEO,
    send,
    onResult: (r) => results.push(r),
    onStale: stale,
    onStopped: stopped,
    streamId: '0b000000-0000-7000-8000-000000000001',
  });
  /** plays from `from` to `to` in one-second timeupdates */
  const playTo = (from: number, to: number) => {
    tracker.play(from);
    for (let t = from + 1; t <= to; t++) tracker.timeupdate(t);
  };
  return { tracker, sent, results, stale, stopped, send, playTo };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('what is sent', () => {
  it('sends the played range every 30 seconds while playing, in order, numbered 1, 2, 3', async () => {
    const { tracker, sent, playTo } = setup();
    playTo(0, 10);
    expect(sent).toHaveLength(0); // nothing before the interval
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(sent.map((s) => s.body.ranges)).toEqual([[[0, 10]]]);
    for (let t = 11; t <= 20; t++) tracker.timeupdate(t);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    // the second range starts where the first ended: nothing is lost between two heartbeats
    expect(sent.map((s) => [s.body.seq, s.body.ranges, s.body.position])).toEqual([
      [1, [[0, 10]], 10],
      [2, [[10, 20]], 20],
    ]);
    expect(new Set(sent.map((s) => s.body.streamId)).size).toBe(1);
    expect(sent.every((s) => s.body.videoId === VIDEO && !s.keepalive)).toBe(true);
  });

  it('sends on pause with the position (the resume point), and nothing more while paused', async () => {
    const { tracker, sent, playTo } = setup();
    playTo(0, 12);
    tracker.pause(12);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ ranges: [[0, 12]], position: 12, rate: 1 });
    await vi.advanceTimersByTimeAsync(5 * HEARTBEAT_INTERVAL_MS);
    expect(sent).toHaveLength(1); // the timer stopped with the playback
  });

  it('sends nothing when nothing changed (no played range, same position)', async () => {
    const { tracker, sent } = setup();
    tracker.play(5);
    tracker.pause(5); // a click on play, then pause at once
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1); // the position is new for the server: 5
    tracker.play(5);
    tracker.pause(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1); // the same position and no range: nothing to say
  });

  it('a seek closes the range: skipping ahead adds nothing', async () => {
    const { tracker, sent, playTo } = setup();
    playTo(0, 10);
    tracker.seeking(); // the viewer drags to minute 1:40
    tracker.seeked(100);
    for (let t = 101; t <= 105; t++) tracker.timeupdate(t);
    tracker.pause(105);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.body.ranges)).toEqual([[[0, 10]], [[100, 105]]]);
    // the 90 seconds in between were never claimed
  });

  it('a jump the player did not announce is treated as a seek', async () => {
    const { tracker, sent, playTo } = setup();
    playTo(0, 10);
    tracker.timeupdate(200); // more than 5 s away in one update
    tracker.timeupdate(201);
    tracker.timeupdate(202);
    tracker.pause(202);
    await vi.advanceTimersByTimeAsync(0);
    const ranges = mergeRanges(sent.flatMap((s) => s.body.ranges as Range[]));
    expect(ranges).toEqual([
      [0, 10],
      [200, 202],
    ]);
  });

  it('rewinding is not extra time either: the part before the jump counts, the new part starts from there', async () => {
    const { tracker, sent, playTo } = setup();
    playTo(0, 20);
    tracker.timeupdate(5); // back by 15 s
    tracker.timeupdate(6);
    tracker.pause(6);
    await vi.advanceTimersByTimeAsync(0);
    expect(mergeRanges(sent.flatMap((s) => s.body.ranges as Range[]))).toEqual([[0, 20]]);
  });

  it('sends the end of the video on `ended`', async () => {
    const { tracker, sent, playTo } = setup();
    playTo(0, 30);
    tracker.ended(31);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0]?.body).toMatchObject({ ranges: [[0, 31]], position: 31 });
  });

  it('reports the playback speed', async () => {
    const { tracker, sent } = setup();
    tracker.play(0, 1.5);
    tracker.timeupdate(3);
    tracker.pause(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0]?.body.rate).toBe(1.5);
  });
});

describe('page hide', () => {
  it('sends at once with keepalive (fetch, not a beacon) and goes on afterwards', async () => {
    const { tracker, sent, playTo } = setup();
    playTo(0, 8);
    tracker.hide();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ keepalive: true, body: { ranges: [[0, 8]] } });
    // a video that plays on in a background tab keeps reporting
    for (let t = 9; t <= 20; t++) tracker.timeupdate(t);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(sent[1]?.body.ranges).toEqual([[8, 20]]);
    tracker.show();
    for (let t = 21; t <= 25; t++) tracker.timeupdate(t);
    tracker.pause(25);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[2]?.keepalive).toBe(false);
  });

  it('dispose (the player leaves) sends what is left, with keepalive', async () => {
    const { tracker, sent, playTo } = setup();
    playTo(0, 6);
    tracker.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.keepalive).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * HEARTBEAT_INTERVAL_MS);
    expect(sent).toHaveLength(1);
  });

  it('the API call really sets keepalive and the CSRF header (a beacon cannot send it)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(OK), { headers: { 'content-type': 'application/json' } }),
      );
    try {
      await sendHeartbeat(
        'a0000000-0000-7000-8000-000000000001',
        'a1000000-0000-7000-8000-000000000001',
        { videoId: VIDEO, streamId: VIDEO, seq: 1, ranges: [], position: 0, rate: 1 },
        { keepalive: true },
      );
      const [url, init] = fetchSpy.mock.calls[0] ?? [];
      expect(String(url)).toContain('/progress/heartbeat');
      expect(init?.keepalive).toBe(true);
      expect(init?.method).toBe('POST');
      const sent = (init?.headers ?? {}) as Record<string, string>;
      expect(sent['x-requested-with']).toBe('lms');
      expect(init?.credentials).toBe('include');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('when the network or the server fails', () => {
  it('keeps the heartbeat, retries with a growing delay, and sends in order once it works', async () => {
    let failing = 2;
    const { tracker, sent, results, playTo } = setup({
      fail: () => (failing-- > 0 ? new ApiError(0, 'network_error', 'offline') : null),
    });
    playTo(0, 10);
    tracker.pause(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1); // the first attempt failed
    expect(tracker.queued).toBe(1);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(sent).toHaveLength(1); // not yet: 2 s
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toHaveLength(2); // retry after 2 s, failed again
    await vi.advanceTimersByTimeAsync(3_800);
    expect(sent).toHaveLength(2); // the next wait is 4 s
    await vi.advanceTimersByTimeAsync(300);
    expect(sent).toHaveLength(3);
    expect(results).toHaveLength(1);
    expect(tracker.queued).toBe(0);
    // the same heartbeat each time, with the same number: the server counts it once
    expect(new Set(sent.map((s) => s.body.seq))).toEqual(new Set([1]));
  });

  it('never has two requests in flight, and keeps the order while offline', async () => {
    let release: (() => void) | undefined;
    const sent: number[] = [];
    let inflight = 0;
    let maxInflight = 0;
    const tracker = new HeartbeatTracker({
      videoId: VIDEO,
      streamId: VIDEO,
      send: async (body) => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        sent.push(body.seq);
        await new Promise<void>((r) => {
          release = r;
        });
        inflight--;
        return OK;
      },
    });
    tracker.play(0);
    for (let t = 1; t <= 3; t++) tracker.timeupdate(t);
    tracker.seeking(); // heartbeat 1, in flight
    tracker.seeked(50);
    for (let t = 51; t <= 53; t++) tracker.timeupdate(t);
    tracker.seeking(); // heartbeat 2, waits
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([1]);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([1, 2]);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(maxInflight).toBe(1);
  });

  it('merges a long backlog into one request that still carries every played range', async () => {
    const { tracker, sent } = setup({ fail: () => new ApiError(503, 'unavailable', 'down') });
    tracker.play(0);
    // eight separate bits watched while offline: each one pause = one queued heartbeat
    for (let i = 0; i < 8; i++) {
      const at = i * 100;
      tracker.seeked(at);
      tracker.play(at);
      tracker.timeupdate(at + 1);
      tracker.timeupdate(at + 2);
      tracker.pause(at + 3);
    }
    await vi.advanceTimersByTimeAsync(0);
    // the first request is in flight (and failing); when the queue passed 5, what waited behind it became one
    expect(tracker.queued).toBe(4);
    const merged = tracker as unknown as { queue: HeartbeatRequest[] };
    expect(merged.queue.map((b) => b.seq)).toEqual([1, 6, 7, 8]); // in flight, the merged one (newest number 6), then two
    expect(mergeRanges(merged.queue.flatMap((b) => b.ranges as Range[]))).toHaveLength(8);
    expect(sent.every((s) => s.body.seq === 1)).toBe(true); // the failing one is retried as it was
  });

  it('401: the session ended, so it stops for good and says so', async () => {
    const { tracker, sent, stopped, playTo } = setup({
      fail: () => new ApiError(401, 'unauthenticated', 'no'),
    });
    playTo(0, 5);
    tracker.pause(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toHaveBeenCalledWith('signed_out');
    playTo(5, 9);
    tracker.pause(9);
    await vi.advanceTimersByTimeAsync(10 * HEARTBEAT_INTERVAL_MS);
    expect(sent).toHaveLength(1);
  });

  it('409 video_changed: the player is stale, it stops and tells the page', async () => {
    const { tracker, sent, stale, playTo } = setup({
      fail: () => new ApiError(409, 'video_changed', 'replaced'),
    });
    playTo(0, 5);
    tracker.pause(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(stale).toHaveBeenCalledTimes(1);
    playTo(5, 9);
    tracker.pause(9);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
  });

  it('403 / 404: the item is no longer open to this learner, it stops quietly', async () => {
    const { tracker, stopped, playTo } = setup({
      fail: () => new ApiError(404, 'item_not_found', 'gone'),
    });
    playTo(0, 5);
    tracker.pause(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toHaveBeenCalledWith('not_allowed');
  });

  it('a heartbeat the server can never accept (400) is dropped and the next one goes out', async () => {
    let n = 0;
    const { tracker, sent, playTo } = setup({
      fail: () => (n++ === 0 ? new ApiError(400, 'validation_error', 'bad') : null),
    });
    playTo(0, 5);
    tracker.pause(5);
    await vi.advanceTimersByTimeAsync(0);
    playTo(5, 9);
    tracker.pause(9);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.body.seq)).toEqual([1, 2]);
    expect(tracker.queued).toBe(0);
  });

  it('429 (rate limit) is retried like an outage', async () => {
    let n = 0;
    const { tracker, sent, playTo } = setup({
      fail: () => (n++ === 0 ? new ApiError(429, 'rate_limited', 'slow down') : null),
    });
    playTo(0, 5);
    tracker.pause(5);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(sent).toHaveLength(2);
    expect(tracker.queued).toBe(0);
  });
});

describe('merging ranges', () => {
  it('unions overlapping and touching ranges and drops empty ones', () => {
    expect(
      mergeRanges([
        [10, 20],
        [0, 5],
        [5, 8],
        [18, 30],
        [40, 40],
      ]),
    ).toEqual([
      [0, 8],
      [10, 30],
    ]);
  });
  it('keeps at most as many ranges as the server accepts, the longest ones', () => {
    expect(MAX_RANGES).toBe(MAX_HEARTBEAT_RANGES); // pinned to the contract
    const many: Range[] = Array.from({ length: 20 }, (_, i) => [i * 10, i * 10 + 1 + (i % 3)]);
    const merged = mergeRanges(many);
    expect(merged).toHaveLength(MAX_HEARTBEAT_RANGES);
    expect(merged).toEqual([...merged].sort((a, b) => a[0] - b[0]));
  });
});

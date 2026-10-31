import type { HeartbeatRequest, HeartbeatResponse } from '@lms/backend/contracts';
import { ApiError } from '../../shared/api/client';

// Turns what the <video> element reports into heartbeats (step 8). No React and no hls.js in here: the tracker is
// plain TypeScript driven by the player, so its timing, queue and retry behaviour are unit tested with fake timers.
//
// What it sends: the media-time RANGES that were really played since the last heartbeat (a seek closes the range,
// so skipping ahead adds nothing), the position, the speed, a number per player instance (`seq`, duplicates are
// ignored by the server). One request at a time, in order. A heartbeat goes out every 30 s while playing and at
// pause / seek / end / page hide. A failed one stays queued and is retried with a growing delay; a long outage
// merges the queue into one request. A page that is hiding sends with `keepalive` (NOT sendBeacon: the API needs
// the X-Requested-With header on every POST, and a beacon cannot send one).

export type Range = [number, number];

/** The server accepts at most this many ranges per heartbeat (MAX_RANGES; a unit test pins the two together). */
export const MAX_RANGES = 16;

/** A timeupdate that jumps further than this (media seconds) is a seek, not playing. */
const JUMP_SECONDS = 5;
/** Beyond this many queued heartbeats the queue is merged into one. */
const QUEUE_LIMIT = 5;
export const HEARTBEAT_INTERVAL_MS = 30_000;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/** Sorts and unions ranges (touching ones too); at most MAX_RANGES, keeping the longest. */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = ranges
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .map(([a, b]) => [a, b] as Range)
    .sort((x, y) => x[0] - y[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 0.001) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  if (out.length <= MAX_RANGES) return out;
  return out
    .sort((x, y) => y[1] - y[0] - (x[1] - x[0]))
    .slice(0, MAX_RANGES)
    .sort((x, y) => x[0] - y[0]);
}

export interface TrackerOptions {
  videoId: string;
  send: (body: HeartbeatRequest, o: { keepalive: boolean }) => Promise<HeartbeatResponse>;
  /** every answer of the server (the screens update their numbers from it) */
  onResult?: (r: HeartbeatResponse) => void;
  /** the instructor replaced the video: this player is stale and stops reporting */
  onStale?: () => void;
  /** the session ended or the item is no longer open to this learner: reporting stops */
  onStopped?: (reason: 'signed_out' | 'not_allowed') => void;
  intervalMs?: number;
  streamId?: string;
}

export class HeartbeatTracker {
  private readonly streamId: string;
  private readonly intervalMs: number;
  private playing = false;
  private hidden = false;
  private stopped = false;
  private segStart: number | null = null;
  private last = 0;
  private rate = 1;
  private seq = 0;
  private pending: Range[] = [];
  private sentPosition = -1;
  private queue: HeartbeatRequest[] = [];
  private inflight = false;
  private attempt = 0;
  private tick: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: TrackerOptions) {
    this.streamId = o.streamId ?? crypto.randomUUID();
    this.intervalMs = o.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  }

  // ------------------------------------------------------------ what the player reports
  play(t: number, rate = this.rate): void {
    this.rate = rate;
    this.playing = true;
    this.segStart = t;
    this.last = t;
    if (!this.tick) this.tick = setInterval(() => this.onTick(), this.intervalMs);
  }

  timeupdate(t: number): void {
    if (!this.playing) {
      this.last = t;
      return;
    }
    if (this.segStart === null) {
      this.segStart = t;
    } else if (t < this.last - 0.5 || t - this.last > JUMP_SECONDS) {
      // a jump the player did not announce: the part before it is real, what lies between is not
      this.close();
      this.segStart = t;
    }
    this.last = t;
  }

  setRate(rate: number): void {
    this.rate = rate;
  }

  /** The viewer started a seek (`seeking`): what was played so far counts, the jump does not. */
  seeking(): void {
    this.close();
    this.flush();
  }

  seeked(t: number): void {
    this.last = t;
    if (this.playing) this.segStart = t;
  }

  pause(t: number): void {
    this.last = t;
    this.close();
    this.playing = false;
    this.stopTick();
    this.flush();
  }

  ended(t: number): void {
    this.last = t;
    this.close();
    this.playing = false;
    this.stopTick();
    this.flush();
  }

  /** The page is hiding (tab hidden, navigation, close): send now, with keepalive. */
  hide(): void {
    this.hidden = true;
    this.close();
    if (this.playing) this.segStart = this.last; // audio may go on in a background tab
    this.flush();
  }

  show(): void {
    this.hidden = false;
  }

  /** The player is leaving: a last heartbeat, then nothing more. */
  dispose(): void {
    this.close();
    this.playing = false;
    this.stopTick();
    this.hidden = true;
    this.flush();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  /** Heartbeats not yet delivered, the one in flight included. */
  get queued(): number {
    return this.queue.length;
  }

  // ------------------------------------------------------------ internals
  private onTick(): void {
    this.close();
    if (this.playing) this.segStart = this.last;
    this.flush();
  }

  private stopTick(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
  }

  /** Ends the current played range at the last known position. */
  private close(): void {
    if (this.segStart !== null && this.last > this.segStart + 0.2) {
      this.pending.push([round(this.segStart), round(this.last)]);
    }
    this.segStart = null;
  }

  /** Turns what has been collected into one queued heartbeat (nothing, when nothing changed). */
  private flush(): void {
    if (this.stopped) return;
    const ranges = mergeRanges(this.pending);
    const position = round(this.last);
    if (ranges.length === 0 && position === this.sentPosition) return;
    this.pending = [];
    this.sentPosition = position;
    this.queue.push({
      videoId: this.o.videoId,
      streamId: this.streamId,
      seq: ++this.seq,
      ranges,
      position,
      rate: Math.min(4, Math.max(0.25, this.rate)),
    });
    if (this.queue.length > QUEUE_LIMIT) this.mergeQueue();
    void this.pump();
  }

  /**
   * A long outage: everything queued after the request in flight becomes one heartbeat that carries every played
   * range (the newest position and number). The request in flight stays as it is: its answer removes exactly it.
   */
  private mergeQueue(): void {
    const keep = this.inflight ? 1 : 0;
    const rest = this.queue.slice(keep);
    const newest = rest[rest.length - 1];
    if (!newest || rest.length < 2) return;
    this.queue = [
      ...this.queue.slice(0, keep),
      { ...newest, ranges: mergeRanges(rest.flatMap((b) => b.ranges as Range[])) },
    ];
  }

  private async pump(): Promise<void> {
    if (this.inflight || this.stopped || this.retry) return;
    const beat = this.queue[0];
    if (!beat) return;
    this.inflight = true;
    try {
      const result = await this.o.send(beat, { keepalive: this.hidden });
      this.queue.shift();
      this.attempt = 0;
      this.inflight = false;
      this.o.onResult?.(result);
      void this.pump();
    } catch (err) {
      this.inflight = false;
      this.failed(err);
    }
  }

  private failed(err: unknown): void {
    const status = err instanceof ApiError ? err.status : 0;
    const code = err instanceof ApiError ? err.code : '';
    if (status === 401) {
      this.stop('signed_out');
      return;
    }
    if (status === 409 && code === 'video_changed') {
      this.stopped = true;
      this.queue = [];
      this.o.onStale?.();
      return;
    }
    if (status === 403 || status === 404) {
      this.stop('not_allowed');
      return;
    }
    if (status >= 400 && status < 500 && status !== 429) {
      // this heartbeat can never be accepted: drop it, the next one carries on
      this.queue.shift();
      void this.pump();
      return;
    }
    // offline, a 5xx or the rate limit: keep it and try again later
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.attempt++);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.pump();
    }, delay);
  }

  private stop(reason: 'signed_out' | 'not_allowed'): void {
    this.stopped = true;
    this.queue = [];
    this.stopTick();
    this.o.onStopped?.(reason);
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

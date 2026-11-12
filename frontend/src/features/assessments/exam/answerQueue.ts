import type { SaveRequest, SaveResponse } from '@lms/backend/contracts';
import { ApiError, busyDelayMs } from '../../../shared/api/client';

// The answer queue of the exam screen (step 9). Plain TypeScript, no React: its timing, retry, durability and
// revision behaviour are unit tested with fake timers and an in-memory storage.
//
//  * SAVE ON CHANGE, debounced (~1.8 s), and at once when the learner leaves a question, hides the page, goes offline or
//    online, and before submitting. Nothing is sent on a timer when nothing changed.
//  * DURABLE: every change is written to storage BEFORE it is sent, and removed only when the server acknowledged it. A
//    reload, a crash or a dead battery while offline loses nothing: on load the stored queue is merged with the server's
//    state and FLUSHED before the screen says "Saved".
//  * REVISIONS: every change carries a revision above the one the client knows. After a resume the client continues from
//    the SERVER's revision (never from its own counter), so a change made on device B after device A wins. An answer the
//    server refused as older comes back in `stale` and replaces what the screen shows.
//  * BUSY SERVER (503): the same request is sent again after Retry-After, with growing jittered waits, carrying the signed
//    RECEIPT the server gave with the first refusal (proof of WHEN the request arrived, so the deadline check counts from
//    then, not from when the retry was finally served). The receipt is kept with the queued answers, durably.
//  * One request at a time, in order. A failed one stays queued and is retried with a growing delay; the same request
//    twice changes nothing on the server (same revision), so a lost answer is just sent again.

export interface Answer {
  o?: string[];
  n?: number;
  t?: string;
}

export interface QuestionState {
  position: number;
  answer: Answer | null;
  flagged: boolean;
  /** the server's revision of this answer */
  rev: number;
}

export interface Entry {
  position: number;
  answer: Answer | null;
  rev: number;
  flagged: boolean;
  at: number;
  spentMs: number;
}

export type EventKind = 'hidden' | 'visible' | 'blur' | 'focus' | 'offline' | 'online' | 'resume';

interface Persisted {
  v: 1;
  savedAt: number;
  pending: Entry[];
  events: { kind: EventKind; at: number }[];
  /** the receipt of a refused (503 busy) request, until a request is accepted */
  receipt?: string | null;
}

export interface QueueStorage {
  read(key: string): Persisted | null;
  write(key: string, state: Persisted): void;
  remove(key: string): void;
}

/** localStorage, with every failure (private mode, a full quota) swallowed: the queue still works in memory. */
export function localStorageQueue(): QueueStorage {
  const ls = (): Storage | null => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  };
  return {
    read(key) {
      try {
        const raw = ls()?.getItem(key);
        if (!raw) return null;
        const v = JSON.parse(raw) as Persisted;
        return v?.v === 1 && Array.isArray(v.pending) ? v : null;
      } catch {
        return null;
      }
    },
    write(key, state) {
      try {
        ls()?.setItem(key, JSON.stringify(state));
      } catch {
        // storage full or blocked: keep going without the safety net
      }
    },
    remove(key) {
      try {
        ls()?.removeItem(key);
      } catch {
        // nothing to do
      }
    },
  };
}

export type SaveStatus = 'saved' | 'saving' | 'busy' | 'offline' | 'stopped';

export interface QueueOptions {
  attemptId: string;
  send: (
    body: SaveRequest,
    o: { keepalive: boolean; receipt: string | null },
  ) => Promise<SaveResponse>;
  storage?: QueueStorage;
  now?: () => number;
  debounceMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** at most this many busy answers in a row are waited out inside one flush (default 12) */
  busyAttempts?: number;
  /** tests */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onStatus?: (s: SaveStatus) => void;
  /** answers the server already had in a newer revision: show these */
  onStale?: (items: QuestionState[]) => void;
  /** the attempt is over on the server (submitted, or closed at the deadline) */
  onClosed?: (kind: 'submitted' | 'closed') => void;
  /** the session ended or the attempt is not ours any more: saving stops quietly */
  onStopped?: () => void;
  /** every answer carries the server clock and the deadline */
  onClock?: (serverNow: string, deadlineAt: string) => void;
}

const BATCH = 100;
const EVENT_BATCH = 50;
const MAX_EVENTS = 300;
const KEEP_MS = 48 * 3600_000;

export const queueKey = (attemptId: string) => `lms:exam:${attemptId}`;

export class AnswerQueue {
  private readonly storage: QueueStorage;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly retryBase: number;
  private readonly retryMax: number;
  private readonly key: string;
  private current = new Map<number, QuestionState>();
  private pending = new Map<number, Entry>();
  private inflight = new Map<number, number>();
  private events: { kind: EventKind; at: number }[] = [];
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private receipt: string | null = null;
  private busy = false;
  private disposed = false;
  private running: Promise<void> | null = null;
  private rerun = false;
  private stopped = false;
  private offline = false;
  private loaded = false;
  private last: SaveStatus | null = null;

  constructor(private readonly o: QueueOptions) {
    this.storage = o.storage ?? localStorageQueue();
    this.now = o.now ?? (() => Date.now());
    this.debounceMs = o.debounceMs ?? 1800;
    this.retryBase = o.retryBaseMs ?? 2000;
    this.retryMax = o.retryMaxMs ?? 30_000;
    this.key = queueKey(o.attemptId);
  }

  // ------------------------------------------------------------------ start: the server's state + what is stored here
  /**
   * `server`: the questions as the server has them (answer, flag, revision). Whatever this device stored and the server
   * does not have yet (a higher revision) is kept, shown, and sent BEFORE the status says "Saved". Returns the merged
   * state the screen should show.
   */
  load(server: readonly QuestionState[]): QuestionState[] {
    this.current = new Map(server.map((q) => [q.position, { ...q }]));
    const stored = this.storage.read(this.key);
    if (stored && this.now() - stored.savedAt < KEEP_MS) {
      for (const e of stored.pending) {
        const have = this.current.get(e.position);
        if (!have || e.rev > have.rev) {
          this.current.set(e.position, {
            position: e.position,
            answer: e.answer,
            flagged: e.flagged,
            rev: e.rev,
          });
          this.pending.set(e.position, { ...e });
        }
      }
      this.events = stored.events.slice(0, MAX_EVENTS);
      this.receipt = stored.receipt ?? null;
    }
    this.loaded = true;
    this.persist();
    this.emit();
    if (this.pending.size > 0 || this.events.length > 0) void this.flushNow();
    return this.snapshot();
  }

  snapshot(): QuestionState[] {
    return [...this.current.values()].sort((a, b) => a.position - b.position);
  }

  get status(): SaveStatus {
    if (this.stopped) return 'stopped';
    if (this.busy) return 'busy';
    if (this.offline) return 'offline';
    // events that wait for the next save do not make the status "saving": the answers are what the learner cares about
    if (!this.loaded || this.pending.size > 0 || this.running !== null) return 'saving';
    return 'saved';
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  // ------------------------------------------------------------------ changes
  /** The learner changed an answer and / or the flag of a question. */
  set(position: number, patch: { answer?: Answer | null; flagged?: boolean }): void {
    if (this.stopped) return;
    const cur = this.current.get(position) ?? { position, answer: null, flagged: false, rev: 0 };
    const inflight = this.inflight.get(position);
    // a change that was never sent is rewritten in place; one that is on its way is followed by the next revision
    const queued = this.unsent(position);
    const rev = queued ? queued.rev : Math.max(cur.rev, inflight ?? 0) + 1;
    const next: QuestionState = {
      position,
      answer: patch.answer !== undefined ? patch.answer : cur.answer,
      flagged: patch.flagged ?? cur.flagged,
      rev,
    };
    this.current.set(position, next);
    this.pending.set(position, {
      position,
      answer: next.answer,
      flagged: next.flagged,
      rev,
      at: this.now(),
      spentMs: queued?.spentMs ?? 0,
    });
    this.persist();
    this.schedule();
    this.emit();
  }

  /** Time spent on a question since the learner arrived (added to the next save of it; at least 3 s to count). */
  addSpent(position: number, ms: number): void {
    if (this.stopped || ms < 3000) return;
    const queued = this.unsent(position);
    if (queued) {
      queued.spentMs = Math.min(300_000, queued.spentMs + Math.round(ms));
    } else {
      const cur = this.current.get(position) ?? { position, answer: null, flagged: false, rev: 0 };
      const rev = Math.max(cur.rev, this.inflight.get(position) ?? 0) + 1;
      this.current.set(position, { ...cur, rev });
      this.pending.set(position, {
        position,
        answer: cur.answer,
        flagged: cur.flagged,
        rev,
        at: this.now(),
        spentMs: Math.min(300_000, Math.round(ms)),
      });
    }
    this.persist();
    this.schedule();
    this.emit();
  }

  event(kind: EventKind): void {
    if (this.stopped || this.events.length >= MAX_EVENTS) return;
    this.events.push({ kind, at: this.now() });
    this.persist();
    this.emit();
    // an event is worth a request of its own only when the page is going away or the connection came back; the others
    // (blur, focus, a reload) travel with the next save
    if (kind === 'hidden' || kind === 'online') void this.flushNow();
  }

  /** The queued entry of a question, unless that very revision is out on the wire right now. */
  private unsent(position: number): Entry | undefined {
    const queued = this.pending.get(position);
    return queued && this.inflight.get(position) !== queued.rev ? queued : undefined;
  }

  // ------------------------------------------------------------------ sending
  private schedule(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.flushNow();
    }, this.debounceMs);
  }

  /** Sends everything queued now (leaving a question, hiding the page, submitting). Resolves when the queue is empty or stuck. */
  flushNow(o: { keepalive?: boolean } = {}): Promise<void> {
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = null;
    }
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.loop(o.keepalive === true).finally(() => {
      this.running = null;
      this.emit();
    });
    this.emit();
    return this.running;
  }

  /** The connection is back: try at once instead of waiting for the retry timer. */
  retryNow(): void {
    this.failures = 0;
    this.offline = false;
    void this.flushNow();
  }

  private async loop(keepalive: boolean): Promise<void> {
    do {
      this.rerun = false;
      while (!this.stopped && (this.pending.size > 0 || this.events.length > 0)) {
        const batch = [...this.pending.values()]
          .sort((a, b) => a.position - b.position)
          .slice(0, BATCH);
        const events = this.events.slice(0, EVENT_BATCH);
        for (const e of batch) this.inflight.set(e.position, e.rev);
        let res: SaveResponse;
        try {
          this.busy = false;
          res = await this.o.send(
            {
              answers: batch.map((e) => ({
                position: e.position,
                answer: e.answer,
                rev: e.rev,
                flagged: e.flagged,
                at: e.at,
                spentMs: e.spentMs,
              })),
              events,
            },
            { keepalive, receipt: this.receipt },
          );
        } catch (err) {
          this.inflight.clear();
          // the server is busy: wait, and send again with the receipt, inside this flush (a submit waits for the answers)
          if (await this.waitOutBusy(err)) continue;
          this.fail(err);
          return;
        }
        this.inflight.clear();
        this.failures = 0;
        this.offline = false;
        this.busy = false;
        this.busyRun = 0;
        if (this.receipt) {
          this.receipt = null;
          this.persist();
        }
        if (res.serverNow && res.deadlineAt) this.o.onClock?.(res.serverNow, res.deadlineAt);
        if (res.result !== 'ok') {
          this.stopped = true;
          this.receipt = null;
          this.pending.clear();
          this.events = [];
          this.storage.remove(this.key);
          this.o.onClosed?.(res.result);
          return;
        }
        // the server's newer answers replace ours
        const stale: QuestionState[] = [];
        for (const s of res.stale) {
          const item: QuestionState = {
            position: s.position,
            answer: s.answer as Answer | null,
            flagged: s.flagged,
            rev: s.rev,
          };
          const queued = this.pending.get(s.position);
          // a change made while this request was out and above the server's revision stays queued
          if (!queued || queued.rev <= s.rev) {
            this.pending.delete(s.position);
            this.current.set(s.position, item);
            stale.push(item);
          }
        }
        // what the server took is done, unless the learner changed it again meanwhile
        for (const e of batch) {
          const queued = this.pending.get(e.position);
          if (queued && queued.rev === e.rev) this.pending.delete(e.position);
        }
        this.events = this.events.slice(events.length);
        this.persist();
        if (stale.length > 0) this.o.onStale?.(stale);
      }
    } while (this.rerun && !this.stopped);
  }

  private busyRun = 0;

  /**
   * A 503 busy: keep the receipt (the FIRST one: later refusals hand back the same), say so, wait Retry-After plus a growing
   * jittered delay, and let the loop send the same work again. false = not a busy answer, or too many in a row.
   */
  private async waitOutBusy(err: unknown): Promise<boolean> {
    if (!(err instanceof ApiError) || err.status !== 503 || err.code !== 'busy') return false;
    if (this.stopped || this.disposed || this.busyRun >= (this.o.busyAttempts ?? 12)) return false;
    this.busyRun += 1;
    if (err.receipt && !this.receipt) {
      this.receipt = err.receipt;
      this.persist();
    }
    this.busy = true;
    this.emit();
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    await sleep(busyDelayMs(this.busyRun, err.retryAfterSeconds, this.o.random));
    return !this.stopped && !this.disposed;
  }

  private fail(err: unknown): void {
    const status = err instanceof ApiError ? err.status : 0;
    if (
      status === 401 ||
      status === 403 ||
      status === 404 ||
      (status >= 400 && status < 500 && status !== 408 && status !== 429)
    ) {
      // not ours any more / signed out / refused: keep what is stored, stop asking
      this.stopped = true;
      this.o.onStopped?.();
      return;
    }
    // no network, a timeout or a server error: stay queued and try again later
    this.offline = true;
    this.failures += 1;
    const delay = Math.min(this.retryMax, this.retryBase * 2 ** (this.failures - 1));
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.flushNow();
    }, delay);
  }

  // ------------------------------------------------------------------ storage and status
  private persist(): void {
    if (this.pending.size === 0 && this.events.length === 0 && !this.receipt) {
      this.storage.remove(this.key);
      return;
    }
    this.storage.write(this.key, {
      v: 1,
      savedAt: this.now(),
      pending: [...this.pending.values()],
      events: this.events,
      receipt: this.receipt,
    });
  }

  private emit(): void {
    const s = this.status;
    if (s !== this.last) {
      this.last = s;
      this.o.onStatus?.(s);
    }
  }

  /** After a submit the stored copy has no use (and must not linger on a shared computer). */
  discard(): void {
    this.stopped = true;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.retry) clearTimeout(this.retry);
    this.pending.clear();
    this.events = [];
    this.storage.remove(this.key);
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.retry) clearTimeout(this.retry);
  }
}

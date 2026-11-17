import type { UnreadPoll } from './notifications.api';

/**
 * The bell's poll, plain TypeScript (unit tested with fake timers). Cheap by design:
 *   - only while the tab is VISIBLE: a hidden tab never polls; becoming visible (or the window getting focus) polls at once;
 *   - every 60 s with +-10 % jitter, so a lab full of browsers does not tick together;
 *   - after 30 minutes without input (pointer / key), every 5 minutes;
 *   - a conditional request: the server answers 304 when the count and the newest notification are unchanged;
 *   - 401 / 403 (signed out, session revoked) stop it for good; any other error waits for the next tick.
 * WebSockets / SSE are deliberately not used yet (ADR 0021): at 60 s a whole college is a few hundred cheap requests a second.
 */
export interface PollerEnv {
  visibilityState(): DocumentVisibilityState;
  onVisibilityChange(cb: () => void): () => void;
  onFocus(cb: () => void): () => void;
  onActivity(cb: () => void): () => void;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
  random(): number;
}

export interface PollerOptions {
  poll: (etag: string | null) => Promise<UnreadPoll>;
  onCount: (unread: number) => void;
  env?: PollerEnv;
  intervalMs?: number;
  idleIntervalMs?: number;
  idleAfterMs?: number;
  /** a burst of focus / visibility events polls at most this often */
  minGapMs?: number;
}

export function browserPollerEnv(): PollerEnv {
  return {
    visibilityState: () => document.visibilityState,
    onVisibilityChange: (cb) => {
      document.addEventListener('visibilitychange', cb);
      return () => document.removeEventListener('visibilitychange', cb);
    },
    onFocus: (cb) => {
      window.addEventListener('focus', cb);
      return () => window.removeEventListener('focus', cb);
    },
    onActivity: (cb) => {
      const opts = { passive: true } as const;
      window.addEventListener('pointerdown', cb, opts);
      window.addEventListener('keydown', cb, opts);
      return () => {
        window.removeEventListener('pointerdown', cb);
        window.removeEventListener('keydown', cb);
      };
    },
    setTimeout: (cb, ms) => window.setTimeout(cb, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
    now: () => Date.now(),
    random: () => Math.random(),
  };
}

export function createNotificationPoller(opts: PollerOptions) {
  const env = opts.env ?? browserPollerEnv();
  const interval = opts.intervalMs ?? 60_000;
  const idleInterval = opts.idleIntervalMs ?? 300_000;
  const idleAfter = opts.idleAfterMs ?? 30 * 60_000;
  const minGap = opts.minGapMs ?? 5_000;

  let etag: string | null = null;
  let timer: unknown = null;
  let running = false;
  let stopped = false;
  let lastPoll = Number.NEGATIVE_INFINITY;
  let lastInput = env.now();
  const unsubscribe: (() => void)[] = [];

  const visible = () => env.visibilityState() === 'visible';
  const clear = () => {
    if (timer !== null) env.clearTimeout(timer);
    timer = null;
  };
  /** the next delay: the base interval (or the idle one), +-10 % jitter */
  const nextDelay = () => {
    const base = env.now() - lastInput > idleAfter ? idleInterval : interval;
    return Math.round(base * (0.9 + env.random() * 0.2));
  };
  const schedule = () => {
    clear();
    if (stopped || !visible()) return;
    timer = env.setTimeout(() => void tick(), nextDelay());
  };

  async function tick(): Promise<void> {
    timer = null;
    if (stopped || running || !visible()) return;
    running = true;
    lastPoll = env.now();
    try {
      const r = await opts.poll(etag);
      if (r.kind === 'signed-out') {
        stop();
        return;
      }
      if (r.kind === 'changed') {
        etag = r.etag;
        opts.onCount(r.unread);
      }
    } catch {
      // the next tick tries again
    } finally {
      running = false;
    }
    schedule();
  }

  /** visible again / focus: poll now (unless we just did), then on the normal rhythm */
  const wake = () => {
    if (stopped) return;
    if (!visible()) {
      clear();
      return;
    }
    if (env.now() - lastPoll < minGap) {
      if (timer === null && !running) schedule();
      return;
    }
    clear();
    void tick();
  };

  function stop(): void {
    stopped = true;
    clear();
    for (const u of unsubscribe.splice(0)) u();
  }

  return {
    start(): void {
      unsubscribe.push(
        env.onVisibilityChange(wake),
        env.onFocus(wake),
        env.onActivity(() => {
          lastInput = env.now();
        }),
      );
      if (visible()) void tick();
    },
    stop,
    /** after the user read notifications here: poll at once (the count changed) */
    refresh(): void {
      lastPoll = Number.NEGATIVE_INFINITY;
      wake();
    },
    get stopped() {
      return stopped;
    },
  };
}
export type NotificationPoller = ReturnType<typeof createNotificationPoller>;

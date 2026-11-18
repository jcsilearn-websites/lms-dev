import type { RateLimitStore } from './store';

// THE LOCAL TIER (step 14a). High-rate routes (heartbeats, exam autosave, every signed-in request) must not pay a database round trip
// per request: the decision is made from LOCAL state, synchronously, and the hits are folded into the shared store in BATCHES:
//   decision = shared total as of the last sync + hits sent but not yet acknowledged + hits since   (> max: limited)
//   sync     = one `shared.hit(key, windowMs, delta)` in the background when `delta` reaches a tenth of the limit, or the last sync is
//              older than `syncIntervalMs` and there is something to send. The FIRST hit of a window never syncs (nothing to share yet).
// Accuracy: an instance is blind to the others' hits for at most one sync interval or a tenth of the limit, whichever comes first, so
// N instances can together admit about `max + N * max / 10` in a window; for a limit that exists to stop runaway clients that is fine
// (docs/adr/0022). A failed sync is not an error for the request (the limiter degrades to per-instance counting, `onSyncError`).

export interface BatchedLimit {
  count: number;
  ttlMs: number;
}

interface Entry {
  windowStart: number;
  windowMs: number;
  /** the shared total at the last acknowledged sync */
  base: number;
  /** hits sent to the shared store, not acknowledged yet */
  inflight: number;
  /** hits not sent yet */
  pending: number;
  lastSync: number;
  syncing: boolean;
}

export interface BatchedLimiter {
  hit(key: string, windowMs: number, max: number): BatchedLimit;
  size(): number;
}

export function createBatchedLimiter(opts: {
  /** null = local only (development) */
  shared: RateLimitStore | null;
  syncIntervalMs?: number;
  maxKeys?: number;
  now?: () => number;
  onSyncError?: (err: unknown) => void;
}): BatchedLimiter {
  const now = opts.now ?? Date.now;
  const syncIntervalMs = opts.syncIntervalMs ?? 1000;
  const maxKeys = opts.maxKeys ?? 50_000;
  const entries = new Map<string, Entry>();

  const prune = (t: number) => {
    for (const [k, e] of entries) {
      if (e.windowStart + e.windowMs <= t && !e.syncing) entries.delete(k);
    }
    while (entries.size >= maxKeys) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  const flush = (key: string, e: Entry, t: number) => {
    const shared = opts.shared;
    if (!shared) return;
    e.inflight = e.pending;
    e.pending = 0;
    e.syncing = true;
    e.lastSync = t;
    shared
      .hit(key, e.windowMs, e.inflight)
      .then((r) => {
        e.base = r.count;
        e.inflight = 0;
        // align this instance's window with the shared one, so they all end together
        e.windowStart = now() - (e.windowMs - r.ttlMs);
      })
      .catch((err: unknown) => {
        e.pending += e.inflight;
        e.inflight = 0;
        opts.onSyncError?.(err);
      })
      .finally(() => {
        e.syncing = false;
        e.lastSync = now();
      });
  };

  return {
    hit(key, windowMs, max) {
      const t = now();
      let e = entries.get(key);
      if (!e || e.windowStart + e.windowMs <= t) {
        if (!e && entries.size >= maxKeys) prune(t);
        e = {
          windowStart: t,
          windowMs,
          base: 0,
          inflight: 0,
          pending: 0,
          lastSync: t,
          syncing: false,
        };
        entries.set(key, e);
      }
      e.pending += 1;
      const count = e.base + e.inflight + e.pending;
      const batchFull = e.pending >= Math.max(2, Math.ceil(max / 10));
      const stale = t - e.lastSync >= syncIntervalMs && e.pending > 1;
      if (opts.shared && !e.syncing && (batchFull || stale)) flush(key, e, t);
      return { count, ttlMs: Math.max(0, e.windowStart + e.windowMs - t) };
    },
    size: () => entries.size,
  };
}

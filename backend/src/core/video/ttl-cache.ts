/**
 * A small in-memory cache with a time-to-live per entry and a hard size bound (the oldest entry goes first when
 * it is full). Used to remember that a playback request's session was validated, so 6-second segment requests
 * do not each query the database.
 */
export interface TtlCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  delete(key: string): void;
  readonly size: number;
}

export function createTtlCache<V>(opts: {
  ttlMs: number;
  max: number;
  now?: () => number;
}): TtlCache<V> {
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, { value: V; expires: number }>();
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (hit.expires <= now()) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      if (opts.ttlMs <= 0) return;
      entries.delete(key); // re-insert: the Map keeps insertion order, so the first key is the oldest
      entries.set(key, { value, expires: now() + opts.ttlMs });
      while (entries.size > opts.max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    delete(key) {
      entries.delete(key);
    },
    get size() {
      return entries.size;
    },
  };
}

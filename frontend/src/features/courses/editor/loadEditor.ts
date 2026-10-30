// The ONLY place that imports the editor chunk, and only through a dynamic import(): the bundler gives it its own
// chunk, so no route that does not use it pays for it. The builder calls `prefetchEditor()` once it has loaded.
// (Tested by scripts/check-bundle-size.mjs: the editor must not be reachable from the entry, login, learner or
// admin routes.)

export const loadEditor = () => import('./RichTextEditor');

let started = false;

/**
 * Starts loading the editor chunk when the browser is idle, so opening a text item feels instant. A no-op the
 * second time, and on a slow connection with data saving on (the user asked us not to).
 */
export function prefetchEditor(): void {
  if (started) return;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return;
  started = true;
  const start = () => void loadEditor().catch(() => (started = false));
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
  };
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(start, { timeout: 4000 });
  else setTimeout(start, 1500);
}

/** For tests. */
export function resetPrefetch(): void {
  started = false;
}

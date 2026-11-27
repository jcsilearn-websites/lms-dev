// Sign-out (and a 401) empties EVERY cache of the browser for this origin and tells the worker to do the same: nothing a person's session touched stays
// behind on a shared computer. The caches only ever hold public build files and the HTML shell, never an API answer (sw/sw.js refuses to store one),
// but "clear everything on sign-out" is the rule, not a judgement call per cache. Never throws.

export async function clearServiceWorkerCaches(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') {
      for (const key of await caches.keys()) await caches.delete(key);
    }
  } catch {
    // Cache Storage blocked (private mode): nothing to clear
  }
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_CACHES' });
  } catch {
    // no worker
  }
}

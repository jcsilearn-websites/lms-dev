import { clearServiceWorkerCaches } from './clearCaches';
import { isExamActive, onExamIdle } from './examLock';

// Registering the service worker and applying its updates (docs/adr/0025-service-worker.md). Four rules:
//   1. Registration happens in IDLE TIME after the page has loaded: it never competes with the first paint (the bundle and Lighthouse budgets hold).
//   2. A new version takes over only when the page asks, and NEVER while an exam is running here (examLock) or in another tab (the worker asks every page).
//      It is applied the moment the last exam ends.
//   3. /sw-control.json is read at start-up with no-store: a published order to `unregister` removes every worker and clears every cache, and nothing is
//      registered again until the order is withdrawn. (The worker reads the same file itself: a worker whose page is broken still obeys.)
//   4. VITE_SERVICE_WORKER=off at BUILD time turns registration off entirely (the build then ships the retiring worker, which removes installed ones).

export interface SwControl {
  unregister?: boolean;
  deleteCaches?: boolean;
}

export interface SwDeps {
  container: ServiceWorkerContainer;
  isExamActive: () => boolean;
  onExamIdle: (listener: () => void) => () => void;
  reload: () => void;
  fetchControl: () => Promise<SwControl | null>;
  clearCaches: () => Promise<void>;
  /** runs `fn` later (a timer) */
  later: (fn: () => void, ms: number) => void;
}

/** Answers the worker's "is an exam running here?" (it asks before it takes over or removes itself). Installed in every tab, always. */
export function answerExamQueries(
  container: Pick<ServiceWorkerContainer, 'addEventListener'>,
  active: () => boolean = isExamActive,
): void {
  container.addEventListener('message', (event) => {
    const data = (event as MessageEvent).data as { type?: string } | null;
    if (data?.type !== 'EXAM_BUSY?') return;
    const port = (event as MessageEvent).ports[0];
    port?.postMessage(active());
  });
}

export async function fetchControlFile(): Promise<SwControl | null> {
  try {
    const res = await fetch('/sw-control.json', { cache: 'no-store', credentials: 'omit' });
    return res.ok ? ((await res.json()) as SwControl) : null;
  } catch {
    return null;
  }
}

/** Starts the worker: obeys the control file, registers, and wires the update flow. Resolves when registration is done (or skipped). */
export async function startServiceWorker(
  deps: SwDeps,
): Promise<{ registered: boolean; reason?: string }> {
  const control = await deps.fetchControl();
  if (control?.unregister === true || control?.deleteCaches === true) {
    // an exam is never interrupted, not even by the kill switch: it waits for the exam to end
    if (deps.isExamActive()) {
      const stop = deps.onExamIdle(() => {
        stop();
        void startServiceWorker(deps);
      });
      return { registered: false, reason: 'deferred: an exam is running' };
    }
    await deps.clearCaches();
    if (control.unregister === true) {
      for (const reg of await deps.container.getRegistrations()) await reg.unregister();
      return { registered: false, reason: 'unregistered by sw-control.json' };
    }
  }

  const registration = await deps.container.register('/sw.js', {
    scope: '/',
    updateViaCache: 'none',
  });
  let applying = false;
  let pending: ServiceWorker | null = null;

  const tryApply = () => {
    if (!pending) return;
    if (deps.isExamActive()) {
      const stop = deps.onExamIdle(() => {
        stop();
        tryApply();
      });
      return;
    }
    applying = true;
    pending.postMessage({ type: 'SKIP_WAITING' });
  };
  const offer = (worker: ServiceWorker | null) => {
    if (!worker || !deps.container.controller) return; // the first install has nothing to replace
    pending = worker;
    tryApply();
  };

  // watch a worker that is installing: the delayed registration may meet one whose `updatefound` was fired long before this code ran
  const watch = (worker: ServiceWorker | null) => {
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed') offer(registration.waiting ?? worker);
    });
  };
  offer(registration.waiting);
  watch(registration.installing);
  registration.addEventListener('updatefound', () => watch(registration.installing));
  // look for a newer script now, once per page load, whatever the browser's own navigation heuristic does
  void registration.update?.().catch(() => undefined);
  deps.container.addEventListener('message', (event) => {
    // another tab is in an exam: the worker stayed waiting; ask again later
    if (((event as MessageEvent).data as { type?: string } | null)?.type === 'UPDATE_DEFERRED') {
      applying = false;
      deps.later(tryApply, 60_000);
    }
  });
  let reloaded = false;
  deps.container.addEventListener('controllerchange', () => {
    if (!applying || reloaded) return; // a change we did not ask for is not ours to reload for
    reloaded = true;
    if (deps.isExamActive()) {
      const stop = deps.onExamIdle(() => {
        stop();
        deps.reload();
      });
      return;
    }
    deps.reload();
  });
  return { registered: true };
}

export const serviceWorkerEnabled = (): boolean =>
  import.meta.env.VITE_SERVICE_WORKER !== 'off' &&
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  typeof window !== 'undefined' &&
  window.isSecureContext;

/** After the page has been loaded for REGISTER_DELAY_MS, and then in idle time: the install fetches files and must not compete with the page the person is using. */
export const REGISTER_DELAY_MS = 12_000;
const idle = (fn: () => void) => {
  setTimeout(() => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(fn, { timeout: 10_000 });
    else fn();
  }, REGISTER_DELAY_MS);
};

/** Called once at start-up: registers in idle time, after the page has loaded. A no-op when the build turned the worker off. */
export function scheduleServiceWorker(): void {
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator)
    answerExamQueries(navigator.serviceWorker);
  if (!serviceWorkerEnabled()) return;
  const start = () =>
    idle(() => {
      void startServiceWorker({
        container: navigator.serviceWorker,
        isExamActive,
        onExamIdle,
        reload: () => window.location.reload(),
        fetchControl: fetchControlFile,
        clearCaches: clearServiceWorkerCaches,
        later: (fn, ms) => {
          setTimeout(fn, ms);
        },
      }).catch(() => {
        // a failed registration must never break the app: it simply has no worker
      });
    });
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

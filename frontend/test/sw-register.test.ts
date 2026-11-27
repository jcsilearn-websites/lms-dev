import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearServiceWorkerCaches } from '../src/sw/clearCaches';
import { acquireExamLock, isExamActive, onExamIdle } from '../src/sw/examLock';
import {
  answerExamQueries,
  REGISTER_DELAY_MS,
  type SwControl,
  type SwDeps,
  scheduleServiceWorker,
  serviceWorkerEnabled,
  startServiceWorker,
} from '../src/sw/register';

// The page side of the service worker: when it registers, when an update is applied (never in an exam), what the kill switch does, what sign-out clears.

class FakeWorker extends EventTarget {
  state = 'installing';
  posted: unknown[] = [];
  postMessage(m: unknown) {
    this.posted.push(m);
  }
}
class FakeRegistration extends EventTarget {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  unregister = vi.fn(async () => true);
  update = vi.fn(async () => undefined);
}
class FakeContainer extends EventTarget {
  controller: object | null = null;
  registration = new FakeRegistration();
  registered: { url: string; options: unknown }[] = [];
  existing: FakeRegistration[] = [];
  async register(url: string, options: unknown) {
    this.registered.push({ url, options });
    return this.registration;
  }
  async getRegistrations() {
    return this.existing;
  }
  /** an update arrives: a new worker installs while a controller exists */
  deliver(worker = new FakeWorker()) {
    this.registration.installing = worker;
    this.registration.dispatchEvent(new Event('updatefound'));
    worker.state = 'installed';
    this.registration.waiting = worker;
    worker.dispatchEvent(new Event('statechange'));
    return worker;
  }
  message(data: unknown) {
    this.dispatchEvent(Object.assign(new Event('message'), { data, ports: [] }));
  }
}

const releases: Array<() => void> = [];
const holdExam = () => {
  const release = acquireExamLock();
  releases.push(release);
  return release;
};
afterEach(() => {
  for (const r of releases.splice(0)) r();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function deps(over: Partial<SwDeps> & { control?: SwControl | null } = {}) {
  const container = (over.container as unknown as FakeContainer) ?? new FakeContainer();
  const reloads: number[] = [];
  const later: Array<() => void> = [];
  const clear = vi.fn(async () => undefined);
  const d: SwDeps = {
    container: container as unknown as ServiceWorkerContainer,
    isExamActive,
    onExamIdle,
    reload: () => {
      reloads.push(1);
    },
    fetchControl: async () => (over.control === undefined ? { unregister: false } : over.control),
    clearCaches: clear,
    later: (fn) => {
      later.push(fn);
    },
    ...over,
  };
  return { d, container, reloads, later, clear };
}

describe('registration', () => {
  it('registers /sw.js at the root scope and tells the browser never to read the script from the HTTP cache', async () => {
    const { d, container } = deps();
    expect(await startServiceWorker(d)).toEqual({ registered: true });
    expect(container.registered).toEqual([
      { url: '/sw.js', options: { scope: '/', updateViaCache: 'none' } },
    ]);
  });

  it('is off when the build says so (VITE_SERVICE_WORKER=off): nothing is scheduled, nothing registers', async () => {
    vi.stubEnv('VITE_SERVICE_WORKER', 'off');
    expect(serviceWorkerEnabled()).toBe(false);
    const register = vi.fn();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { addEventListener: vi.fn(), register },
    });
    scheduleServiceWorker();
    await new Promise((r) => setTimeout(r, 20));
    expect(register).not.toHaveBeenCalled();
  });

  it('registers in IDLE time, after the page has loaded, never synchronously at start-up', async () => {
    const register = vi.fn(async () => new FakeRegistration());
    const container = Object.assign(new EventTarget(), {
      register,
      getRegistrations: async () => [],
      controller: null,
    });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"unregister":false}'));
    let idleRun: (() => void) | null = null;
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: (fn: () => void) => {
        idleRun = fn;
        return 1;
      },
    });
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); // not requestIdleCallback: the test installs its own
    scheduleServiceWorker();
    await vi.advanceTimersByTimeAsync(REGISTER_DELAY_MS * 3);
    expect(idleRun).toBeNull(); // the page has not loaded: nothing is scheduled, however long we wait
    window.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(REGISTER_DELAY_MS - 1);
    expect(idleRun).toBeNull(); // not before the delay after load
    await vi.advanceTimersByTimeAsync(2);
    expect(idleRun).not.toBeNull(); // then asked for idle time
    expect(register).not.toHaveBeenCalled(); // and not run until the browser is idle
    vi.useRealTimers();
    (idleRun as unknown as () => void)();
    await vi.waitFor(() => expect(register).toHaveBeenCalledOnce());
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
  });
});

describe('an update arrives', () => {
  it('and nothing is running: it is applied at once (SKIP_WAITING), and the page reloads ONCE when the new worker has taken over', async () => {
    const { d, container, reloads } = deps();
    container.controller = {};
    await startServiceWorker(d);
    const worker = container.deliver();
    expect(worker.posted).toEqual([{ type: 'SKIP_WAITING' }]);
    container.dispatchEvent(new Event('controllerchange'));
    container.dispatchEvent(new Event('controllerchange'));
    expect(reloads).toHaveLength(1);
  });

  it('a worker that is ALREADY installing when the page registers (its updatefound was missed) is still offered once it has installed', async () => {
    const { d, container } = deps();
    container.controller = {};
    const worker = new FakeWorker();
    container.registration.installing = worker; // update found long before the delayed registration ran
    await startServiceWorker(d);
    worker.state = 'installed';
    container.registration.waiting = worker;
    worker.dispatchEvent(new Event('statechange'));
    expect(worker.posted).toEqual([{ type: 'SKIP_WAITING' }]);
  });

  it('asks the browser to look for a newer script once, itself', async () => {
    const { d, container } = deps();
    await startServiceWorker(d);
    expect(container.registration.update).toHaveBeenCalledOnce();
  });

  it('the very first install is not an update: no SKIP_WAITING, no reload', async () => {
    const { d, container, reloads } = deps();
    await startServiceWorker(d); // no controller yet
    const worker = container.deliver();
    expect(worker.posted).toEqual([]);
    container.dispatchEvent(new Event('controllerchange'));
    expect(reloads).toHaveLength(0);
  });

  it('DURING AN EXAM it is not applied: the exam keeps running on the old version, and the update is applied only when the exam ends', async () => {
    const { d, container, reloads } = deps();
    container.controller = {};
    await startServiceWorker(d);
    const release = holdExam();
    const worker = container.deliver();
    expect(worker.posted).toEqual([]);
    expect(reloads).toHaveLength(0);
    expect(isExamActive()).toBe(true);
    release(); // the learner submitted
    expect(worker.posted).toEqual([{ type: 'SKIP_WAITING' }]);
    container.dispatchEvent(new Event('controllerchange'));
    expect(reloads).toHaveLength(1);
  });

  it('a takeover that arrives while an exam runs does not reload the page under the learner: the reload waits for the end of the exam', async () => {
    const { d, container, reloads } = deps();
    container.controller = {};
    await startServiceWorker(d);
    const worker = container.deliver(); // applied: no exam yet
    expect(worker.posted).toHaveLength(1);
    const release = holdExam(); // an exam starts in the instant before the controller changes
    container.dispatchEvent(new Event('controllerchange'));
    expect(reloads).toHaveLength(0);
    release();
    expect(reloads).toHaveLength(1);
  });

  it('another tab is in an exam (the worker says UPDATE_DEFERRED): the page asks again later', async () => {
    const { d, container, later } = deps();
    container.controller = {};
    await startServiceWorker(d);
    const worker = container.deliver();
    worker.posted.length = 0;
    container.message({ type: 'UPDATE_DEFERRED' });
    expect(later).toHaveLength(1);
    later[0]?.();
    expect(worker.posted).toEqual([{ type: 'SKIP_WAITING' }]);
  });

  it('a controller change nobody asked for (not our SKIP_WAITING) never reloads the page', async () => {
    const { d, container, reloads } = deps();
    container.controller = {};
    await startServiceWorker(d);
    container.dispatchEvent(new Event('controllerchange'));
    expect(reloads).toHaveLength(0);
  });
});

describe('the exam lock', () => {
  it('counts holders, releases once, and tells listeners when the LAST one lets go', () => {
    const idle = vi.fn();
    const stop = onExamIdle(idle);
    const a = holdExam();
    const b = holdExam();
    a();
    a(); // a second release of the same lock is harmless
    expect(isExamActive()).toBe(true);
    expect(idle).not.toHaveBeenCalled();
    b();
    expect(isExamActive()).toBe(false);
    expect(idle).toHaveBeenCalledOnce();
    stop();
  });

  it('answers the worker\'s "is an exam running here?" through the port it sent', () => {
    const container = new EventTarget();
    answerExamQueries(container as unknown as ServiceWorkerContainer);
    const ask = () => {
      const answers: unknown[] = [];
      container.dispatchEvent(
        Object.assign(new Event('message'), {
          data: { type: 'EXAM_BUSY?' },
          ports: [{ postMessage: (v: unknown) => answers.push(v) }],
        }),
      );
      return answers;
    };
    expect(ask()).toEqual([false]);
    const release = holdExam();
    expect(ask()).toEqual([true]);
    release();
    // other messages are none of its business
    const other: unknown[] = [];
    container.dispatchEvent(
      Object.assign(new Event('message'), {
        data: { type: 'SOMETHING' },
        ports: [{ postMessage: (v: unknown) => other.push(v) }],
      }),
    );
    expect(other).toEqual([]);
  });
});

describe('the kill switch on the page side', () => {
  it('unregister: every registration is removed, the caches are cleared and NOTHING is registered', async () => {
    const { d, container, clear } = deps({ control: { unregister: true } });
    const stale = new FakeRegistration();
    container.existing = [stale, new FakeRegistration()];
    const out = await startServiceWorker(d);
    expect(out.registered).toBe(false);
    expect(stale.unregister).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    expect(container.registered).toEqual([]);
  });

  it('deleteCaches alone clears the caches and still registers', async () => {
    const { d, container, clear } = deps({ control: { deleteCaches: true } });
    const out = await startServiceWorker(d);
    expect(out.registered).toBe(true);
    expect(clear).toHaveBeenCalledOnce();
    expect(container.registered).toHaveLength(1);
  });

  it('is deferred while an exam runs, and carried out when it ends', async () => {
    const { d, container, clear } = deps({ control: { unregister: true } });
    const stale = new FakeRegistration();
    container.existing = [stale];
    const release = holdExam();
    const out = await startServiceWorker(d);
    expect(out.registered).toBe(false);
    expect(stale.unregister).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(stale.unregister).toHaveBeenCalledOnce());
    expect(clear).toHaveBeenCalled();
  });

  it('a control file that cannot be read changes nothing', async () => {
    const { d, container } = deps({ control: null });
    expect((await startServiceWorker(d)).registered).toBe(true);
    expect(container.registered).toHaveLength(1);
  });
});

describe('sign-out', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('deletes EVERY cache of the origin (ours or not) and tells the controlling worker to do the same', async () => {
    const stores = new Set(['lms-shell-b1', 'lms-assets-b1', 'third-party']);
    vi.stubGlobal('caches', {
      keys: async () => [...stores],
      delete: async (k: string) => stores.delete(k),
    });
    const posted: unknown[] = [];
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { controller: { postMessage: (m: unknown) => posted.push(m) } },
    });
    await clearServiceWorkerCaches();
    expect([...stores]).toEqual([]);
    expect(posted).toEqual([{ type: 'CLEAR_CACHES' }]);
  });

  it('never throws (Cache Storage blocked, no worker)', async () => {
    vi.stubGlobal('caches', {
      keys: async () => {
        throw new Error('blocked');
      },
    });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
    await expect(clearServiceWorkerCaches()).resolves.toBeUndefined();
  });
});

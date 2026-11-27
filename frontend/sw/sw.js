/* JCS iLearn service worker (step 14b-2 part D, docs/adr/0025-service-worker.md).
 *
 * THE TEMPLATE: the build (vite-plugin-sw.ts) replaces the one placeholder below and emits the result as /sw.js, with no hash in its name. The tests
 * run this same text against a fake `self`, so what is tested is what ships. It is a CLASSIC script (no imports).
 *
 * WHAT IT DOES, AND NOTHING MORE
 *   - The HTML shell (every navigation) is NETWORK-FIRST. A copy is kept only to be shown when the network is gone. The cache is never asked first,
 *     so a new release can never hide behind a stale shell.
 *   - /assets/* files carry a content hash in their name (immutable): cache-first is safe for them. The entry chunk and the exam route are fetched into
 *     the cache at install time, so a learner who has opened an exam can reload it offline (the answer queue is durable in the browser: answerQueue.ts).
 *   - /api/* and anything cross-origin is NEVER touched: no respondWith, no cache. A guard also refuses to store one (safePut), and a test fails if any
 *     request of /api ever reaches a cache.
 *   - A new worker does NOT take over by itself: no skipWaiting at install and no clients.claim. It waits until the page asks (SKIP_WAITING), and even
 *     then it asks every open page "is an exam running?" and stays waiting if any says yes (`UPDATE_DEFERRED`).
 *   - KILL SWITCH: /sw-control.json (served no-cache) can order `unregister` and / or `deleteCaches`. The worker reads it at activation and on every
 *     navigation; an order is carried out unless an exam is running in some page (then at the next check).
 */
((self, config) => {
  const BUILD = config.buildId;
  const PREFIX = 'lms-';
  const SHELL = `${PREFIX}shell-${BUILD}`;
  const ASSETS = `${PREFIX}assets-${BUILD}`;
  const SHELL_KEY = '/index.html';
  const CONTROL_PATH = '/sw-control.json';
  const BUSY_TIMEOUT_MS = 500;

  /** A request this worker must never answer or store: the API, another origin, its own files. */
  function isUntouchable(url) {
    return (
      url.origin !== self.location.origin ||
      url.pathname === '/api' ||
      url.pathname.indexOf('/api/') === 0 ||
      url.pathname === '/sw.js' ||
      url.pathname === CONTROL_PATH
    );
  }

  /** The only way anything enters a cache. Refuses an API URL even if some future code path asks for it. */
  function safePut(cacheName, key, response) {
    const url = new URL(typeof key === 'string' ? key : key.url, self.location.origin);
    if (isUntouchable(url)) return Promise.reject(new Error(`refusing to cache ${url.pathname}`));
    if (!response?.ok) return Promise.resolve();
    return self.caches.open(cacheName).then((cache) => cache.put(key, response));
  }

  function ownCaches() {
    return self.caches.keys().then((keys) => keys.filter((k) => k.indexOf(PREFIX) === 0));
  }

  function deleteAllCaches() {
    return ownCaches().then((keys) => Promise.all(keys.map((k) => self.caches.delete(k))));
  }

  function deleteOldCaches() {
    return ownCaches().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => self.caches.delete(k)),
      ),
    );
  }

  // ------------------------------------------------------------------------------------------------ is an exam running in some page?
  function askClient(client) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      try {
        const channel = new MessageChannel();
        channel.port1.onmessage = (e) => {
          finish(e.data === true);
        };
        client.postMessage({ type: 'EXAM_BUSY?' }, [channel.port2]);
      } catch {
        finish(false);
      }
      setTimeout(() => {
        finish(false);
      }, BUSY_TIMEOUT_MS);
    });
  }

  /** True when ANY open page answers that an exam is running. A page that does not answer is not busy. */
  function examBusy() {
    return self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((list) => Promise.all(list.map(askClient)).then((answers) => answers.some(Boolean)));
  }

  // ------------------------------------------------------------------------------------------------ the kill switch
  function readControl() {
    return self
      .fetch(CONTROL_PATH, { cache: 'no-store', credentials: 'omit' })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
  }

  /** Carries out /sw-control.json: `deleteCaches` clears the caches, `unregister` clears them and removes this worker. Deferred while an exam runs. */
  // On EVERY navigation (and at activation), never throttled: "the next load obeys the order" is the promise, and a no-store request for a 40-byte static file
  // is the price. An order that meets a running exam is simply read again at the next navigation.
  function checkControl() {
    return readControl().then((control) => {
      if (!control || (control.unregister !== true && control.deleteCaches !== true)) return false;
      return examBusy().then((busy) => {
        if (busy) return false;
        let work = deleteAllCaches();
        if (control.unregister === true) work = work.then(() => self.registration.unregister());
        return work.then(() => true);
      });
    });
  }

  // ------------------------------------------------------------------------------------------------ install: fetch what the exam needs offline
  self.addEventListener('install', (event) => {
    // NO skipWaiting here, on purpose: the page decides when this version takes over (never in the middle of an exam)
    event.waitUntil(
      Promise.all([
        Promise.all(
          config.precache.map((path) =>
            // a hashed file never changes under its name: the browser's HTTP cache may answer (the page that registered us has just loaded most of
            // them, and a second download of the entry chunk right after load competed with the page: Lighthouse saw it)
            self.fetch(path).then((res) => {
              if (!res.ok) throw new Error(`precache ${path} answered ${res.status}`);
              return safePut(ASSETS, path, res);
            }),
          ),
        ),
        // the shell is the one file whose name does not change: always from the network
        self.fetch(SHELL_KEY, { cache: 'reload' }).then((res) => {
          if (!res.ok) throw new Error(`shell answered ${res.status}`);
          return safePut(SHELL, SHELL_KEY, res);
        }),
      ]),
    );
  });

  self.addEventListener('activate', (event) => {
    // NO clients.claim: pages already open keep the worker they have; the next navigation uses this one
    event.waitUntil(deleteOldCaches().then(() => checkControl()));
  });

  // ------------------------------------------------------------------------------------------------ fetch
  function navigate(event) {
    return self.fetch(event.request).then(
      (res) => {
        const type = res.headers.get('content-type') || '';
        if (res.ok && type.indexOf('text/html') === 0 && !res.redirected) {
          event.waitUntil(safePut(SHELL, SHELL_KEY, res.clone()).catch(() => {}));
        }
        return res;
      },
      (err) => {
        // the network is gone (not "an error page came back"): show the last shell this browser saw
        return self.caches.open(SHELL).then((cache) =>
          cache.match(SHELL_KEY).then((cached) => {
            if (cached) return cached;
            throw err;
          }),
        );
      },
    );
  }

  function assetFirst(event) {
    return self.caches.open(ASSETS).then((cache) =>
      cache.match(event.request).then((hit) => {
        if (hit) return hit;
        return self.fetch(event.request).then((res) => {
          event.waitUntil(safePut(ASSETS, event.request, res.clone()).catch(() => {}));
          return res;
        });
      }),
    );
  }

  self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (isUntouchable(url)) return; // the browser handles it as if no worker existed
    if (request.mode === 'navigate') {
      event.waitUntil(checkControl().catch(() => {}));
      event.respondWith(navigate(event));
      return;
    }
    if (url.pathname.indexOf('/assets/') === 0) {
      event.respondWith(assetFirst(event));
    }
  });

  // ------------------------------------------------------------------------------------------------ messages from the page
  self.addEventListener('message', (event) => {
    const data = event.data || {};
    const source = event.source;
    if (data.type === 'SKIP_WAITING') {
      event.waitUntil(
        examBusy().then((busy) => {
          if (busy) {
            if (source?.postMessage) source.postMessage({ type: 'UPDATE_DEFERRED' });
            return undefined;
          }
          return self.skipWaiting();
        }),
      );
    } else if (data.type === 'CLEAR_CACHES') {
      event.waitUntil(deleteAllCaches());
    } else if (data.type === 'VERSION' && source && source.postMessage) {
      source.postMessage({ type: 'VERSION', build: BUILD });
    }
  });
})(self, __SW_CONFIG__);

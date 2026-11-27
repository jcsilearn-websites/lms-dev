/* The RETIRING service worker. With the build flag VITE_SERVICE_WORKER=off the build emits THIS as /sw.js instead of the real worker, and the application
 * never registers one. Browsers that already have the real worker fetch /sw.js on their next navigation, find a different script, install this one, and
 * this one removes every cache of ours and then itself. (Simply deleting sw.js would NOT do: a browser whose update check gets a 404 keeps the old
 * worker.) Like the real worker it never takes over in the middle of an exam: it asks every open page and waits when one is running an exam.
 */
((self) => {
  const PREFIX = 'lms-';
  const BUSY_TIMEOUT_MS = 500;

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

  self.addEventListener('install', (event) => {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) =>
        Promise.all(list.map(askClient)).then((answers) => {
          // an exam is running somewhere: stay waiting (this worker then activates when the old one has no page left)
          return answers.some(Boolean) ? undefined : self.skipWaiting();
        }),
      ),
    );
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      self.caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys.filter((k) => k.indexOf(PREFIX) === 0).map((k) => self.caches.delete(k)),
          ),
        )
        .then(() => self.registration.unregister()),
    );
  });

  // no fetch handler: every request goes to the network, as if no worker existed
})(self);

# ADR 0025: the service worker, the kill switch and the error boundary (step 14b-2 part D)

Status: accepted. Date: 2026-11-25.

## Context

A learner who has opened an exam must be able to reload it when the connection drops (the answer queue is already durable in the browser: `answerQueue.ts`, `examCache.ts`).
What is missing offline is the page itself: the HTML shell and the JavaScript of the entry and of the exam route. A service worker can keep those. A worker is also the one
piece of the front end that can make a release invisible (a stale shell), outlive a bad deploy (it is installed in the browser, not on our server), and break an exam (an update
that takes over in the middle of one). So the design is mostly about what the worker is **not** allowed to do, and how it is removed when it misbehaves.

## Decision

**What it caches.** The HTML shell, kept only to be shown when the network is gone; the entry chunk, the exam route chunk and what they import statically, fetched at install
(`vite-plugin-sw.ts` builds the list from the bundle); and every `/assets/*` file on first use (names are content hashes: they never change). Nothing else.

**What it never touches.** `/api/*` (no `respondWith`, no cache), other origins, non-GET requests, `/sw.js` and `/sw-control.json`. A guard (`safePut`) also refuses to store any such URL
if future code ever asks, and every worker test ends by failing when anything of `/api` was put in a cache. The E2E suite repeats it in a real browser with a signed-in session.

**The shell is network-first, never cache-first.** A navigation goes to the network; a copy of the answer (a real `200 text/html`, not a redirect) is stored for the day the network is
gone. The cache is read only when the fetch itself fails, not when the server answers with an error. A release can therefore never hide behind an old shell: the first navigation after a
deploy gets the new one (tested with a real deploy swap: `19-service-worker.spec.ts`, and a worker mutated to cache-first fails it).

**Updates.** A new worker does not call `skipWaiting` at install and never `clients.claim()`. It waits. The page asks it to take over (`SKIP_WAITING`) only when no exam is running in this
tab (`sw/examLock.ts`, held by the exam page while its attempt is in progress), and the worker itself asks **every open page** ("is an exam running?") and stays waiting if any says yes,
telling the asker `UPDATE_DEFERRED`. A page that does not answer in 500 ms counts as not busy (a dead tab must not block updates for ever). The update is applied when the last exam ends, and
the page reloads once, after the takeover it asked for. Tested: unit tests for both sides, and an E2E in which a release is deployed during an exam, another tab asks for the update, and for
six seconds the exam tab keeps its old worker, its page and its timer until the learner hands in.

**Versioned caches.** Cache names carry the build id (`lms-shell-<id>`, `lms-assets-<id>`); activation deletes the caches of other builds and leaves caches that are not ours alone.

**The kill switch** (`/sw-control.json`, served `no-cache, no-store, must-revalidate`): `{"unregister": true, "deleteCaches": true}`. The worker reads it at activation and on **every**
navigation (a no-store request for a few bytes; throttling it would let a "next load" slip by), so a worker whose page is broken still obeys. The page reads the same file before it
registers: while the order stands nothing is registered. An order is carried out unless an exam is running somewhere; it is read again at the next navigation. Tested end to end: publish the
file, reload, the registration and every cache are gone; withdraw it, reload, a worker registers again.

**The environment flag.** Building with `VITE_SERVICE_WORKER=off` makes the application skip registration entirely, and emits a **retiring** `/sw.js` in place of the real one: browsers that
already have the real worker find a different script at their next update check and install the retiring one, which deletes our caches and unregisters itself (it also waits for a running
exam). Simply deleting `sw.js` would not work: a browser whose update check meets a 404 keeps the old worker. Tested with a real `off` build.

**Sign-out clears every cache** of the origin (ours or not) and tells the worker to do the same, also when the server cannot be reached and on a 401.

**Registration is late on purpose.** After the `load` event, then 12 seconds, then `requestIdleCallback`. The first version registered in idle time at once and cost the Lighthouse mobile
performance score 2-5 points (its install re-downloaded the entry chunk while the page was still being measured). Two changes fixed it: hashed assets are fetched at install through the HTTP
cache (their names are hashes, so a cached copy is exact), and the 12-second delay. A 7-run A/B on the heaviest page (the assignment) gave a median of 91 with the worker and 91 without. The
cost of the delay: a learner who opens an exam within 12 seconds of the very first load of a session has no offline copy of the exam route until the install finishes.

**The error boundary and crash reports.** A global boundary (and the router's default error component) shows an alert with a reload button instead of a white screen; a failed lazy chunk
(a release replaced the files an open tab was about to load) gets its own wording, and a reload then fetches the new shell. Crashes go to `POST /api/client-errors`: public (the sign-in page
itself can crash), a **normal CSRF route** (the browser sends `Origin` and `X-Requested-With`, so the list of three CSRF exemptions does not grow), a closed JSON shape, **4 KB**, **30 reports
per address per minute** through the shared strict limiter, **no database access of its own** (the limiter's statement is infrastructure), and one log line. Text is scrubbed twice by the
same function (`backend/src/contracts/scrub.ts`, imported by the SPA as `@lms/backend/scrub`): the browser before it sends, the API before it logs. E-mail addresses, UUIDs, JWT-like
strings, any 24+ character token, `token=` / `password=` / `bearer` pairs, digit runs of six or more, and the host, query and fragment of every URL are removed; the page is reported as a route
template (`/offerings/:id/items/:n`). The browser sends at most 5 reports a minute and 20 a page, each distinct error once, and never reports the API's own failures (offline, 4xx, 5xx).

## Consequences

- The gateway must send the two no-cache headers for `/sw.js` and `/sw-control.json` (README "Production routing"); `serve.mjs` does, and the E2E checks it.
- A worker that misbehaves is removed by publishing one file, with no deploy; if even that is not possible, the next build carries `VITE_SERVICE_WORKER=off`.
- The page watches a worker that is already installing when the (delayed) registration runs, and asks the browser for a newer script itself once per page load: the first version relied on an `updatefound` event
  that the delayed code could have missed (one full-suite E2E run failed that way, 1 in about 10).
- The login page's initial JavaScript grew by about 1.5 KB gzip (the reporter, the boundary, the registrar): 124.2 KB against the budget of 125. There is little room left in the entry chunk.
- An unreported crash is still logged by the browser console; reports are counted by kind in `lms_client_errors_total` (alert on a rise after a deploy).
- The reload that applies an update is a page reload: an unsaved form on a non-exam page is lost. Exams hold the lock, and other long forms (an assignment text) can take the same lock if that
  turns out to matter (`acquireExamLock` is not specific to exams).

## Not covered

- Background sync, push notifications, offline answers outside the exam (the exam's own queue does that), offline API reads.
- A worker per college: one worker serves one origin, and each college is its own origin.

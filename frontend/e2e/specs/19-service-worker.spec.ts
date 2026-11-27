import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  apiAs,
  type Browser,
  createMember,
  expect,
  originOf,
  type Page,
  signIn,
  signOut,
  test,
} from '../support';

// THE SERVICE WORKER, in a real browser, against the real stack (step 14b-2 part D, docs/adr/0025-service-worker.md). The CSP guard of support.ts fails
// every test here on a violation, so registering a worker under the strict policy is checked by every line below.
//
// Part 1 (the stack's own server, port 4173): registration, headers, offline reload, nothing of /api in any cache, sign-out clears every cache.
// Part 2 (a second static server on port 4180 that is STOPPED and RESTARTED with another build of the SPA: that is what a deploy looks like to a browser):
//   version skew (no stale shell, no API mismatch), an update that arrives during an exam, the kill switch (a published sw-control.json), and the
//   build with the worker turned off, which also removes an installed worker.

const COLLEGE = 'e2e-one';
const COURSE = 'SWC19';
const TEACHER = 'sw.teacher@e2e-one.test';
const LEARNER = 'sw.learner@e2e-one.test';
const DEPLOY_PORT = 4180;
const API_PORT = Number(process.env.E2E_API_PORT ?? 3100);
const FRONTEND = process.cwd(); // `pnpm e2e` runs Playwright in frontend/
const TMP = join(FRONTEND, '.e2e-tmp', 'sw');
const NO_STORE = 'no-cache, no-store, must-revalidate';

// ------------------------------------------------------------------------------------------------------------------ what a page can tell about its worker
type Which = 'active' | 'waiting' | 'installing';

/** The build id of the worker in a slot of the registration (it answers VERSION), or null. Survives a page that is reloading. */
async function workerBuild(page: Page, which: Which = 'active'): Promise<string | null> {
  try {
    return await page.evaluate(async (slot) => {
      const reg = await navigator.serviceWorker.getRegistration();
      const worker = reg?.[slot];
      if (!worker) return null;
      return await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 3000);
        navigator.serviceWorker.addEventListener('message', function once(e) {
          if (e.data?.type === 'VERSION') {
            clearTimeout(timer);
            navigator.serviceWorker.removeEventListener('message', once);
            resolve(e.data.build);
          }
        });
        worker.postMessage({ type: 'VERSION' });
      });
    }, which);
  } catch {
    return null;
  }
}

const registrations = async (page: Page): Promise<number> =>
  page
    .evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)
    .catch(() => -1);
const cacheNames = async (page: Page): Promise<string[]> =>
  page.evaluate(async () => (await caches.keys()).sort()).catch(() => ['(unreadable)']);
/** every URL path stored in any cache */
const cachedPaths = async (page: Page): Promise<string[]> =>
  page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname);
    }
    return out;
  });
const marker = (page: Page) =>
  page.evaluate(
    () => document.querySelector('meta[name=x-build]')?.getAttribute('content') ?? null,
  );

async function waitForWorker(page: Page, build?: string) {
  const poll = expect.poll(() => workerBuild(page), {
    timeout: 40_000,
    message: 'the service worker did not become active',
  });
  if (build) await poll.toBe(build);
  else await poll.not.toBeNull();
}

// ------------------------------------------------------------------------------------------------------------------ a "deploy": a build served on one port
interface Server {
  stop(): Promise<void>;
}
function serve(dist: string): Promise<Server> {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      join(FRONTEND, 'scripts', 'serve.mjs'),
      '--port',
      String(DEPLOY_PORT),
      '--api',
      `http://127.0.0.1:${API_PORT}`,
      '--dist',
      dist,
    ],
    {
      stdio: 'ignore',
      env: process.env,
    },
  );
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return (async () => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${DEPLOY_PORT}/`);
        if (res.ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error('the deploy server did not start');
      await new Promise((r) => setTimeout(r, 150));
    }
    return {
      async stop() {
        child.kill();
        await exited;
        await new Promise((r) => setTimeout(r, 300)); // the port is free again
      },
    };
  })();
}

/** A copy of the built SPA that is "release `build`": a different worker id, and a marker in the page that says which release it is. */
function release(name: string, build: string, markerValue: string): string {
  const dir = join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(FRONTEND, 'dist'), dir, { recursive: true });
  const sw = join(dir, 'sw.js');
  writeFileSync(sw, readFileSync(sw, 'utf8').replace(/"buildId":"[^"]*"/, `"buildId":"${build}"`));
  const index = join(dir, 'index.html');
  writeFileSync(
    index,
    readFileSync(index, 'utf8').replace(
      '</head>',
      `<meta name="x-build" content="${markerValue}" /></head>`,
    ),
  );
  return dir;
}

const control = (dir: string, body: { unregister?: boolean; deleteCaches?: boolean }) =>
  writeFileSync(join(dir, 'sw-control.json'), `${JSON.stringify(body)}\n`);
const deployUrl = (path: string) => `http://${COLLEGE}.localhost:${DEPLOY_PORT}${path}`;

async function signInAt(page: Page, email: string) {
  await page.goto(deployUrl('/login'));
  await page.getByLabel('Email').fill(email);
  await page
    .getByLabel('Password')
    .fill(process.env.E2E_PASSWORD ?? 'correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
}

async function freshPage(browser: Browser): Promise<Page> {
  return (await browser.newContext()).newPage();
}

// ------------------------------------------------------------------------------------------------------------------ part 1: the stack's own server
test.describe('the worker on the stack', () => {
  test.describe.configure({ mode: 'serial' });

  test('registers in idle time after load, under the strict CSP, and fetches what an exam needs into caches named for the build', async ({
    page,
  }) => {
    await page.goto(`${originOf(COLLEGE)}/login`);
    await waitForWorker(page);
    const names = await cacheNames(page);
    expect(names.some((n) => n.startsWith('lms-shell-'))).toBe(true);
    expect(names.some((n) => n.startsWith('lms-assets-'))).toBe(true);
    const paths = await cachedPaths(page);
    expect(paths).toContain('/index.html');
    expect(paths.some((p) => /^\/assets\/index-.*\.js$/.test(p))).toBe(true);
    expect(paths.some((p) => /^\/assets\/ExamPage-.*\.js$/.test(p))).toBe(true); // the exam route is there before any exam is opened
  });

  test('sw.js and sw-control.json are served with no-cache headers, the shell with no-cache, hashed assets as immutable', async ({
    page,
  }) => {
    await page.goto(`${originOf(COLLEGE)}/login`);
    await waitForWorker(page);
    const asset = (await cachedPaths(page)).find((p) => p.startsWith('/assets/')) ?? '';
    const headers = await page.evaluate(async (assetPath) => {
      const get = async (path: string) => {
        const r = await fetch(path, { cache: 'no-store' });
        return {
          status: r.status,
          cache: r.headers.get('cache-control'),
          type: r.headers.get('content-type'),
        };
      };
      return {
        sw: await get('/sw.js'),
        control: await get('/sw-control.json'),
        shell: await get('/index.html'),
        asset: await get(assetPath),
      };
    }, asset);
    expect(headers.sw).toMatchObject({ status: 200, cache: NO_STORE });
    expect(headers.sw.type).toMatch(/javascript/);
    expect(headers.control).toMatchObject({ status: 200, cache: NO_STORE });
    expect(headers.shell.cache).toBe('no-cache');
    expect(headers.asset.cache).toBe('public, max-age=31536000, immutable');
  });

  test('offline, a reload shows the cached shell (an exam can be reopened); online, the shell always comes from the network', async ({
    page,
    context,
  }) => {
    await page.goto(`${originOf(COLLEGE)}/login`);
    await waitForWorker(page);
    const offline = async () => {
      await context.setOffline(true);
      try {
        const response = await page.reload();
        expect(response?.fromServiceWorker()).toBe(true);
        await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
      } finally {
        await context.setOffline(false);
      }
    };
    await offline();
    // online again: the next load is a real NETWORK load of the shell. The request the WORKER makes is visible to the context (request.serviceWorker()),
    // not to page.route: the worker went to the network for this page, it did not answer from its cache
    const networkShellLoads: string[] = [];
    context.on('request', (r) => {
      if (r.serviceWorker() && new URL(r.url()).pathname === '/login')
        networkShellLoads.push(r.url());
    });
    const response = await page.reload();
    expect(response?.fromServiceWorker()).toBe(true);
    expect(networkShellLoads.length).toBeGreaterThan(0);
  });

  test('NO /api request is ever answered by the worker or stored in a cache, signed in or not', async ({
    page,
  }) => {
    const api: { url: string; fromServiceWorker: boolean }[] = [];
    page.on('response', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/'))
        api.push({ url: r.url(), fromServiceWorker: r.fromServiceWorker() });
    });
    await page.goto(`${originOf(COLLEGE)}/login`);
    await waitForWorker(page);
    await page.reload(); // from here on the page is controlled by the worker
    await signIn(page, COLLEGE, `admin@${COLLEGE}.test`);
    await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
    await page.goto(`${originOf(COLLEGE)}/members`);
    await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
    expect(api.length).toBeGreaterThan(5);
    expect(api.filter((a) => a.fromServiceWorker)).toEqual([]);
    const paths = await cachedPaths(page);
    expect(paths.length).toBeGreaterThan(5);
    expect(paths.filter((p) => p.startsWith('/api'))).toEqual([]);
  });

  test('signing out clears EVERY cache of the browser', async ({ page }) => {
    await page.goto(`${originOf(COLLEGE)}/login`);
    await waitForWorker(page);
    await page.reload();
    await signIn(page, COLLEGE, `admin@${COLLEGE}.test`);
    await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
    expect((await cacheNames(page)).length).toBeGreaterThan(0);
    await page.evaluate(async () => {
      await (await caches.open('some-other-cache')).put('/x', new Response('x')); // not ours: sign-out empties it too
    });
    await signOut(page);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect.poll(() => cacheNames(page), { timeout: 10_000 }).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------ part 2: deploys
test.describe('deploys, updates and the kill switch', () => {
  test.describe.configure({ mode: 'serial' });
  let dirA = '';
  let dirB = '';
  let server: Server | null = null;
  let offeringId = '';
  let itemId = '';

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    mkdirSync(TMP, { recursive: true });
    dirA = release('a', 'a1', 'A');
    dirB = release('b', 'b2', 'B');
    // an exam, set up through the API: one instructor, one learner, two questions, a 30-minute exam
    const admin = await apiAs(COLLEGE, `admin@${COLLEGE}.test`);
    const must = async (res: Awaited<ReturnType<typeof admin.post>>) => {
      if (!res.ok() && res.status() !== 409)
        throw new Error(`setup call failed: ${res.status()} ${await res.text()}`);
      return res;
    };
    await must(
      await admin.post('academic-years', {
        data: { label: 'E2E 2026', startDate: '2026-06-01', endDate: '2027-05-31' },
      }),
    );
    const year = (
      (await (await admin.get('academic-years?limit=100')).json()) as {
        items: { id: string; label: string }[];
      }
    ).items.find((y) => y.label === 'E2E 2026');
    await must(
      await admin.post('terms', {
        data: {
          academicYearId: year?.id,
          name: 'E2E Semester 1',
          startDate: '2026-06-01',
          endDate: '2026-11-30',
        },
      }),
    );
    const term = (
      (await (await admin.get('terms?limit=100')).json()) as {
        items: { id: string; name: string }[];
      }
    ).items.find((x) => x.name === 'E2E Semester 1');
    const teacher = await createMember(COLLEGE, TEACHER, 'Sw Teacher');
    const learner = await createMember(COLLEGE, LEARNER, 'Sw Learner');
    await must(
      await admin.post('courses', {
        data: { code: COURSE, title: 'Service worker exam', credits: 1 },
      }),
    );
    const course = (
      (await (await admin.get(`courses?q=${COURSE}&limit=10`)).json()) as {
        items: { id: string; code: string }[];
      }
    ).items.find((c) => c.code === COURSE);
    await must(await admin.post('offerings', { data: { courseId: course?.id, termId: term?.id } }));
    offeringId = (
      (await (await admin.get(`offerings?courseId=${course?.id}&limit=10`)).json()) as {
        items: { id: string }[];
      }
    ).items[0]?.id as string;
    for (const [userId, participation] of [
      [teacher, 'instructor'],
      [learner, 'learner'],
    ] as const) {
      await must(
        await admin.post(`offerings/${offeringId}/participants`, {
          data: { userId, participation },
        }),
      );
    }
    await admin.dispose();
    const t = await apiAs(COLLEGE, TEACHER);
    await must(await t.post(`offerings/${offeringId}/publish`));
    const mod = (await (
      await must(await t.post(`offerings/${offeringId}/modules`, { data: { title: 'Exam' } }))
    ).json()) as { id: string };
    await must(
      await t.patch(`offerings/${offeringId}/modules/${mod.id}`, { data: { published: true } }),
    );
    const doc = (text: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const questionIds: string[] = [];
    for (const n of [1, 2]) {
      const q = (await (
        await must(
          await t.post(`courses/${course?.id}/questions`, {
            data: {
              type: 'single_choice',
              stem: doc(`Question ${n}?`),
              options: [
                { text: doc('Yes'), correct: true },
                { text: doc('No'), correct: false },
              ],
            },
          }),
        )
      ).json()) as { id: string };
      questionIds.push(q.id);
    }
    const item = (await (
      await must(
        await t.post(`offerings/${offeringId}/modules/${mod.id}/items`, {
          data: { kind: 'assessment', title: 'Offline exam', published: true },
        }),
      )
    ).json()) as { id: string };
    itemId = item.id;
    await must(
      await t.put(`offerings/${offeringId}/items/${itemId}/assessment`, {
        data: {
          kind: 'exam',
          timeLimitMinutes: 30,
          attemptsAllowed: 5,
          resultsVisibility: 'immediate',
          answersVisibility: 'never',
        },
      }),
    );
    await must(
      await t.put(`offerings/${offeringId}/items/${itemId}/assessment/slots`, {
        data: {
          slots: questionIds.map((questionId) => ({ kind: 'fixed', questionId, points: 1 })),
        },
      }),
    );
    await t.dispose();
  });

  test.afterEach(async () => {
    await server?.stop();
    server = null;
  });
  test.afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test('VERSION SKEW: a deploy while an old worker is active: the new shell shows at once (never a stale one), the API is never answered by the worker, and the new version then takes over', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    control(dirA, { unregister: false });
    control(dirB, { unregister: false });
    server = await serve(dirA);
    const page = await freshPage(browser);
    const api: { url: string; fromServiceWorker: boolean }[] = [];
    page.on('response', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/'))
        api.push({ url: r.url(), fromServiceWorker: r.fromServiceWorker() });
    });
    await page.goto(deployUrl('/login'));
    expect(await marker(page)).toBe('A');
    await waitForWorker(page, 'a1');
    await page.reload(); // controlled by the old worker from here on
    expect(await marker(page)).toBe('A');
    expect(await cacheNames(page)).toEqual(['lms-assets-a1', 'lms-shell-a1']);

    // ---- DEPLOY: the server now serves release B; the old worker (a1) is still the active one
    await server.stop();
    server = await serve(dirB);
    api.length = 0;
    await page.reload();
    // no stale shell: the page that loaded is release B although the worker and its cached shell are release A
    expect(await marker(page)).toBe('B');
    // no API mismatch: a call made by this page is answered by the server, never by the worker, and the server's answer is the current one
    const info = await page.evaluate(() => fetch('/api/tenant/info').then((r) => r.json()));
    expect(info).toMatchObject({ slug: COLLEGE });
    expect(api.length).toBeGreaterThan(0);
    expect(api.filter((a) => a.fromServiceWorker)).toEqual([]);

    // ---- the update: nothing is running, so the new worker takes over and the page reloads itself once
    await expect.poll(() => workerBuild(page), { timeout: 40_000 }).toBe('b2');
    await expect
      .poll(() => cacheNames(page), { timeout: 20_000 })
      .toEqual(['lms-assets-b2', 'lms-shell-b2']); // release A's caches are gone
    expect(await marker(page)).toBe('B');
    expect((await cachedPaths(page)).filter((p) => p.startsWith('/api'))).toEqual([]);
    await page.context().close();
  });

  test('AN UPDATE DURING AN EXAM waits: the exam keeps running on the old version (also when ANOTHER tab asks for the update), and the update is applied when the exam ends', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    control(dirA, { unregister: false });
    control(dirB, { unregister: false });
    server = await serve(dirA);
    const page = await freshPage(browser);
    await signInAt(page, LEARNER);
    await waitForWorker(page, 'a1');
    await page.reload();
    await page.goto(deployUrl(`/offerings/${offeringId}/items/${itemId}`));
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByRole('timer')).toBeVisible(); // THE EXAM IS RUNNING
    await page.evaluate(() => {
      (window as unknown as { __stillHere: boolean }).__stillHere = true; // gone if the page is ever reloaded
    });

    // ---- DEPLOY release B, and the browser finds the new worker
    await server.stop();
    server = await serve(dirB);
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())?.update();
    });
    await expect
      .poll(() => workerBuild(page, 'waiting'), {
        timeout: 40_000,
        message: 'the new worker never reached "waiting"',
      })
      .toBe('b2');

    // ANOTHER tab (no exam in it) loads release B and asks for the update: the worker asks every page, hears "an exam is running", and stays waiting
    const other = await page.context().newPage();
    await other.goto(deployUrl('/login'));
    await expect(other.getByRole('button', { name: 'Sign in' })).toBeVisible();
    // the exam keeps running on the old version: for a good while, the active worker is still a1, the new one is still waiting, nothing reloaded
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(1000);
      expect(await workerBuild(page, 'active')).toBe('a1');
      expect(await workerBuild(page, 'waiting')).toBe('b2');
      expect(
        await page.evaluate(() => (window as unknown as { __stillHere?: boolean }).__stillHere),
      ).toBe(true);
      await expect(page.getByRole('timer')).toBeVisible();
    }
    await other.close();

    // ---- the learner answers and hands in: the exam is over, the update is applied
    const radios = page.getByRole('radio');
    await radios.first().check();
    await page
      .getByRole('navigation', { name: 'Questions' })
      .getByRole('button', { name: /^Question 2,/ })
      .click();
    await page.getByRole('radio').first().check();
    await page.getByRole('button', { name: 'Submit' }).first().click();
    await page
      .getByRole('dialog', { name: 'Submit your answers?' })
      .getByRole('button', { name: 'Submit now' })
      .click();
    await expect
      .poll(() => workerBuild(page, 'active'), {
        timeout: 40_000,
        message: 'the update was not applied after the exam',
      })
      .toBe('b2');
    expect(await marker(page)).toBe('B');
    await page.context().close();
  });

  test('THE KILL SWITCH end to end: a published sw-control.json orders unregister and cache deletion, and the installed worker removes itself and clears its caches on the next load', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    control(dirA, { unregister: false });
    server = await serve(dirA);
    const page = await freshPage(browser);
    await page.goto(deployUrl('/login'));
    await waitForWorker(page, 'a1');
    await page.reload();
    expect(await registrations(page)).toBe(1);
    expect((await cacheNames(page)).length).toBeGreaterThan(0);

    control(dirA, { unregister: true, deleteCaches: true }); // PUBLISHED
    await page.reload(); // the next load
    await expect
      .poll(() => registrations(page), {
        timeout: 20_000,
        message: 'the worker did not remove itself',
      })
      .toBe(0);
    await expect
      .poll(() => cacheNames(page), { timeout: 20_000, message: 'the caches were not cleared' })
      .toEqual([]);
    // the page still works: the load that triggered it was served, and the next one is plain network
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    // and while the order stands nothing registers again (the page reads the same file before it registers)
    await page.waitForTimeout(7000);
    expect(await registrations(page)).toBe(0);

    // the order is withdrawn: the next load registers a worker again
    control(dirA, { unregister: false, deleteCaches: false });
    await page.reload();
    await waitForWorker(page, 'a1');
    await page.context().close();
  });

  test('THE BUILD WITH THE WORKER OFF (VITE_SERVICE_WORKER=off): it never registers, and it removes a worker that an earlier build installed', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const off = join(TMP, 'off');
    rmSync(off, { recursive: true, force: true });
    // a RELATIVE outDir: the project path has spaces, and on Windows the command runs through a shell
    execFileSync(
      'pnpm',
      ['exec', 'vite', 'build', '--outDir', join('.e2e-tmp', 'sw', 'off'), '--emptyOutDir'],
      {
        cwd: FRONTEND,
        env: { ...process.env, VITE_SERVICE_WORKER: 'off' },
        shell: process.platform === 'win32',
        stdio: 'pipe',
      },
    );
    expect(readFileSync(join(off, 'sw.js'), 'utf8')).toContain('The RETIRING service worker');
    control(dirA, { unregister: false });
    server = await serve(dirA);
    const page = await freshPage(browser);
    await page.goto(deployUrl('/login'));
    await waitForWorker(page, 'a1');
    await page.reload();
    expect((await cacheNames(page)).length).toBeGreaterThan(0);

    // ship the build without a worker
    await server.stop();
    server = await serve(off);
    await page.reload(); // the browser's update check finds a different /sw.js: the retiring worker
    await expect
      .poll(() => registrations(page), {
        timeout: 40_000,
        message: 'the installed worker was not retired',
      })
      .toBe(0);
    await expect.poll(() => cacheNames(page), { timeout: 20_000 }).toEqual([]);
    // and the application itself does not register one (wait past the idle window of the registrar)
    await page.reload();
    await page.waitForTimeout(8000);
    expect(await registrations(page)).toBe(0);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await page.context().close();
  });
});

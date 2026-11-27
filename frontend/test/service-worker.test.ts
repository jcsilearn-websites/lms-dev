import { afterEach, describe, expect, it } from 'vitest';
import { precacheList, renderServiceWorker } from '../vite-plugin-sw';
import { client, type Env, ORIGIN, res, retiringWorker, worker, workerSource } from './sw-env';

// The text of frontend/sw/sw.js (the template the build ships) run against a fake service-worker scope. What is tested here is what ships.

const CONFIG = {
  buildId: 'b2',
  precache: ['/assets/index-aaa.js', '/assets/index-bbb.css', '/assets/ExamPage-ccc.js'],
};
const SHELL_NEW = res('<html>NEW SHELL</html>');
const SHELL_OLD = res('<html>OLD SHELL</html>');

let envs: Env[] = [];
const make = (opts?: Parameters<typeof worker>[1], config = CONFIG) => {
  const env = worker(config, opts);
  for (const p of config.precache) env.routes.set(p, res(`// ${p}`, { type: 'text/javascript' }));
  env.routes.set('/index.html', SHELL_NEW);
  env.routes.set(
    '/sw-control.json',
    res('{"unregister":false,"deleteCaches":false}', { type: 'application/json' }),
  );
  envs.push(env);
  return env;
};

afterEach(() => {
  // THE RULE, checked after every test: nothing of /api (or the worker's own files) was ever put in a cache
  for (const env of envs) {
    const offenders = env.caches
      .everything()
      .filter(
        (p) => p === '/api' || p.startsWith('/api/') || p === '/sw.js' || p === '/sw-control.json',
      );
    expect(offenders, `cached: ${offenders.join(', ')}`).toEqual([]);
  }
  envs = [];
});

describe('the template', () => {
  it('has exactly one placeholder (so the build replaces the code, not a comment) and renders to valid JavaScript', () => {
    expect(workerSource.split('__SW_CONFIG__')).toHaveLength(2);
    const out = renderServiceWorker(workerSource, CONFIG);
    expect(out).not.toContain('__SW_CONFIG__');
    expect(out).toContain('"buildId":"b2"');
    expect(() => new Function('self', out)).not.toThrow();
    expect(() => renderServiceWorker('no placeholder', CONFIG)).toThrow(/placeholder/);
  });

  it('has no skipWaiting at install and never claims the open pages', () => {
    const code = workerSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''); // comments may say "no clients.claim"
    expect(code).not.toMatch(/clients\.claim|\.claim\(/);
    // skipWaiting appears only inside the message handler, after the exam handshake
    const install = code.slice(
      code.indexOf("addEventListener('install'"),
      code.indexOf("addEventListener('activate'"),
    );
    expect(install).not.toContain('skipWaiting');
  });
});

describe('install and activate', () => {
  it('fetches the entry and exam chunks and the shell into caches NAMED FOR THE BUILD, and does not skip waiting', async () => {
    const env = make();
    await env.fire('install');
    expect(env.caches.paths('lms-assets-b2').sort()).toEqual([...CONFIG.precache].sort());
    expect(env.caches.paths('lms-shell-b2')).toEqual(['/index.html']);
    expect(env.skipWaiting).not.toHaveBeenCalled();
    // the shell is always fetched past the HTTP cache (a new build must not precache the previous shell); a hashed file may come from it
    const cacheMode = (path: string) =>
      (env.fetched.find((f) => f.path === path)?.init as { cache?: string } | undefined)?.cache;
    expect(cacheMode('/index.html')).toBe('reload');
    for (const p of CONFIG.precache) expect(cacheMode(p)).toBeUndefined();
  });

  it('fails the install (the old worker stays) when a file to precache cannot be fetched', async () => {
    const env = make();
    env.routes.delete('/assets/ExamPage-ccc.js');
    await expect(env.fire('install')).rejects.toThrow(/precache/);
    expect(env.skipWaiting).not.toHaveBeenCalled();
  });

  it('activation deletes the caches of OTHER builds, keeps its own and leaves caches that are not ours alone', async () => {
    const env = make();
    await env.fire('install');
    for (const name of ['lms-shell-b1', 'lms-assets-b1', 'some-other-app'])
      await env.caches.open(name);
    await env.fire('activate');
    expect([...(await env.caches.keys())].sort()).toEqual([
      'lms-assets-b2',
      'lms-shell-b2',
      'some-other-app',
    ]);
  });
});

describe('navigations: the shell is NETWORK-FIRST', () => {
  it('online: the network answer is returned even when a (stale) shell is cached, and the cache is refreshed from it', async () => {
    const env = make();
    await (await env.caches.open('lms-shell-b2')).put('/index.html', SHELL_OLD);
    env.routes.set('/offerings/x', SHELL_NEW);
    const { response } = await env.fetchEvent({ url: `${ORIGIN}/offerings/x`, mode: 'navigate' });
    expect((response as { body: string }).body).toContain('NEW SHELL');
    expect(env.caches.paths('lms-shell-b2')).toEqual(['/index.html']);
    expect((await (await env.caches.open('lms-shell-b2')).match('/index.html'))?.body).toContain(
      'NEW SHELL',
    );
  });

  it('a new release is never hidden: the page that is shown after a deploy is the new one on the very next navigation', async () => {
    const env = make();
    env.routes.set('/', SHELL_OLD);
    await env.fetchEvent({ url: `${ORIGIN}/`, mode: 'navigate' }); // visit under the old release: the old shell is cached
    env.routes.set('/', SHELL_NEW); // deploy
    const { response } = await env.fetchEvent({ url: `${ORIGIN}/`, mode: 'navigate' });
    expect((response as { body: string }).body).toContain('NEW SHELL');
  });

  it('offline: the last shell is shown (the exam can be reloaded); with nothing cached the failure is not hidden', async () => {
    const env = make();
    env.routes.set('/', SHELL_OLD);
    await env.fetchEvent({ url: `${ORIGIN}/`, mode: 'navigate' });
    env.offline = true;
    const { response } = await env.fetchEvent({
      url: `${ORIGIN}/offerings/o/attempts/a`,
      mode: 'navigate',
    });
    expect((response as { body: string }).body).toContain('OLD SHELL');
    const empty = make();
    empty.offline = true;
    const { response: none } = await empty.fetchEvent({ url: `${ORIGIN}/`, mode: 'navigate' });
    expect((none as { error: unknown }).error).toBeInstanceOf(TypeError);
  });

  it('an ERROR page from a reachable server (500, 404) is shown as it is, never replaced by the cache and never stored', async () => {
    const env = make();
    await (await env.caches.open('lms-shell-b2')).put('/index.html', SHELL_OLD);
    env.routes.set('/broken', res('upstream down', { status: 502 }));
    const { response } = await env.fetchEvent({ url: `${ORIGIN}/broken`, mode: 'navigate' });
    expect((response as { status: number }).status).toBe(502);
    expect((await (await env.caches.open('lms-shell-b2')).match('/index.html'))?.body).toContain(
      'OLD SHELL',
    );
  });

  it('only a real HTML answer becomes the shell (a redirect or a JSON body is not stored)', async () => {
    const env = make();
    env.routes.set('/r', res('x', { redirected: true }));
    env.routes.set('/j', res('{}', { type: 'application/json' }));
    await env.fetchEvent({ url: `${ORIGIN}/r`, mode: 'navigate' });
    await env.fetchEvent({ url: `${ORIGIN}/j`, mode: 'navigate' });
    expect(env.caches.paths('lms-shell-b2')).toEqual([]);
  });
});

describe('assets, and what is never touched', () => {
  it('a hashed asset is cache-first: a hit makes no request, a miss fetches and stores it', async () => {
    const env = make();
    env.routes.set('/assets/Page-1.js', res('page', { type: 'text/javascript' }));
    const first = await env.fetchEvent({ url: `${ORIGIN}/assets/Page-1.js` });
    expect(first.answered).toBe(true);
    expect(env.caches.paths('lms-assets-b2')).toContain('/assets/Page-1.js');
    env.fetched.length = 0;
    const second = await env.fetchEvent({ url: `${ORIGIN}/assets/Page-1.js` });
    expect((second.response as { body: string }).body).toBe('page');
    expect(env.fetched).toEqual([]);
  });

  it("/api, other origins, non-GET requests and the worker's own files are NOT answered by the worker at all", async () => {
    const env = make();
    for (const request of [
      { url: `${ORIGIN}/api/auth/me` },
      { url: `${ORIGIN}/api/offerings/1/outline` },
      { url: `${ORIGIN}/api`, mode: 'navigate' },
      { url: `${ORIGIN}/api/video/play/tok/asset/seg1.m4s` },
      { url: 'https://cdn.example.org/assets/x.js' },
      { url: `${ORIGIN}/assets/x.js`, method: 'POST' },
      { url: `${ORIGIN}/api/attempts`, method: 'PUT' },
      { url: `${ORIGIN}/sw.js` },
      { url: `${ORIGIN}/sw-control.json` },
      { url: `${ORIGIN}/something.png` },
    ]) {
      const out = await env.fetchEvent(request);
      expect(out.answered, JSON.stringify(request)).toBe(false);
    }
    expect(env.fetched).toEqual([]);
  });

  it('a path that only LOOKS like an asset but resolves into /api is untouchable, and nothing can make the worker store it', async () => {
    const env = make();
    env.routes.set('/api/me', res('{"email":"someone@x.org"}', { type: 'application/json' }));
    const out = await env.fetchEvent({ url: `${ORIGIN}/assets/../api/me` });
    expect(out.answered).toBe(false);
    // sanity: the recording cache would have noticed (afterEach checks every test)
    expect(env.caches.everything().some((p) => p.startsWith('/api'))).toBe(false);
  });

  it('after a whole session of requests (pages, assets, API calls) not one /api path is in any cache', async () => {
    const env = make();
    env.routes.set('/', SHELL_NEW);
    env.routes.set('/assets/a-1.js', res('a', { type: 'text/javascript' }));
    await env.fire('install');
    for (const url of [
      '/',
      '/assets/a-1.js',
      '/api/auth/me',
      '/api/me/courses',
      '/api/offerings/x/attempts/y',
      '/api/video/play/t/a/seg.m4s',
    ]) {
      await env.fetchEvent({
        url: `${ORIGIN}${url}`,
        mode: url === '/' ? 'navigate' : 'same-origin',
      });
    }
    const all = env.caches.everything();
    expect(all.length).toBeGreaterThan(3);
    expect(all.filter((p) => p.startsWith('/api'))).toEqual([]);
  });
});

describe('updates never take over by themselves, and never mid-exam', () => {
  it('SKIP_WAITING with no exam anywhere: the new worker takes over', async () => {
    const env = make({ clients: [client(false), client(false)] });
    await env.message({ type: 'SKIP_WAITING' });
    expect(env.skipWaiting).toHaveBeenCalledOnce();
  });

  it('SKIP_WAITING while ANY page is in an exam: it stays waiting and the asking page is told it was deferred', async () => {
    const env = make({ clients: [client(false), client(true)] });
    const told: unknown[] = [];
    await env.message({ type: 'SKIP_WAITING' }, { postMessage: (m) => told.push(m) });
    expect(env.skipWaiting).not.toHaveBeenCalled();
    expect(told).toEqual([{ type: 'UPDATE_DEFERRED' }]);
  });

  it('a page that never answers the question is treated as not busy (after a short wait), so a dead tab cannot block updates for ever', async () => {
    const env = make({ clients: [client(undefined)] });
    await env.message({ type: 'SKIP_WAITING' });
    expect(env.skipWaiting).toHaveBeenCalledOnce();
  });

  it('CLEAR_CACHES (sign-out) deletes every cache of ours and nothing else', async () => {
    const env = make();
    await env.fire('install');
    await env.caches.open('some-other-app');
    await env.message({ type: 'CLEAR_CACHES' });
    expect(await env.caches.keys()).toEqual(['some-other-app']);
  });
});

describe('the kill switch (sw-control.json)', () => {
  const order = (env: Env, body: Record<string, unknown>) =>
    env.routes.set('/sw-control.json', res(JSON.stringify(body), { type: 'application/json' }));

  it('is read with no-store, past every cache, and an order to unregister clears the caches and removes the worker (at activation)', async () => {
    const env = make();
    await env.fire('install');
    order(env, { unregister: true });
    await env.fire('activate');
    expect(await env.caches.keys()).toEqual([]);
    expect(env.unregister).toHaveBeenCalledOnce();
    const read = env.fetched.find((f) => f.path === '/sw-control.json');
    expect((read?.init as { cache?: string } | undefined)?.cache).toBe('no-store');
  });

  it('is also read on a NAVIGATION: an installed worker obeys on the next load, without a new worker version', async () => {
    const env = make();
    env.routes.set('/', SHELL_NEW);
    await env.fire('install');
    await env.fire('activate'); // control says nothing yet
    expect(env.unregister).not.toHaveBeenCalled();
    order(env, { unregister: true, deleteCaches: true });
    // the throttle (30 s) is per worker instance: force a fresh instance as a restarted worker would be
    const restarted = make();
    restarted.routes.set('/', SHELL_NEW);
    order(restarted, { unregister: true, deleteCaches: true });
    await restarted.fire('install');
    restarted.unregister.mockClear();
    await (await restarted.caches.open('lms-shell-b2')).put('/index.html', SHELL_OLD);
    const out = await restarted.fetchEvent({ url: `${ORIGIN}/`, mode: 'navigate' });
    expect(out.answered).toBe(true); // this load is still served
    expect(restarted.unregister).toHaveBeenCalledOnce();
    expect(await restarted.caches.keys()).toEqual([]);
  });

  it('deleteCaches alone clears the caches and keeps the worker', async () => {
    const env = make();
    await env.fire('install');
    order(env, { deleteCaches: true });
    await env.fire('activate');
    expect(await env.caches.keys()).toEqual([]);
    expect(env.unregister).not.toHaveBeenCalled();
  });

  it('an exam in some page defers the order (nothing removed), and the next check after the exam carries it out', async () => {
    const busy = client(true);
    const env = make({ clients: [busy] });
    await env.fire('install');
    order(env, { unregister: true });
    await env.fire('activate');
    expect(env.unregister).not.toHaveBeenCalled();
    expect((await env.caches.keys()).length).toBeGreaterThan(0);
    busy.busy = false; // the exam ended
    env.routes.set('/', SHELL_NEW);
    await env.fetchEvent({ url: `${ORIGIN}/`, mode: 'navigate' });
    expect(env.unregister).toHaveBeenCalledOnce();
    expect(await env.caches.keys()).toEqual([]);
  });

  it('a control file that cannot be read (offline, 404, nonsense) changes nothing', async () => {
    for (const setup of [
      (e: Env) => (e.offline = true),
      (e: Env) => e.routes.delete('/sw-control.json'),
      (e: Env) => e.routes.set('/sw-control.json', res('not json', { type: 'application/json' })),
    ]) {
      const env = make();
      await env.fire('install');
      env.offline = false;
      setup(env);
      await env.fire('activate');
      expect(env.unregister).not.toHaveBeenCalled();
      expect(await env.caches.keys()).toContain('lms-assets-b2');
    }
  });
});

describe('the retiring worker (VITE_SERVICE_WORKER=off)', () => {
  it('removes every cache of ours and then itself; it has no fetch handler (every request goes to the network)', async () => {
    const env = retiringWorker();
    for (const name of ['lms-shell-b1', 'lms-assets-b1', 'some-other-app'])
      await env.caches.open(name);
    await env.fire('install');
    expect(env.skipWaiting).toHaveBeenCalledOnce();
    await env.fire('activate');
    expect(await env.caches.keys()).toEqual(['some-other-app']);
    expect(env.unregister).toHaveBeenCalledOnce();
    expect((await env.fetchEvent({ url: `${ORIGIN}/`, mode: 'navigate' })).answered).toBe(false);
  });

  it('does not take over while an exam is running in a page: it waits', async () => {
    const env = retiringWorker({ clients: [client(true)] });
    await env.fire('install');
    expect(env.skipWaiting).not.toHaveBeenCalled();
  });
});

describe('the build: which files are precached', () => {
  const chunk = (
    fileName: string,
    over: Partial<Parameters<typeof precacheList>[0][number]> = {},
  ) => ({ fileName, imports: [], css: [], isEntry: false, facadeModuleId: null, ...over });

  it('is the entry chunk, the exam route chunk and what either imports (stylesheets included), and nothing else', () => {
    const list = precacheList([
      chunk('assets/index-1.js', {
        isEntry: true,
        imports: ['assets/client-2.js'],
        css: ['assets/index-3.css'],
      }),
      chunk('assets/client-2.js'),
      chunk('assets/ExamPage-4.js', {
        facadeModuleId: 'D:/x/frontend/src/features/assessments/exam/ExamPage.tsx',
        imports: ['assets/client-2.js', 'assets/dialog-5.js'],
      }),
      chunk('assets/dialog-5.js'),
      chunk('assets/BuilderPage-6.js', {
        facadeModuleId: 'D:/x/frontend/src/features/courses/BuilderPage.tsx',
        imports: ['assets/builder-only-7.js'],
      }),
      chunk('assets/builder-only-7.js'),
      chunk('assets/RichTextEditor-8.js'),
    ]);
    expect(list).toEqual([
      '/assets/ExamPage-4.js',
      '/assets/client-2.js',
      '/assets/dialog-5.js',
      '/assets/index-1.js',
      '/assets/index-3.css',
    ]);
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeLabel } from '../src/client.mjs';
import { OPTION_DEFS, resolveConfig } from '../src/config.mjs';
import { allowlistFrom, assertAllowedTarget, hostAllowed } from '../src/guard.mjs';
import { parseMaster, parseMedia, pickWeighted } from '../src/hls.mjs';

test('the guard allows this machine and *.localhost, and nothing else by default', () => {
  const allow = allowlistFrom({});
  for (const h of ['localhost', '127.0.0.1', '::1', 'bench-lt-ab12.localhost', 'a.b.localhost'])
    assert.equal(hostAllowed(h, allow), true, h);
  for (const h of [
    'example.org',
    'lms.example.org',
    'notlocalhost',
    'localhost.evil.org',
    '10.0.0.5',
    'evil-localhost',
  ])
    assert.equal(hostAllowed(h, allow), false, h);
  assert.equal(hostAllowed('[::1]', allow), true);
});

test('LOADTEST_ALLOWED_HOSTS adds a named staging host or a *.suffix, and rejects nonsense', () => {
  const allow = allowlistFrom({
    LOADTEST_ALLOWED_HOSTS: 'staging.example.org, *.stage.example.org',
  });
  assert.equal(hostAllowed('staging.example.org', allow), true);
  assert.equal(hostAllowed('college.stage.example.org', allow), true);
  assert.equal(
    hostAllowed('stage.example.org', allow),
    false,
    '*.suffix does not include the bare suffix',
  );
  assert.equal(hostAllowed('example.org', allow), false);
  for (const bad of ['*', '*.', 'a b', 'http://x', 'x/y'])
    assert.throws(() => allowlistFrom({ LOADTEST_ALLOWED_HOSTS: bad }), /LOADTEST_ALLOWED_HOSTS/);
});

test('assertAllowedTarget refuses production, an unlisted host and a non-URL; there is no way around it', () => {
  assert.equal(assertAllowedTarget('http://127.0.0.1:3100', { env: {} }), '127.0.0.1');
  assert.equal(
    assertAllowedTarget('postgresql://postgres:x@localhost:5432/lms', {
      what: 'database',
      env: {},
    }),
    'localhost',
  );
  assert.throws(
    () => assertAllowedTarget('http://127.0.0.1:3100', { env: { NODE_ENV: 'production' } }),
    /NODE_ENV is production/,
  );
  assert.throws(
    () => assertAllowedTarget('https://lms.example.org', { env: {} }),
    /not on the allowlist/,
  );
  assert.throws(() => assertAllowedTarget('not a url', { env: {} }), /not a URL/);
  // a production host is not made reachable by the allowlist of another environment variable
  assert.throws(
    () => assertAllowedTarget('https://lms.example.org', { env: { ALLOW: 'lms.example.org' } }),
    /not on the allowlist/,
  );
  assert.equal(
    assertAllowedTarget('https://staging.example.org', {
      env: { LOADTEST_ALLOWED_HOSTS: 'staging.example.org' },
    }),
    'staging.example.org',
  );
});

test('route labels replace ids and tokens, so statistics are per route, never per learner', () => {
  assert.equal(
    routeLabel(
      'GET',
      '/api/offerings/01a2129e-d616-7d4a-abbb-dee29f382c4f/items/01a2129e-db48-7be0-91b9-3ecd3205e7d2/assignment?x=1',
    ),
    'GET /api/offerings/:id/items/:id/assignment',
  );
  assert.equal(
    routeLabel('GET', `/api/video/play/${'a'.repeat(43)}/x`),
    'GET /api/video/play/:token/x'.replace(':token', ':token'),
  );
});

test('HLS: a master lists variants with their height, a media playlist its init segment and durations', () => {
  const master =
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n360p/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720\n720p/index.m3u8\n';
  const v = parseMaster(master);
  assert.deepEqual(
    v.map((x) => [x.uri, x.height, x.name]),
    [
      ['360p/index.m3u8', 360, '360p'],
      ['720p/index.m3u8', 720, '720p'],
    ],
  );
  const media =
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6.000,\nseg0.m4s\n#EXTINF:6.000,\nseg1.m4s\n#EXTINF:2.5,\nseg2.m4s\n#EXT-X-ENDLIST\n';
  const m = parseMedia(media);
  assert.equal(m.init, 'init.mp4');
  assert.deepEqual(m.segments, [
    { uri: 'seg0.m4s', seconds: 6 },
    { uri: 'seg1.m4s', seconds: 6 },
    { uri: 'seg2.m4s', seconds: 2.5 },
  ]);
  assert.equal(m.totalSeconds, 14.5);
});

test('the rendition mix: 20 / 30 / 50 % over many draws', () => {
  let s = 0x1234;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const counts = [0, 0, 0];
  for (let i = 0; i < 20_000; i++) counts[pickWeighted([0.2, 0.3, 0.5], rnd())]++;
  assert.ok(Math.abs(counts[0] / 20_000 - 0.2) < 0.02);
  assert.ok(Math.abs(counts[1] / 20_000 - 0.3) < 0.02);
  assert.ok(Math.abs(counts[2] / 20_000 - 0.5) < 0.02);
});

test('the scale flags: counts are scaled, durations shrunk, one flag overrides one number', () => {
  const defaults = Object.fromEntries(
    Object.entries(OPTION_DEFS)
      .filter(([, d]) => d.default !== undefined)
      .map(([k, d]) => [k, d.default]),
  );
  const full = resolveConfig(defaults);
  assert.deepEqual(
    [full.learners, full.viewers, full.browsers, full.graders],
    [1500, 2000, 1000, 20],
  );
  assert.equal(full.examSeconds, 3600);
  const small = resolveConfig({ ...defaults, scale: '0.1', 'time-scale': '0.01', viewers: '37' });
  assert.deepEqual(
    [small.learners, small.viewers, small.browsers, small.graders],
    [150, 37, 100, 2],
  );
  assert.equal(small.examSeconds, 36);
  // the cadence of ONE person is not a window: it stays at its real value unless --cadence-scale says otherwise
  assert.equal(small.heartbeatSeconds, 30);
  assert.equal(small.saveEverySeconds, 30);
  // one generator of several takes the learners after its offset (disjoint ranges, docs/load-testing.md)
  assert.equal(full.learnerOffset, 0);
  assert.equal(resolveConfig({ ...defaults, 'learner-offset': '1000' }).learnerOffset, 1000);
  const quick = resolveConfig({ ...defaults, 'cadence-scale': '0.01' });
  assert.equal(quick.heartbeatSeconds, 0.3);
  assert.equal(quick.examSeconds, 3600);
  assert.throws(
    () => resolveConfig({ ...defaults, scale: '0' }),
    /--scale must be a positive number/,
  );
});

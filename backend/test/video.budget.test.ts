import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { makeApp, type TestApp } from './app';
import {
  errorCode,
  type Json,
  loginAs,
  newCourse,
  newOffering,
  ok,
  type Person,
  person,
  structure,
} from './courses-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Round-trip budgets and the playback hot path of the video lessons (no ffmpeg: the ready video is a hand-made
// tree of small files, only the SQL and the HTTP layer are under test), plus what the logs may contain.

const STORAGE = process.env.TEST_STORAGE_DIR ?? '.storage-test';
const VTT = 'WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n';
// an MP4-looking start: passes the first-bytes check
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
  Buffer.alloc(988),
]);

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let instructor: Person;
let learner: Person;
let offeringId: string;
let videoId: string;
let itemId: string;

async function fakeReadyVideo(): Promise<string> {
  const id = newId();
  await owner.query(
    `INSERT INTO lms.video_assets (id, tenant_id, offering_id, created_by, original_name, declared_size, status,
                                   duration_ms, hls_prefix, ready_at, upload_offset, progress, renditions)
     VALUES ($1, $2, $3, $4, 'fake.mp4', 1000, 'ready', 4000, $5, now(), 1000, 100, $6::jsonb)`,
    [
      id,
      A.tenantId,
      offeringId,
      instructor.userId,
      `${A.tenantId}/${id}/hls`,
      JSON.stringify([{ name: '240p', width: 320, height: 240, videoKbps: 200, bytes: 3000 }]),
    ],
  );
  const dir = path.resolve(STORAGE, A.tenantId, id);
  mkdirSync(path.join(dir, 'hls', '240p'), { recursive: true });
  writeFileSync(path.join(dir, 'hls', 'master.m3u8'), '#EXTM3U\n240p/index.m3u8\n');
  writeFileSync(
    path.join(dir, 'hls', '240p', 'index.m3u8'),
    '#EXTM3U\n#EXTINF:4,\nseg_00000.m4s\n#EXT-X-ENDLIST\n',
  );
  writeFileSync(path.join(dir, 'hls', '240p', 'init.mp4'), Buffer.alloc(500, 1));
  writeFileSync(path.join(dir, 'hls', '240p', 'seg_00000.m4s'), Buffer.alloc(3000, 2));
  writeFileSync(path.join(dir, 'poster.jpg'), Buffer.alloc(300, 3));
  return id;
}

beforeAll(async () => {
  owner = testOwnerPool();
  // the budgets are STEADY STATE (slug cache warm); a 2 s session cache makes the expiry test quick
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000', VIDEO_SESSION_CACHE_TTL_SECONDS: '2' } });
  A = await createAuthFixture(owner, 'vb-a');
  await t.app.ready();
  const admin = await loginAs(t, A.host, A.adminEmail);
  const s = await structure(admin);
  const o = await newOffering(admin, (await newCourse(admin)).id, s.termId);
  offeringId = o.id;
  instructor = await person(owner, t, A, 'Instructor');
  learner = await person(owner, t, A, 'Learner');
  for (const [p, participation] of [
    [instructor, 'instructor'],
    [learner, 'learner'],
  ] as const) {
    ok(await admin.post(`/offerings/${o.id}/participants`, { userId: p.userId, participation }));
  }
  ok(await instructor.client.post(`/offerings/${o.id}/publish`));
  const m = ok(await instructor.client.post(`/offerings/${o.id}/modules`, { title: 'M' }));
  ok(await instructor.client.patch(`/offerings/${o.id}/modules/${m.id}`, { published: true }));
  videoId = await fakeReadyVideo();
  itemId = ok(
    await instructor.client.post(`/offerings/${o.id}/modules/${m.id}/items`, {
      kind: 'video',
      title: 'Lecture',
      videoId,
      published: true,
    }),
  ).id;
  // warm the pool, the slug cache and the sessions
  await instructor.client.get('/auth/me');
  await learner.client.get('/auth/me');
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

async function measure(fn: () => Promise<unknown>): Promise<string[]> {
  t.statements.reset();
  await fn();
  await t.app.modules.background.drain();
  return t.statements.statements;
}
const budget = (name: string, statements: string[], max: number) => {
  const listing = statements.map((s) => s.replace(/\s+/g, ' ').slice(0, 90)).join('\n  ');
  process.stdout.write(`ROUND-TRIPS ${name}: ${statements.length} (budget ${max})\n`);
  expect(
    statements.length,
    `${name} used ${statements.length} round trips:\n  ${listing}`,
  ).toBeLessThanOrEqual(max);
};

describe('round-trip budgets: video', () => {
  it('upload: create, offset, chunk, complete, read: 4 each (one fused statement)', async () => {
    const c = instructor.client;
    let created: Json = {};
    budget(
      'POST /offerings/:id/videos',
      await measure(async () => {
        created = ok(
          await c.post(`/offerings/${offeringId}/videos`, { fileName: 'a.mp4', size: MP4.length }),
        );
      }),
      4,
    );
    const id = created.video.id as string;
    budget(
      'GET .../videos/:id/upload',
      await measure(async () => {
        ok(await c.get(`/offerings/${offeringId}/videos/${id}/upload`));
      }),
      4,
    );
    budget(
      'PATCH .../videos/:id/upload (one chunk)',
      await measure(async () => {
        const r = await c.request('PATCH', `/offerings/${offeringId}/videos/${id}/upload`, {
          body: MP4,
          headers: {
            'content-type': 'application/offset+octet-stream',
            'upload-offset': '0',
            'content-length': String(MP4.length),
          },
        });
        expect(r.statusCode, r.body).toBe(200);
      }),
      4,
    );
    budget(
      'GET .../videos/:id',
      await measure(async () => {
        ok(await c.get(`/offerings/${offeringId}/videos/${id}`));
      }),
      4,
    );
    budget(
      'POST .../videos/:id/complete (state change + the queue job)',
      await measure(async () => {
        expect((await c.post(`/offerings/${offeringId}/videos/${id}/complete`)).statusCode).toBe(
          202,
        );
      }),
      4,
    );
    const job = await owner.query(
      "SELECT queue, tenant_id FROM lms.jobs WHERE queue = 'video' AND payload->>'assetId' = $1",
      [id],
    );
    expect(job.rowCount).toBe(1);
  });

  it('captions: add, delete, and the video delete: 4 each', async () => {
    const c = instructor.client;
    budget(
      'POST .../captions',
      await measure(async () => {
        ok(
          await c.post(`/offerings/${offeringId}/videos/${videoId}/captions`, {
            language: 'en',
            label: 'English',
            content: VTT,
          }),
        );
      }),
      4,
    );
    budget(
      'DELETE .../captions/:language',
      await measure(async () => {
        ok(await c.delete(`/offerings/${offeringId}/videos/${videoId}/captions/en`));
      }),
      4,
    );
    const spare = await fakeReadyVideo();
    budget(
      'DELETE .../videos/:id',
      await measure(async () => {
        ok(await c.delete(`/offerings/${offeringId}/videos/${spare}`));
      }),
      4,
    );
  });

  it('POST /offerings/:id/items/:itemId/playback (learner and instructor): 4', async () => {
    for (const p of [learner, instructor]) {
      budget(
        'POST .../items/:itemId/playback',
        await measure(async () => {
          ok(await p.client.post(`/offerings/${offeringId}/items/${itemId}/playback`));
        }),
        4,
      );
    }
  });

  it('the outline with a video item stays ONE statement: 4', async () => {
    budget(
      'GET .../outline (with a video)',
      await measure(async () => {
        const r = ok(await learner.client.get(`/offerings/${offeringId}/outline`));
        expect(r.modules[0].items[0].video).toMatchObject({ id: videoId, status: 'ready' });
      }),
      4,
    );
  });
});

describe('the playback hot path', () => {
  it('20 consecutive segment requests of one session cost at most 1 database lookup', async () => {
    const play = ok(await learner.client.post(`/offerings/${offeringId}/items/${itemId}/playback`));
    const base = play.manifestUrl.replace('master.m3u8', '');
    const urls = [play.manifestUrl, `${base}240p/index.m3u8`, `${base}240p/init.mp4`];
    for (let i = 0; i < 17; i++) urls.push(`${base}240p/seg_00000.m4s`);
    expect(urls).toHaveLength(20);
    const s = await measure(async () => {
      for (const u of urls) expect((await learner.client.get(u)).statusCode).toBe(200);
    });
    budget('20 playback file requests', s, 1);
    expect(s.length).toBe(1); // the first one looks the session up, the other 19 are served from the cache
  });

  it('a revoked session keeps playing for at most the cache TTL, then the request is refused', async () => {
    const other = await person(owner, t, A, 'Viewer');
    const admin = await loginAs(t, A.host, A.adminEmail);
    ok(
      await admin.post(`/offerings/${offeringId}/participants`, {
        userId: other.userId,
        participation: 'learner',
      }),
    );
    const play = ok(await other.client.post(`/offerings/${offeringId}/items/${itemId}/playback`));
    expect((await other.client.get(play.manifestUrl)).statusCode).toBe(200); // cached now
    const cookies = new Map(other.client.cookies);
    ok(await other.client.post('/auth/logout')); // revokes the session
    const replay = (await import('./client')).TestClient;
    const stale = new replay(t, A.host);
    stale.cookies = new Map(cookies);
    expect((await stale.get(play.manifestUrl)).statusCode).toBe(200); // within the TTL (documented)
    await new Promise((r) => setTimeout(r, 2300));
    expect((await stale.get(play.manifestUrl)).statusCode).toBe(401); // the cache entry expired: the DB says no
  });
});

describe('logs never contain a playback token', () => {
  it('neither the request line, nor an error, nor the 403 of a bad token', async () => {
    const quiet = makeApp({ logLevel: 'info' });
    try {
      await quiet.app.ready();
      const lc = await loginAs(quiet, A.host, learner.email);
      const play = ok(await lc.post(`/offerings/${offeringId}/items/${itemId}/playback`));
      const token = play.manifestUrl.split('/')[4] as string;
      await lc.get(play.manifestUrl);
      await lc.get(play.manifestUrl.replace('master.m3u8', '240p/seg_00000.m4s'));
      await lc.get(play.manifestUrl.replace('master.m3u8', 'nothing-here'));
      await lc.get(`${play.manifestUrl.replace(token, `${token}x`)}`); // refused
      await new Promise((r) => setTimeout(r, 50));
      const text = quiet.logs.map((l) => JSON.stringify(l)).join('\n');
      expect(text).toContain('/video/play/[redacted]/');
      expect(text).not.toContain(token);
      expect(text).not.toContain(token.slice(0, 40));
      expect(errorCode(await lc.get(`${play.manifestUrl.replace(token, 'x'.repeat(30))}`))).toBe(
        'invalid_link',
      );
    } finally {
      await quiet.close();
    }
  });
});

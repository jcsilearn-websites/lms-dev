import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPlaybackTokens, playbackKey } from '../src/core/video';
import { makeApp, type TestApp } from './app';
import type { TestClient } from './client';
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
import {
  assertFfmpeg,
  bogusMp4,
  CLIPS,
  createVideo,
  FFMPEG,
  patchChunk,
  probeJson,
  processVideo,
  sendChunks,
  sha256,
  truncated,
  uploadAndProcess,
  uploadVideo,
  writeTmp,
} from './video-helpers';

// Step 7: video lessons. Real ffmpeg on tiny generated clips (no copyrighted material). The resumable upload,
// the limits, the ladder (never upscaled, aligned key frames), failure reasons, playback tokens and Range
// requests, source retention and the purge of orphans. Round-trip budgets are in query-budget.test.ts.

// real ffmpeg runs: far above the 10 s default
vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const SECRET = 'test-only-signing-secret-0123456789abcdef';
const STORAGE = process.env.TEST_STORAGE_DIR ?? '.storage-test';

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
let admin: TestClient;
let adminB: TestClient;
let termId: string;

interface Setup {
  offeringId: string;
  instructor: Person;
  learner: Person;
  outsider: Person;
  moduleId: string;
}

beforeAll(async () => {
  assertFfmpeg();
  owner = testOwnerPool();
  t = makeApp({
    env: { VIDEO_MAX_BYTES: String(50 * 1024 * 1024), VIDEO_PLAYBACK_TTL_SECONDS: '600' },
  });
  A = await createAuthFixture(owner, 'vd-a');
  B = await createAuthFixture(owner, 'vd-b');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  adminB = await loginAs(t, B.host, B.adminEmail);
  termId = (await structure(admin)).termId;
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

async function setup(): Promise<Setup> {
  const c = await newCourse(admin);
  const o = await newOffering(admin, c.id, termId);
  const instructor = await person(owner, t, A, 'Instructor');
  const learner = await person(owner, t, A, 'Learner');
  const outsider = await person(owner, t, A, 'Outsider');
  for (const [p, participation] of [
    [instructor, 'instructor'],
    [learner, 'learner'],
  ] as const) {
    ok(await admin.post(`/offerings/${o.id}/participants`, { userId: p.userId, participation }));
  }
  ok(await instructor.client.post(`/offerings/${o.id}/publish`));
  const m = ok(await instructor.client.post(`/offerings/${o.id}/modules`, { title: 'M' }));
  ok(await instructor.client.patch(`/offerings/${o.id}/modules/${m.id}`, { published: true }));
  return { offeringId: o.id, instructor, learner, outsider, moduleId: m.id };
}

const addItem = async (s: Setup, videoId: string, extra: Json = {}) =>
  ok(
    await s.instructor.client.post(`/offerings/${s.offeringId}/modules/${s.moduleId}/items`, {
      kind: 'video',
      title: 'Lecture',
      videoId,
      published: true,
      ...extra,
    }),
  );

const sourcePath = (tenantId: string, assetId: string) =>
  path.resolve(STORAGE, tenantId, assetId, 'source');
const hlsDir = (tenantId: string, assetId: string, ...rest: string[]) =>
  path.resolve(STORAGE, tenantId, assetId, 'hls', ...rest);

// ---------------------------------------------------------------------------------------------------
describe('resumable upload', () => {
  it('walks the protocol in chunks: create, PATCH, offset, complete', async () => {
    const s = await setup();
    const bytes = CLIPS.tiny();
    const { video, chunkBytes } = await createVideo(
      s.instructor.client,
      s.offeringId,
      'lecture.mp4',
      bytes.length,
    );
    expect(chunkBytes).toBe(32768);
    expect(video).toMatchObject({ status: 'uploading', uploadOffset: 0, size: bytes.length });
    expect(bytes.length).toBeGreaterThan(chunkBytes); // several requests

    const end = await sendChunks(s.instructor.client, s.offeringId, video.id, bytes, chunkBytes);
    expect(end).toBe(bytes.length);
    const offset = ok(
      await s.instructor.client.get(`/offerings/${s.offeringId}/videos/${video.id}/upload`),
    );
    expect(offset).toMatchObject({ uploadOffset: bytes.length, status: 'uploading' });
    expect(sha256(readFileSync(sourcePath(A.tenantId, video.id)))).toBe(sha256(bytes));

    const done = await s.instructor.client.post(
      `/offerings/${s.offeringId}/videos/${video.id}/complete`,
    );
    expect(done.statusCode).toBe(202);
    expect(done.json().status).toBe('processing');
    // asking twice is not an error
    const again = await s.instructor.client.post(
      `/offerings/${s.offeringId}/videos/${video.id}/complete`,
    );
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('processing');
  });

  it('a dropped connection resumes from where the bytes ended instead of restarting', async () => {
    const s = await setup();
    const bytes = CLIPS.tiny();
    const { video, chunkBytes } = await createVideo(
      s.instructor.client,
      s.offeringId,
      'lecture.mp4',
      bytes.length,
    );
    await sendChunks(
      s.instructor.client,
      s.offeringId,
      video.id,
      bytes.subarray(0, chunkBytes * 2),
      chunkBytes,
    );
    // the third chunk is cut off half way (the body is shorter than its Content-Length)
    const full = bytes.subarray(chunkBytes * 2, chunkBytes * 3);
    const half = full.subarray(0, 10_000);
    const cut = await s.instructor.client.request(
      'PATCH',
      `/offerings/${s.offeringId}/videos/${video.id}/upload`,
      {
        body: half,
        headers: {
          'content-type': 'application/offset+octet-stream',
          'upload-offset': String(chunkBytes * 2),
          'content-length': String(full.length),
        },
      },
    );
    void cut; // whatever the transport made of it: the storage knows what arrived
    const where = ok(
      await s.instructor.client.get(`/offerings/${s.offeringId}/videos/${video.id}/upload`),
    );
    expect(where.uploadOffset).toBeGreaterThanOrEqual(chunkBytes * 2);
    expect(where.uploadOffset).toBeLessThan(chunkBytes * 3);
    // the client asks where to resume, and sends the rest from there
    const end = await sendChunks(
      s.instructor.client,
      s.offeringId,
      video.id,
      bytes,
      chunkBytes,
      where.uploadOffset,
    );
    expect(end).toBe(bytes.length);
    expect(sha256(readFileSync(sourcePath(A.tenantId, video.id)))).toBe(sha256(bytes));
    const done = await s.instructor.client.post(
      `/offerings/${s.offeringId}/videos/${video.id}/complete`,
    );
    expect(done.statusCode).toBe(202);
  });

  it('refuses a chunk that does not start where the bytes end, or runs past the end', async () => {
    const s = await setup();
    const bytes = CLIPS.tiny();
    const { video, chunkBytes } = await createVideo(
      s.instructor.client,
      s.offeringId,
      'a.mp4',
      bytes.length,
    );
    const gap = await patchChunk(
      s.instructor.client,
      s.offeringId,
      video.id,
      5000,
      bytes.subarray(5000, 6000),
    );
    expect(gap.statusCode).toBe(409);
    expect(errorCode(gap)).toBe('upload_offset_mismatch');
    const past = await patchChunk(
      s.instructor.client,
      s.offeringId,
      video.id,
      0,
      Buffer.concat([bytes, bytes]).subarray(0, chunkBytes),
    );
    expect(past.statusCode).toBe(200);
    const beyond = await patchChunk(
      s.instructor.client,
      s.offeringId,
      video.id,
      chunkBytes,
      Buffer.alloc(bytes.length),
    );
    expect(beyond.statusCode).toBe(409);
    const early = await s.instructor.client.post(
      `/offerings/${s.offeringId}/videos/${video.id}/complete`,
    );
    expect(early.statusCode).toBe(409);
    expect(errorCode(early)).toBe('upload_incomplete');
  });

  it('allows one writer per upload', async () => {
    const s = await setup();
    const bytes = CLIPS.tiny();
    const { video } = await createVideo(s.instructor.client, s.offeringId, 'a.mp4', bytes.length);
    const ctx = { ...(await admin.get('/auth/me')).json(), tenantId: A.tenantId };
    void ctx;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = Readable.from(
      (async function* () {
        yield bytes.subarray(0, 100);
        await gate;
        yield bytes.subarray(100, 200);
      })(),
    );
    const svc = t.app.modules.video.service;
    const rc = {
      userId: s.instructor.userId,
      tenantId: A.tenantId,
      role: 'member',
      isPlatformAdmin: false,
      sessionId: 'x',
      email: 'x',
      displayName: 'x',
      ip: null,
      userAgent: null,
    } as never;
    const first = svc.appendChunk(rc, s.offeringId, video.id, {
      offset: 0,
      length: 200,
      body: slow,
    });
    await new Promise((r) => setTimeout(r, 300));
    await expect(
      svc.appendChunk(rc, s.offeringId, video.id, {
        offset: 0,
        length: 200,
        body: Readable.from([bytes.subarray(0, 200)]),
      }),
    ).rejects.toMatchObject({ code: 'upload_busy' });
    release();
    await first.catch(() => undefined);
  });

  it('enforces size, type and content limits before accepting the data', async () => {
    const s = await setup();
    const c = s.instructor.client;
    const big = await c.post(`/offerings/${s.offeringId}/videos`, {
      fileName: 'big.mp4',
      size: 60 * 1024 * 1024,
    });
    expect(big.statusCode).toBe(413);
    expect(errorCode(big)).toBe('video_too_large');
    for (const name of ['evil.exe', 'page.html', 'clip.avi', 'noext', 'x.mp4.exe']) {
      const r = await c.post(`/offerings/${s.offeringId}/videos`, { fileName: name, size: 1000 });
      expect(r.statusCode, name).toBe(400);
      expect(errorCode(r), name).toBe('video_type_not_allowed');
    }
    // a renamed document: refused with the very first chunk, and nothing stays on disk
    const { video } = await createVideo(c, s.offeringId, 'notes.mp4', 5000);
    const pdf = Buffer.from('%PDF-1.4\n'.repeat(500));
    const res = await patchChunk(c, s.offeringId, video.id, 0, pdf.subarray(0, 5000));
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('video_content_mismatch');
    expect(existsSync(sourcePath(A.tenantId, video.id))).toBe(false);
    const where = ok(await c.get(`/offerings/${s.offeringId}/videos/${video.id}/upload`));
    expect(where.uploadOffset).toBe(0);
  });

  it('only people who may edit the offering can upload; others learn nothing', async () => {
    const s = await setup();
    const body = { fileName: 'a.mp4', size: 1000 };
    expect(
      (await s.learner.client.post(`/offerings/${s.offeringId}/videos`, body)).statusCode,
    ).toBe(403);
    expect(
      (await s.outsider.client.post(`/offerings/${s.offeringId}/videos`, body)).statusCode,
    ).toBe(404);
    expect((await admin.post(`/offerings/${s.offeringId}/videos`, body)).statusCode).toBe(403); // no course.edit
    const mine = await createVideo(s.instructor.client, s.offeringId, 'a.mp4', 1000);
    const other = await s.outsider.client.get(`/offerings/${s.offeringId}/videos/${mine.video.id}`);
    expect(other.statusCode).toBe(404);
    // the college boundary
    expect(
      (await adminB.get(`/offerings/${s.offeringId}/videos/${mine.video.id}`)).statusCode,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('transcoding', () => {
  let s: Setup;
  const ready: Record<string, Json> = {};
  beforeAll(async () => {
    s = await setup();
    const go = async (key: string, name: string, bytes: Buffer) => {
      ready[key] = await uploadAndProcess(
        t,
        s.instructor.client,
        A.tenantId,
        s.offeringId,
        name,
        bytes,
      );
    };
    await go('landscape', 'landscape.mp4', CLIPS.landscape());
    await go('portrait', 'portrait.mp4', CLIPS.portrait());
    await go('noAudio', 'quiet.mp4', CLIPS.noAudio());
    await go('tiny', 'tiny.mp4', CLIPS.tiny());
    await go('mkv', 'lecture.mkv', CLIPS.mkv());
  }, 240_000);

  const names = (v: Json) => v.renditions.map((r: Json) => r.name);

  it('makes the whole ladder from a 720p source, with sizes, duration, poster and thumbnails', () => {
    const v = ready.landscape;
    expect(v.status).toBe('ready');
    expect(v.progress).toBe(100);
    expect(names(v)).toEqual(['360p', '480p', '720p']);
    expect(v.renditions.map((r: Json) => [r.width, r.height])).toEqual([
      [640, 360],
      [852, 480],
      [1280, 720],
    ]);
    expect(v.renditions.every((r: Json) => r.bytes > 0)).toBe(true);
    expect(v.durationMs).toBeGreaterThan(7000);
    expect(v.durationMs).toBeLessThan(9000);
    expect(v.hasAudio).toBe(true);
    expect(v.readyAt).not.toBeNull();
    const base = path.resolve(STORAGE, A.tenantId, v.id);
    expect(existsSync(path.join(base, 'poster.jpg'))).toBe(true);
    expect(readdirSync(path.join(base, 'thumbs'))).toHaveLength(5);
    const master = readFileSync(hlsDir(A.tenantId, v.id, 'master.m3u8'), 'utf8');
    expect(master).toMatch(/^360p\/index\.m3u8$/m); // plain relative URIs, forward slashes
    expect(master).toContain('RESOLUTION=1280x720');
    const variant = readFileSync(hlsDir(A.tenantId, v.id, '720p', 'index.m3u8'), 'utf8');
    expect(variant).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(variant).toContain('#EXT-X-TARGETDURATION:6');
    expect(variant).toMatch(/^seg_00000\.m4s$/m);
  });

  it('never upscales: a small source gets one rendition at its own size; a portrait one is capped by its short side', async () => {
    expect(names(ready.tiny)).toEqual(['240p']);
    expect(ready.tiny.renditions[0]).toMatchObject({ width: 320, height: 240 });
    expect(names(ready.portrait)).toEqual(['360p', '480p']); // 540 wide: no 720p step
    expect(ready.portrait.renditions.map((r: Json) => [r.width, r.height])).toEqual([
      [360, 640],
      [480, 852],
    ]);
    // and what is really inside the segments agrees
    for (const v of [ready.landscape, ready.portrait, ready.tiny]) {
      for (const r of v.renditions) {
        const dir = hlsDir(A.tenantId, v.id, r.name);
        const joined = writeTmp(
          Buffer.concat([
            readFileSync(path.join(dir, 'init.mp4')),
            readFileSync(path.join(dir, 'seg_00000.m4s')),
          ]),
          'mp4',
        );
        const stream = probeJson(joined, '-show_streams', '-select_streams', 'v:0').streams[0];
        expect([stream.width, stream.height]).toEqual([r.width, r.height]);
        expect(Math.min(stream.width, stream.height)).toBeLessThanOrEqual(
          Math.min(v.width, v.height),
        );
      }
    }
  });

  it('forces key frames at the same instants in every rendition (so a player can switch cleanly)', () => {
    const v = ready.landscape;
    const keyframes = (rendition: string) => {
      const dir = hlsDir(A.tenantId, v.id, rendition);
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.m4s'))
        .sort();
      const joined = writeTmp(
        Buffer.concat([
          readFileSync(path.join(dir, 'init.mp4')),
          ...files.map((f) => readFileSync(path.join(dir, f))),
        ]),
        'mp4',
      );
      const frames = probeJson(
        joined,
        '-select_streams',
        'v:0',
        '-show_entries',
        'frame=key_frame,pts_time',
      ).frames as Json[];
      return frames
        .filter((f) => f.key_frame === 1)
        .map((f) => Math.round(Number(f.pts_time) * 100) / 100);
    };
    const a = keyframes('360p');
    // two key frames, exactly one 6-second segment apart (the first sits at the start; x264 shifts every
    // presentation time by its frame delay)
    expect(a).toHaveLength(2);
    expect((a[1] ?? 0) - (a[0] ?? 0)).toBeCloseTo(6, 2);
    expect(a[0]).toBeLessThan(0.2);
    expect(keyframes('480p')).toEqual(a);
    expect(keyframes('720p')).toEqual(a);
  });

  it('handles a video without sound and a Matroska container', () => {
    expect(ready.noAudio.status).toBe('ready');
    expect(ready.noAudio.hasAudio).toBe(false);
    expect(names(ready.noAudio)).toEqual(['360p']);
    expect(ready.mkv.status).toBe('ready');
  });

  it('remembers the source facts and keeps the original for the retention period', async () => {
    const { rows } = await owner.query(
      'SELECT container, has_audio, source_meta, source_key, source_expires_at, source_deleted_at FROM lms.video_assets WHERE id = $1',
      [ready.landscape.id],
    );
    expect(rows[0]).toMatchObject({ container: 'mp4', has_audio: true, source_deleted_at: null });
    expect(rows[0].source_meta).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
    const days = (new Date(rows[0].source_expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    expect(ready.landscape.sourceKept).toBe(true);
  });

  it('marks a video failed with a reason a person can read: not a video, damaged, no video track', async () => {
    const c = s.instructor.client;
    const bogus = await uploadVideo(c, s.offeringId, 'fake.mp4', bogusMp4());
    expect((await processVideo(t, A.tenantId, bogus.id)).failed).toBe(1);
    const a = ok(await c.get(`/offerings/${s.offeringId}/videos/${bogus.id}`));
    expect(a.status).toBe('failed');
    expect(a.error.code).toMatch(/^(unsupported_format|corrupt)$/);
    expect(a.error.message.length).toBeGreaterThan(10);

    const cut = await uploadVideo(c, s.offeringId, 'cut.mp4', truncated());
    await processVideo(t, A.tenantId, cut.id);
    const b = ok(await c.get(`/offerings/${s.offeringId}/videos/${cut.id}`));
    expect(b.status).toBe('failed');
    expect(b.error.code).toBe('corrupt');

    const audioOnly = writeTmp(Buffer.alloc(0), 'mp4');
    execFileSync(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=d=2',
      '-c:a',
      'aac',
      audioOnly,
    ]);
    const none = await uploadVideo(c, s.offeringId, 'audio.mp4', readFileSync(audioOnly));
    await processVideo(t, A.tenantId, none.id);
    const d = ok(await c.get(`/offerings/${s.offeringId}/videos/${none.id}`));
    expect(d.error.code).toBe('no_video');
  }, 60_000);

  it('a video longer than the limit fails as too_long', async () => {
    const limited = makeApp({ env: { VIDEO_MAX_DURATION_SECONDS: '5' } });
    try {
      await limited.app.ready();
      const c = await loginAs(limited, A.host, A.adminEmail);
      void c;
      const instructor = await person(owner, limited, A, 'Short');
      const o = await newOffering(admin, (await newCourse(admin)).id, termId);
      ok(
        await admin.post(`/offerings/${o.id}/participants`, {
          userId: instructor.userId,
          participation: 'instructor',
        }),
      );
      const v = await uploadVideo(instructor.client, o.id, 'long.mp4', CLIPS.landscape()); // 8 s > 5 s
      await processVideo(limited, A.tenantId, v.id);
      const got = ok(await instructor.client.get(`/offerings/${o.id}/videos/${v.id}`));
      expect(got.status).toBe('failed');
      expect(got.error.code).toBe('too_long');
    } finally {
      await limited.close();
    }
  }, 60_000);

  it('a retry of a finished job does nothing (the output is idempotent)', async () => {
    const again = await processVideo(t, A.tenantId, ready.tiny.id);
    expect(again).toEqual({ skipped: 1 });
    const same = ok(
      await s.instructor.client.get(`/offerings/${s.offeringId}/videos/${ready.tiny.id}`),
    );
    expect(same.status).toBe('ready');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('playback', () => {
  let s: Setup;
  let video: Json;
  let item: Json;

  beforeAll(async () => {
    s = await setup();
    video = await uploadAndProcess(
      t,
      s.instructor.client,
      A.tenantId,
      s.offeringId,
      'lecture.mp4',
      CLIPS.tiny(),
    );
    item = await addItem(s, video.id);
  }, 120_000);

  const session = async (p: Person, itemId = item.id) =>
    ok(await p.client.post(`/offerings/${s.offeringId}/items/${itemId}/playback`));

  it('creates a video item only for a READY video of the offering', async () => {
    expect(item.kind).toBe('video');
    expect(item.video).toMatchObject({ id: video.id, status: 'ready' });
    const pending = await uploadVideo(s.instructor.client, s.offeringId, 'p.mp4', CLIPS.tiny());
    const bad = await s.instructor.client.post(
      `/offerings/${s.offeringId}/modules/${s.moduleId}/items`,
      {
        kind: 'video',
        title: 'Not yet',
        videoId: pending.id,
      },
    );
    expect(errorCode(bad)).toBe('invalid_video');
    // a video of ANOTHER offering cannot be attached
    const other = await newOffering(admin, (await newCourse(admin)).id, termId);
    ok(
      await admin.post(`/offerings/${other.id}/participants`, {
        userId: s.instructor.userId,
        participation: 'instructor',
      }),
    );
    const m2 = ok(await s.instructor.client.post(`/offerings/${other.id}/modules`, { title: 'M' }));
    const stolen = await s.instructor.client.post(`/offerings/${other.id}/modules/${m2.id}/items`, {
      kind: 'video',
      title: 'Taken',
      videoId: video.id,
    });
    expect(errorCode(stolen)).toBe('invalid_video');
  });

  it('a learner plays it: manifest, variant playlist, init and segment, with the right headers', async () => {
    const play = await session(s.learner);
    expect(play.manifestUrl).toMatch(
      new RegExp(`^/api/video/play/[^/]+/${video.id}/master\\.m3u8$`),
    );
    expect(play.durationMs).toBeGreaterThan(2000);
    expect(play.renditions).toEqual([{ name: '240p', height: 240 }]);
    expect(new Date(play.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const manifest = await s.learner.client.get(play.manifestUrl);
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(manifest.headers['referrer-policy']).toBe('no-referrer');
    expect(manifest.headers['x-content-type-options']).toBe('nosniff');
    expect(manifest.headers['accept-ranges']).toBe('bytes');
    expect(String(manifest.headers['cache-control'])).toContain('private');
    const base = play.manifestUrl.replace('master.m3u8', '');
    const variantPath = /^(.+\/index\.m3u8)$/m.exec(manifest.body)?.[1] ?? '';
    const variant = await s.learner.client.get(base + variantPath);
    expect(variant.statusCode).toBe(200);
    const dir = variantPath.replace('index.m3u8', '');
    const init = await s.learner.client.get(`${base}${dir}init.mp4`);
    expect(init.statusCode).toBe(200);
    expect(init.headers['content-type']).toBe('video/mp4');
    const segName = /^(seg_\d+\.m4s)$/m.exec(variant.body)?.[1] ?? '';
    const seg = await s.learner.client.get(`${base}${dir}${segName}`);
    expect(seg.statusCode).toBe(200);
    expect(seg.rawPayload.length).toBeGreaterThan(1000);
    const poster = await s.learner.client.get(play.posterUrl);
    expect(poster.headers['content-type']).toBe('image/jpeg');
  });

  it('answers Range requests with 206 and the right bytes, and 416 past the end', async () => {
    const play = await session(s.learner);
    const base = play.manifestUrl.replace('master.m3u8', '');
    const variant = (await s.learner.client.get(`${base}240p/index.m3u8`)).body;
    const seg = `${base}240p/${/^(seg_\d+\.m4s)$/m.exec(variant)?.[1]}`;
    const whole = (await s.learner.client.get(seg)).rawPayload;
    const part = await s.learner.client.get(seg, { headers: { range: 'bytes=100-499' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 100-499/${whole.length}`);
    expect(part.headers['content-length']).toBe('400');
    expect(part.rawPayload.equals(whole.subarray(100, 500))).toBe(true);
    const tail = await s.learner.client.get(seg, { headers: { range: 'bytes=-50' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.equals(whole.subarray(whole.length - 50))).toBe(true);
    const open = await s.learner.client.get(seg, {
      headers: { range: `bytes=${whole.length - 10}-` },
    });
    expect(open.rawPayload.length).toBe(10);
    const past = await s.learner.client.get(seg, {
      headers: { range: `bytes=${whole.length + 5}-` },
    });
    expect(past.statusCode).toBe(416);
    expect(past.headers['content-range']).toBe(`bytes */${whole.length}`);
  });

  it('refuses expired, tampered, foreign-user, cross-college and cross-asset tokens', async () => {
    const play = await session(s.learner);
    const [, , , , token, assetId] = play.manifestUrl.split('/');
    const url = (tok: string, asset = assetId, rest = 'master.m3u8') =>
      `/api/video/play/${tok}/${asset}/${rest}`;
    expect((await s.learner.client.get(url(token))).statusCode).toBe(200);

    // tampered: one character of the payload or of the signature changed
    const flip = (v: string, i: number) =>
      v.slice(0, i) + (v[i] === 'A' ? 'B' : 'A') + v.slice(i + 1);
    expect((await s.learner.client.get(url(flip(token, 5)))).statusCode).toBe(403);
    expect((await s.learner.client.get(url(flip(token, token.length - 3)))).statusCode).toBe(403);
    expect((await s.learner.client.get(url(`${token}x`))).statusCode).toBe(403);

    // expired: a genuine signature over a past expiry
    const signer = createPlaybackTokens(playbackKey({ storageSecret: SECRET }));
    const claims = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'));
    const expired = signer.sign({ ...claims, e: Math.floor(Date.now() / 1000) - 5 });
    expect((await s.learner.client.get(url(expired))).statusCode).toBe(403);
    const fresh = signer.sign({ ...claims, e: Math.floor(Date.now() / 1000) + 60 });
    expect((await s.learner.client.get(url(fresh))).statusCode).toBe(200); // the signer is right

    // another user of the same college with the learner's token
    expect((await s.instructor.client.get(url(token))).statusCode).toBe(403);
    // no session at all
    const anon = await t.app.inject({ method: 'GET', url: url(token), headers: { host: A.host } });
    expect(anon.statusCode).toBe(401);
    // another college: the token names its tenant and user
    expect((await adminB.get(url(token))).statusCode).toBe(403);

    // another asset than the one the token was issued for
    const other = await uploadAndProcess(
      t,
      s.instructor.client,
      A.tenantId,
      s.offeringId,
      'other.mp4',
      CLIPS.tiny(),
    );
    expect((await s.learner.client.get(url(token, other.id))).statusCode).toBe(403);
    const forged = signer.sign({ ...claims, a: other.id, e: Math.floor(Date.now() / 1000) + 60 });
    expect((await s.learner.client.get(url(forged, other.id))).statusCode).toBe(200); // genuine tokens work...
    expect((await s.learner.client.get(url(forged, assetId))).statusCode).toBe(403); // ...only for their own asset
  }, 60_000);

  it('serves only the allow-listed files of the asset: never the original, never a traversal', async () => {
    const play = await session(s.learner);
    const [, , , , token, assetId] = play.manifestUrl.split('/');
    const get = (rest: string) =>
      s.learner.client.get(`/api/video/play/${token}/${assetId}/${rest}`);
    for (const rest of [
      'source',
      'hls/master.m3u8',
      '../source',
      '240p/../../source',
      '%2e%2e/source',
      '240p/seg_1.m4s',
      'captions/xx.txt',
      'thumbs/x.jpg',
      '240p',
    ]) {
      const r = await get(rest);
      expect([403, 404, 400], rest).toContain(r.statusCode);
      expect(r.rawPayload.length < 2000, rest).toBe(true);
    }
    expect((await get('thumbs/t01.jpg')).statusCode).toBe(200);
  });

  it('follows the outline rules: hidden, unpublished-module, locked, non-participant, other college, not ready', async () => {
    // a non-participant of the offering and a user of another college learn nothing
    const noPart = await s.outsider.client.post(
      `/offerings/${s.offeringId}/items/${item.id}/playback`,
    );
    expect(noPart.statusCode).toBe(404);
    expect(errorCode(noPart)).toBe('offering_not_found');
    expect(
      (await adminB.post(`/offerings/${s.offeringId}/items/${item.id}/playback`)).statusCode,
    ).toBe(404);

    // an item that is not published yet: invisible to the learner, fine for the instructor
    const hidden = await addItem(s, video.id, { title: 'Draft', published: false });
    expect(
      (await s.learner.client.post(`/offerings/${s.offeringId}/items/${hidden.id}/playback`))
        .statusCode,
    ).toBe(404);
    expect(
      (await s.instructor.client.post(`/offerings/${s.offeringId}/items/${hidden.id}/playback`))
        .statusCode,
    ).toBe(200);

    // locked until a date: the learner gets the title and the date, no playback
    const locked = await addItem(s, video.id, {
      title: 'Later',
      availableFrom: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const outline = ok(await s.learner.client.get(`/offerings/${s.offeringId}/outline`));
    const row = outline.modules[0].items.find((i: Json) => i.id === locked.id);
    expect(row).toMatchObject({ locked: true, video: null, title: 'Later' });
    expect(
      (await s.learner.client.post(`/offerings/${s.offeringId}/items/${locked.id}/playback`))
        .statusCode,
    ).toBe(404);
    expect(
      (await s.instructor.client.post(`/offerings/${s.offeringId}/items/${locked.id}/playback`))
        .statusCode,
    ).toBe(200);

    // a module that is not published hides its items
    const m2 = ok(
      await s.instructor.client.post(`/offerings/${s.offeringId}/modules`, {
        title: 'Draft module',
      }),
    );
    const inDraft = ok(
      await s.instructor.client.post(`/offerings/${s.offeringId}/modules/${m2.id}/items`, {
        kind: 'video',
        title: 'x',
        videoId: video.id,
        published: true,
      }),
    );
    expect(
      (await s.learner.client.post(`/offerings/${s.offeringId}/items/${inDraft.id}/playback`))
        .statusCode,
    ).toBe(404);

    // a text item has no video
    const text = ok(
      await s.instructor.client.post(`/offerings/${s.offeringId}/modules/${s.moduleId}/items`, {
        kind: 'text',
        title: 't',
        body: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
        },
        published: true,
      }),
    );
    expect(
      (await s.learner.client.post(`/offerings/${s.offeringId}/items/${text.id}/playback`))
        .statusCode,
    ).toBe(404);
  });

  it('captions: an instructor adds WebVTT (validated, 5 languages), the player gets them through the session', async () => {
    const c = s.instructor.client;
    const vtt = 'WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n\n00:02.000 --> 00:03.000\nWorld\n';
    const en = ok(
      await c.post(`/offerings/${s.offeringId}/videos/${video.id}/captions`, {
        language: 'en',
        label: 'English',
        content: vtt,
      }),
    );
    expect(en).toMatchObject({ language: 'en', label: 'English' });
    // replacing a language keeps one row
    ok(
      await c.post(`/offerings/${s.offeringId}/videos/${video.id}/captions`, {
        language: 'en',
        label: 'English (CC)',
        content: vtt,
      }),
    );
    const bad = [
      'not vtt at all, just text',
      'WEBVTT\n\nno cues here',
      `WEBVTT\n\n00:00.000 --> 00:01.000\nbad \u0000 char`,
    ];
    for (const content of bad) {
      const r = await c.post(`/offerings/${s.offeringId}/videos/${video.id}/captions`, {
        language: 'fr',
        label: 'Français',
        content,
      });
      expect(errorCode(r), content).toBe('caption_invalid');
    }
    const big = `WEBVTT\n\n00:00.000 --> 00:01.000\n${'x'.repeat(262_200)}`;
    expect(
      (
        await c.post(`/offerings/${s.offeringId}/videos/${video.id}/captions`, {
          language: 'fr',
          label: 'F',
          content: big,
        })
      ).statusCode,
    ).toBe(400);
    for (const lang of ['hi', 'ta', 'te', 'ml']) {
      ok(
        await c.post(`/offerings/${s.offeringId}/videos/${video.id}/captions`, {
          language: lang,
          label: lang,
          content: vtt,
        }),
      );
    }
    const sixth = await c.post(`/offerings/${s.offeringId}/videos/${video.id}/captions`, {
      language: 'kn',
      label: 'Kannada',
      content: vtt,
    });
    expect(sixth.statusCode).toBe(409);
    expect(errorCode(sixth)).toBe('too_many_captions');
    // a learner cannot add captions
    expect(
      (
        await s.learner.client.post(`/offerings/${s.offeringId}/videos/${video.id}/captions`, {
          language: 'kn',
          label: 'K',
          content: vtt,
        })
      ).statusCode,
    ).toBe(403);

    const play = await session(s.learner);
    expect(play.captions.map((x: Json) => x.language).sort()).toEqual([
      'en',
      'hi',
      'ml',
      'ta',
      'te',
    ]);
    const file = await s.learner.client.get(
      play.captions.find((x: Json) => x.language === 'en').url,
    );
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('text/vtt; charset=utf-8');
    expect(file.body).toContain('Hello');
    ok(await c.delete(`/offerings/${s.offeringId}/videos/${video.id}/captions/hi`));
    expect(
      errorCode(await c.delete(`/offerings/${s.offeringId}/videos/${video.id}/captions/hi`)),
    ).toBe('caption_not_found');
  });

  it('a video in use cannot be deleted; an unused one can', async () => {
    const used = await s.instructor.client.delete(`/offerings/${s.offeringId}/videos/${video.id}`);
    expect(used.statusCode).toBe(409);
    expect(errorCode(used)).toBe('video_in_use');
    const spare = await uploadAndProcess(
      t,
      s.instructor.client,
      A.tenantId,
      s.offeringId,
      's.mp4',
      CLIPS.tiny(),
    );
    ok(await s.instructor.client.delete(`/offerings/${s.offeringId}/videos/${spare.id}`));
    expect(
      (await s.instructor.client.get(`/offerings/${s.offeringId}/videos/${spare.id}`)).statusCode,
    ).toBe(404);
    expect(existsSync(path.resolve(STORAGE, A.tenantId, spare.id))).toBe(false);
  });

  it('copying an offering shares the video (one asset, two items)', async () => {
    const target = await newOffering(admin, (await newCourse(admin)).id, termId);
    ok(
      await admin.post(`/offerings/${target.id}/participants`, {
        userId: s.instructor.userId,
        participation: 'instructor',
      }),
    );
    const copied = ok(
      await s.instructor.client.post(`/offerings/${target.id}/copy`, {
        sourceOfferingId: s.offeringId,
      }),
    );
    expect(copied.status).toBe('done');
    const { rows } = await owner.query(
      'SELECT count(DISTINCT video_asset_id)::int AS assets, count(*)::int AS items FROM lms.content_items WHERE video_asset_id = $1',
      [video.id],
    );
    expect(rows[0].assets).toBe(1);
    expect(rows[0].items).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('source retention and the purge of orphans', () => {
  it('sweeps scratch directories that a crashed worker left behind, and only old ones', async () => {
    const root = path.resolve(process.env.TEST_VIDEO_DIR ?? '.video-work-test');
    const stale = path.join(root, 'stale-job');
    const young = path.join(root, 'young-job');
    mkdirSync(stale, { recursive: true });
    mkdirSync(young, { recursive: true });
    writeFileSync(path.join(stale, 'x'), 'x');
    const old = new Date(Date.now() - 7 * 3_600_000);
    utimesSync(stale, old, old);
    await t.app.modules.video.service.sweepWorkDir();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(young)).toBe(true);
    rmSync(young, { recursive: true, force: true });
  });

  it('deletes the original after the retention period, but the video keeps playing', async () => {
    const s = await setup();
    const v = await uploadAndProcess(
      t,
      s.instructor.client,
      A.tenantId,
      s.offeringId,
      'r.mp4',
      CLIPS.tiny(),
    );
    await addItem(s, v.id);
    expect(existsSync(sourcePath(A.tenantId, v.id))).toBe(true);
    // not due yet: nothing happens
    await t.app.modules.video.service.expireSources();
    expect(existsSync(sourcePath(A.tenantId, v.id))).toBe(true);
    await owner.query(
      "UPDATE lms.video_assets SET source_expires_at = now() - interval '1 minute' WHERE id = $1",
      [v.id],
    );
    expect(await t.app.modules.video.service.expireSources()).toBeGreaterThanOrEqual(1);
    expect(existsSync(sourcePath(A.tenantId, v.id))).toBe(false);
    const after = ok(await s.instructor.client.get(`/offerings/${s.offeringId}/videos/${v.id}`));
    expect(after).toMatchObject({ status: 'ready', sourceKept: false });
    expect(existsSync(hlsDir(A.tenantId, v.id, 'master.m3u8'))).toBe(true);
  });

  it('purges unreferenced videos past the grace period (rows and files), never referenced ones', async () => {
    const s = await setup();
    const used = await uploadAndProcess(
      t,
      s.instructor.client,
      A.tenantId,
      s.offeringId,
      'u.mp4',
      CLIPS.tiny(),
    );
    await addItem(s, used.id);
    const orphan = await uploadAndProcess(
      t,
      s.instructor.client,
      A.tenantId,
      s.offeringId,
      'o.mp4',
      CLIPS.tiny(),
    );
    const abandoned = await createVideo(s.instructor.client, s.offeringId, 'a.mp4', 5000);
    const fresh = await uploadAndProcess(
      t,
      s.instructor.client,
      A.tenantId,
      s.offeringId,
      'f.mp4',
      CLIPS.tiny(),
    );
    const old = "now() - interval '3 days'";
    await owner.query(
      `UPDATE lms.video_assets SET created_at = ${old}, last_activity_at = ${old}, ready_at = CASE WHEN ready_at IS NULL THEN NULL ELSE ${old} END
        WHERE id = ANY($1)`,
      [[used.id, orphan.id, abandoned.video.id]],
    );
    await t.app.modules.video.service.purgeUnreferenced();
    const left = await owner.query('SELECT id FROM lms.video_assets WHERE id = ANY($1)', [
      [used.id, orphan.id, abandoned.video.id, fresh.id],
    ]);
    expect(left.rows.map((r) => r.id).sort()).toEqual([used.id, fresh.id].sort());
    expect(existsSync(path.resolve(STORAGE, A.tenantId, orphan.id))).toBe(false);
    expect(existsSync(path.resolve(STORAGE, A.tenantId, used.id))).toBe(true);
  });

  it('removing the item from the lesson restarts the grace period of its video', async () => {
    const s = await setup();
    const v = await uploadAndProcess(
      t,
      s.instructor.client,
      A.tenantId,
      s.offeringId,
      'g.mp4',
      CLIPS.tiny(),
    );
    const item = await addItem(s, v.id);
    await owner.query(
      "UPDATE lms.video_assets SET ready_at = now() - interval '3 days', last_activity_at = now() - interval '3 days' WHERE id = $1",
      [v.id],
    );
    ok(await s.instructor.client.delete(`/offerings/${s.offeringId}/items/${item.id}`));
    await t.app.modules.video.service.purgeUnreferenced();
    expect(
      (await owner.query('SELECT 1 FROM lms.video_assets WHERE id = $1', [v.id])).rowCount,
    ).toBe(1); // just un-referenced
  });
});

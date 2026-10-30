import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FfmpegAbortedError } from '../src/core/video';
import { makeApp, type TestApp } from './app';
import { loginAs, newCourse, newOffering, ok, person, structure } from './courses-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';
import { assertFfmpeg, clip, processVideo, uploadVideo } from './video-helpers';

// A worker that is shutting down (or lost its lease) must not leave ffmpeg running: the job is stopped, nothing
// is published, the video stays "processing", and the retry builds everything from scratch and succeeds. Runs
// alone (SERIAL_FILES): it counts the ffmpeg processes of the machine.

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;

beforeAll(async () => {
  assertFfmpeg();
  owner = testOwnerPool();
  t = makeApp();
  A = await createAuthFixture(owner, 'vs-a');
  await t.app.ready();
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

/** How many ffmpeg processes run on this machine right now. */
function ffmpegProcesses(): number {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'tasklist',
        ['/FI', 'IMAGENAME eq ffmpeg.exe', '/FO', 'CSV', '/NH'],
        { encoding: 'utf8' },
      );
      return out.split('\n').filter((l) => l.toLowerCase().includes('ffmpeg.exe')).length;
    }
    return execFileSync('pgrep', ['-c', '-x', 'ffmpeg'], { encoding: 'utf8' }).trim() === ''
      ? 0
      : Number(execFileSync('pgrep', ['-c', '-x', 'ffmpeg'], { encoding: 'utf8' }));
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
}

describe('shutting down in the middle of a transcode (slow)', () => {
  it('kills ffmpeg, publishes nothing, keeps the video "processing", and the retry succeeds from scratch', async () => {
    const admin = await loginAs(t, A.host, A.adminEmail);
    const s = await structure(admin);
    const o = await newOffering(admin, (await newCourse(admin)).id, s.termId);
    const instructor = await person(owner, t, A, 'Instructor');
    ok(
      await admin.post(`/offerings/${o.id}/participants`, {
        userId: instructor.userId,
        participation: 'instructor',
      }),
    );
    const long = clip('long', { size: '1280x720', seconds: 30 });
    const v = await uploadVideo(instructor.client, o.id, 'long.mp4', long);
    const workRoot = path.resolve(process.env.TEST_VIDEO_DIR ?? '.video-work-test');
    // a clean scratch directory to count in (an earlier crashed run may have left one)
    rmSync(workRoot, { recursive: true, force: true });
    const before = ffmpegProcesses();

    // start, wait until ffmpeg is really encoding (the progress shows in the database), then stop the job
    const stop = new AbortController();
    const running = processVideo(t, A.tenantId, v.id, { signal: stop.signal });
    const settled = running.then(
      () => 'finished',
      (e: unknown) => e,
    );
    let progress = 0;
    for (let i = 0; i < 300 && progress === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const { rows } = await owner.query('SELECT progress FROM lms.video_assets WHERE id = $1', [
        v.id,
      ]);
      progress = rows[0]?.progress ?? 0;
    }
    expect(progress, 'the encode never started').toBeGreaterThan(0);
    expect(ffmpegProcesses()).toBeGreaterThan(before);
    const t0 = Date.now();
    stop.abort();
    const outcome = await settled;
    expect(outcome).toBeInstanceOf(FfmpegAbortedError);
    expect(Date.now() - t0).toBeLessThan(5000); // it does not wait for the encode to finish

    // ffmpeg is gone, its directory is gone, nothing was published, the video is still waiting for a worker
    for (let i = 0; i < 30 && ffmpegProcesses() > before; i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(ffmpegProcesses()).toBe(before);
    expect(existsSync(workRoot) ? readdirSync(workRoot).length : 0).toBe(0);
    expect(
      existsSync(
        path.resolve(process.env.TEST_STORAGE_DIR ?? '.storage-test', A.tenantId, v.id, 'hls'),
      ),
    ).toBe(false);
    const mid = ok(await instructor.client.get(`/offerings/${o.id}/videos/${v.id}`));
    expect(mid.status).toBe('processing');
    expect(mid.error).toBeNull();

    // the queue runs the job again (attempt 2): everything is rebuilt
    await processVideo(t, A.tenantId, v.id, { attempt: 2 });
    const done = ok(await instructor.client.get(`/offerings/${o.id}/videos/${v.id}`));
    expect(done).toMatchObject({ status: 'ready', progress: 100 });
    expect(done.renditions.map((r: { name: string }) => r.name)).toEqual(['360p', '480p', '720p']);
    expect(ffmpegProcesses()).toBe(before);
  });
});

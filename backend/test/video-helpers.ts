import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import { newId } from '../src/core/uuid';
import type { TestApp } from './app';
import type { TestClient } from './client';
import { errorCode, type Json, ok } from './courses-helpers';

// Shared helpers for the Step 7 (video) tests: tiny generated clips (no copyrighted material), the resumable
// upload protocol, and a direct call of the transcoding job.

export const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

/** Fails loudly (not silently skipping) when ffmpeg is missing: the video tests are part of the suite. */
export function assertFfmpeg(): void {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
    execFileSync(FFPROBE, ['-version'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      'ffmpeg / ffprobe not found on PATH (the video tests generate their own clips). Install them: see docs/adr/0015-video.md',
    );
  }
}

const FIXTURES = path.join(os.tmpdir(), 'lms-video-fixtures');

interface ClipSpec {
  size: string;
  seconds: number;
  fps?: number;
  audio?: boolean;
  /** extension / container */
  ext?: 'mp4' | 'mkv' | 'webm' | 'mov';
}

/** Generates (once per machine) a small test clip: test pattern + sine tone. */
export function clip(name: string, spec: ClipSpec): Buffer {
  mkdirSync(FIXTURES, { recursive: true });
  const ext = spec.ext ?? 'mp4';
  const file = path.join(FIXTURES, `${name}-${spec.size}-${spec.seconds}-${spec.fps ?? 25}.${ext}`);
  if (!existsSync(file)) {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=s=${spec.size}:r=${spec.fps ?? 25}:d=${spec.seconds}`,
    ];
    if (spec.audio !== false) args.push('-f', 'lavfi', '-i', `sine=f=440:d=${spec.seconds}`);
    if (ext === 'webm') args.push('-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libvorbis');
    else args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac');
    if (spec.audio === false) args.push('-an');
    args.push('-shortest', file);
    execFileSync(FFMPEG, args, { stdio: 'pipe' });
  }
  return readFileSync(file);
}

export const CLIPS = {
  /** 1280x720: gets the whole ladder (360p, 480p, 720p) */
  landscape: () => clip('landscape', { size: '1280x720', seconds: 8 }),
  /** 540x960: portrait, capped by its SHORT side */
  portrait: () => clip('portrait', { size: '540x960', seconds: 7 }),
  noAudio: () => clip('noaudio', { size: '640x360', seconds: 4, audio: false }),
  /** smaller than the lowest step: must not be upscaled */
  tiny: () => clip('tiny', { size: '320x240', seconds: 3 }),
  mkv: () => clip('mkv', { size: '320x240', seconds: 3, ext: 'mkv' }),
};

/** A video cut off in the middle: the index at the end of an MP4 is missing. */
export const truncated = (): Buffer => CLIPS.landscape().subarray(0, 20_000);

/** An MP4-looking header followed by rubbish: passes the first-bytes check, fails ffprobe. */
export function bogusMp4(): Buffer {
  const head = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  return Buffer.concat([
    head,
    Buffer.alloc(12),
    Buffer.from('this is definitely not a video '.repeat(40)),
  ]);
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** ffprobe JSON of a file. */
export function probeJson(file: string, ...extra: string[]): Json {
  return JSON.parse(
    execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', ...extra, file], {
      encoding: 'utf8',
    }),
  );
}

// ---------------------------------------------------------------- the upload protocol
export const PATCH_HEADERS = { 'content-type': 'application/offset+octet-stream' };

export interface Uploaded {
  video: Json;
  chunkBytes: number;
}

/** Creates the upload record and returns it with the chunk size. */
export async function createVideo(
  client: TestClient,
  offeringId: string,
  fileName: string,
  size: number,
): Promise<Uploaded> {
  const r = ok(await client.post(`/offerings/${offeringId}/videos`, { fileName, size }));
  expect(r.upload.protocol).toBe('chunked');
  return { video: r.video, chunkBytes: r.upload.chunkBytes };
}

export function patchChunk(
  client: TestClient,
  offeringId: string,
  videoId: string,
  offset: number,
  body: Buffer,
  headers: Record<string, string> = {},
) {
  return client.request('PATCH', `/offerings/${offeringId}/videos/${videoId}/upload`, {
    body,
    headers: {
      ...PATCH_HEADERS,
      'upload-offset': String(offset),
      'content-length': String(body.length),
      ...headers,
    },
  });
}

/** Sends the file in chunks from `from`; returns the final offset. */
export async function sendChunks(
  client: TestClient,
  offeringId: string,
  videoId: string,
  bytes: Buffer,
  chunkBytes: number,
  from = 0,
): Promise<number> {
  let offset = from;
  while (offset < bytes.length) {
    const part = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
    const res = await patchChunk(client, offeringId, videoId, offset, part);
    expect(res.statusCode, res.body).toBe(200);
    offset = res.json().uploadOffset;
  }
  return offset;
}

/** Upload (chunked) + complete. The job is NOT run: see `process`. */
export async function uploadVideo(
  client: TestClient,
  offeringId: string,
  fileName: string,
  bytes: Buffer,
): Promise<Json> {
  const { video, chunkBytes } = await createVideo(client, offeringId, fileName, bytes.length);
  await sendChunks(client, offeringId, video.id, bytes, chunkBytes);
  const done = await client.post(`/offerings/${offeringId}/videos/${video.id}/complete`);
  expect(done.statusCode, done.body).toBe(202);
  return done.json();
}

/** Runs the `video` job for an asset right here (the worker does exactly this). */
export async function processVideo(
  t: TestApp,
  tenantId: string,
  assetId: string,
  over: Partial<{ attempt: number; maxAttempts: number; signal: AbortSignal }> = {},
) {
  try {
    return await t.app.modules.video.service.process(tenantId, assetId, {
      jobId: newId(),
      attempt: over.attempt ?? 1,
      maxAttempts: over.maxAttempts ?? 3,
      signal: over.signal ?? new AbortController().signal,
    });
  } catch (err) {
    // show what ffmpeg said: the message alone ("exited with code 1") does not help anyone
    const stderr = (err as { stderr?: string }).stderr;
    if (stderr)
      (err as Error).message += `
${stderr}`;
    throw err;
  }
}

/** Upload + process in one go; returns the video as the API shows it afterwards. */
export async function uploadAndProcess(
  t: TestApp,
  client: TestClient,
  tenantId: string,
  offeringId: string,
  fileName: string,
  bytes: Buffer,
): Promise<Json> {
  const v = await uploadVideo(client, offeringId, fileName, bytes);
  await processVideo(t, tenantId, v.id);
  return ok(await client.get(`/offerings/${offeringId}/videos/${v.id}`));
}

export const tmpName = (ext: string) => path.join(os.tmpdir(), `lms-${randomUUID()}.${ext}`);
export const writeTmp = (b: Buffer, ext: string) => {
  const f = tmpName(ext);
  writeFileSync(f, b);
  return f;
};

export { errorCode };

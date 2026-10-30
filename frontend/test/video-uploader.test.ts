import type { UploadOffset, VideoAsset } from '@lms/backend/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  backoffMs,
  resumeStore,
  type UploaderApi,
  uploadVideoFile,
} from '../src/features/video/uploader';
import { ApiError } from '../src/shared/api/client';

// The resumable upload, against a fake server that remembers how many bytes it holds: after any failure the
// uploader asks where the bytes end and carries on from there.

const CHUNK = 100;
const VIDEO_ID = '11000000-0000-7000-8000-000000000001';
const video = (status: VideoAsset['status'] = 'uploading'): VideoAsset => ({
  id: VIDEO_ID,
  offeringId: '22000000-0000-7000-8000-000000000001',
  fileName: 'lecture.mp4',
  status,
  progress: 0,
  uploadOffset: 0,
  size: 1050,
  durationMs: null,
  width: null,
  height: null,
  hasAudio: null,
  renditions: [],
  captions: [],
  error: null,
  sourceKept: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  readyAt: null,
});

const file = (size: number) => {
  const bytes = new Uint8Array(size).map((_, i) => i % 251);
  return {
    name: 'lecture.mp4',
    size,
    slice: (a: number, b: number) => new Blob([bytes.slice(a, b)]),
    bytes,
  };
};

/** A server that stores bytes; `fail(call, offset)` may make a chunk fail, and `partial` stores a cut-off part. */
function fakeServer(
  opts: { fail?: (call: number, offset: number) => ApiError | null; partial?: number } = {},
) {
  let stored = 0;
  let calls = 0;
  const log: string[] = [];
  const api: UploaderApi = {
    createVideo: vi.fn(async (_o: string, _n: string, size: number) => {
      log.push('create');
      return {
        video: { ...video(), size },
        upload: { protocol: 'chunked' as const, chunkBytes: CHUNK, maxBytes: 1e9 },
      };
    }),
    getUploadOffset: vi.fn(async (): Promise<UploadOffset> => {
      log.push(`offset=${stored}`);
      return { uploadOffset: stored, size: 1050, status: 'uploading' };
    }),
    patchChunk: vi.fn(async (_o: string, _v: string, offset: number, chunk: Blob) => {
      calls++;
      log.push(`patch@${offset}`);
      if (offset !== stored) throw new ApiError(409, 'upload_offset_mismatch', 'wrong offset');
      const failure = opts.fail?.(calls, offset);
      if (failure) {
        stored += opts.partial ?? 0; // part of the chunk arrived before the connection died
        throw failure;
      }
      stored += chunk.size;
      return { uploadOffset: stored, size: 1050, status: 'uploading' as const };
    }),
    completeVideo: vi.fn(async () => {
      log.push(`complete(stored=${stored})`);
      return video('processing');
    }),
  };
  return { api, log, stored: () => stored };
}
const noSleep = vi.fn(async () => {});

describe('uploadVideoFile', () => {
  it('sends the file in chunks, reports progress, and asks for processing at the end', async () => {
    const s = fakeServer();
    const progress: number[] = [];
    const r = await uploadVideoFile({
      offeringId: 'o',
      file: file(1050),
      api: s.api,
      onProgress: (f) => progress.push(f),
      sleep: noSleep,
    });
    expect(r.status).toBe('processing');
    expect(s.stored()).toBe(1050);
    expect(s.api.patchChunk).toHaveBeenCalledTimes(11); // 10 x 100 + 50
    expect(s.log.at(-1)).toBe('complete(stored=1050)');
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress); // never goes back
  });

  it('resumes from the offset the server reports after a dropped connection, instead of restarting', async () => {
    // the 4th chunk dies after 30 of its 100 bytes reached the server
    const s = fakeServer({
      fail: (call) => (call === 4 ? new ApiError(0, 'network_error', 'dropped') : null),
      partial: 30,
    });
    await uploadVideoFile({
      offeringId: 'o',
      file: file(1050),
      api: s.api,
      onProgress: () => {},
      sleep: noSleep,
    });
    expect(s.stored()).toBe(1050);
    // after the failure it asked where the bytes end (330), and the next chunk started there
    const i = s.log.indexOf('patch@300');
    expect(s.log.slice(i, i + 3)).toEqual(['patch@300', 'offset=330', 'patch@330']);
    expect(s.log.filter((l) => l === 'create')).toHaveLength(1); // no new upload was started
    expect(noSleep).toHaveBeenCalled(); // it waited before retrying
  });

  it('recovers from a chunk that does not start where the bytes end (409), and from a busy server', async () => {
    const s = fakeServer({
      fail: (call) =>
        call === 2
          ? new ApiError(503, 'unavailable', 'x')
          : call === 3
            ? new ApiError(409, 'upload_busy', 'x')
            : null,
    });
    await uploadVideoFile({
      offeringId: 'o',
      file: file(1050),
      api: s.api,
      onProgress: () => {},
      sleep: noSleep,
    });
    expect(s.stored()).toBe(1050);
  });

  it('does not retry what retrying cannot fix: a refused file, a forbidden caller', async () => {
    for (const err of [
      new ApiError(413, 'video_too_large', 'big'),
      new ApiError(403, 'forbidden', 'no'),
      new ApiError(400, 'video_content_mismatch', 'x'),
    ]) {
      const s = fakeServer({ fail: () => err });
      await expect(
        uploadVideoFile({
          offeringId: 'o',
          file: file(1050),
          api: s.api,
          onProgress: () => {},
          sleep: noSleep,
        }),
      ).rejects.toBe(err);
      expect(s.api.patchChunk).toHaveBeenCalledTimes(1);
      expect(s.api.completeVideo).not.toHaveBeenCalled();
    }
  });

  it('gives up after the allowed number of consecutive failures', async () => {
    const s = fakeServer({ fail: () => new ApiError(0, 'network_error', 'down') });
    await expect(
      uploadVideoFile({
        offeringId: 'o',
        file: file(1050),
        api: s.api,
        onProgress: () => {},
        sleep: noSleep,
        maxRetries: 3,
      }),
    ).rejects.toMatchObject({ code: 'network_error' });
    expect(s.api.patchChunk).toHaveBeenCalledTimes(4); // the first try and 3 retries
  });

  it('a success resets the count of consecutive failures', async () => {
    // every other chunk fails once: 11 chunks, still fine with maxRetries 1
    let n = 0;
    const s = fakeServer({
      fail: () => (++n % 2 === 1 ? new ApiError(0, 'network_error', 'blip') : null),
    });
    await uploadVideoFile({
      offeringId: 'o',
      file: file(1050),
      api: s.api,
      onProgress: () => {},
      sleep: noSleep,
      maxRetries: 1,
    });
    expect(s.stored()).toBe(1050);
  });

  it('continues an interrupted upload of the same file from the server offset', async () => {
    const s = fakeServer();
    // 400 bytes are already there from an earlier attempt
    await s.api.patchChunk('o', VIDEO_ID, 0, new Blob([new Uint8Array(100)]));
    await s.api.patchChunk('o', VIDEO_ID, 100, new Blob([new Uint8Array(100)]));
    await s.api.patchChunk('o', VIDEO_ID, 200, new Blob([new Uint8Array(100)]));
    await s.api.patchChunk('o', VIDEO_ID, 300, new Blob([new Uint8Array(100)]));
    vi.mocked(s.api.patchChunk).mockClear();
    const progress: number[] = [];
    await uploadVideoFile({
      offeringId: 'o',
      file: file(1050),
      resume: { videoId: VIDEO_ID, chunkBytes: CHUNK },
      api: s.api,
      onProgress: (f) => progress.push(f),
      sleep: noSleep,
    });
    expect(s.api.createVideo).not.toHaveBeenCalled();
    expect(vi.mocked(s.api.patchChunk).mock.calls[0]?.[2]).toBe(400); // the first byte it sent
    expect(progress[0]).toBeCloseTo(400 / 1050);
    expect(s.stored()).toBe(1050);
  });

  it('stops at once when cancelled, and leaves the upload where it is (it can be resumed)', async () => {
    const s = fakeServer();
    const ctrl = new AbortController();
    const done = uploadVideoFile({
      offeringId: 'o',
      file: file(1050),
      api: s.api,
      signal: ctrl.signal,
      sleep: noSleep,
      onProgress: (f) => {
        if (f >= 0.3) ctrl.abort();
      },
    });
    await expect(done).rejects.toMatchObject({ code: 'aborted' });
    expect(s.api.completeVideo).not.toHaveBeenCalled();
    expect(s.stored()).toBeLessThan(1050);
  });

  it('tells the caller about the new video as soon as it exists (so it can be remembered)', async () => {
    const s = fakeServer();
    const created = vi.fn();
    await uploadVideoFile({
      offeringId: 'o',
      file: file(300),
      api: s.api,
      onProgress: () => {},
      onCreated: created,
      sleep: noSleep,
    });
    expect(created).toHaveBeenCalledWith(
      { videoId: VIDEO_ID, chunkBytes: CHUNK },
      expect.objectContaining({ id: VIDEO_ID }),
    );
  });
});

describe('the pause between retries', () => {
  it('grows and is capped', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffMs)).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });
});

describe('remembering an interrupted upload', () => {
  it('keeps it for its offering only, and forgets it when asked', () => {
    localStorage.clear();
    const info = {
      videoId: VIDEO_ID,
      chunkBytes: CHUNK,
      offeringId: 'o1',
      fileName: 'a.mp4',
      size: 5,
    };
    resumeStore.save(info);
    expect(resumeStore.load('o1')).toEqual(info);
    expect(resumeStore.load('o2')).toBeNull();
    resumeStore.clear();
    expect(resumeStore.load('o1')).toBeNull();
  });
  it('works without storage (a private window)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() =>
      resumeStore.save({
        videoId: VIDEO_ID,
        chunkBytes: 1,
        offeringId: 'o',
        fileName: 'a',
        size: 1,
      }),
    ).not.toThrow();
    spy.mockRestore();
  });
});

import type { UploadOffset, VideoAsset } from '@lms/backend/contracts';
import { ApiError } from '../../shared/api/client';
import * as defaultApi from './video.api';

// The resumable upload of a video. The file is sent in chunks; the server stores the bytes and says where they
// end, so a dropped connection resumes from there instead of restarting. After any failure the uploader asks the
// server for the real offset (the storage is the truth, a chunk may have been cut off half way) and carries on.

export interface UploaderApi {
  createVideo: typeof defaultApi.createVideo;
  getUploadOffset: typeof defaultApi.getUploadOffset;
  patchChunk: typeof defaultApi.patchChunk;
  completeVideo: typeof defaultApi.completeVideo;
}

export interface UploadResume {
  videoId: string;
  chunkBytes: number;
}

export interface UploadOptions {
  offeringId: string;
  file: { name: string; size: number; slice(start: number, end: number): Blob };
  /** continue an interrupted upload of the SAME file */
  resume?: UploadResume | undefined;
  /** 0..1 of the bytes stored on the server */
  onProgress: (fraction: number) => void;
  /** called as soon as the video exists (so the caller can remember it for a later resume) */
  onCreated?: ((resume: UploadResume, video: VideoAsset) => void) | undefined;
  signal?: AbortSignal | undefined;
  /** consecutive failures before giving up (default 6) */
  maxRetries?: number | undefined;
  api?: UploaderApi | undefined;
  /** injectable for tests */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export const backoffMs = (failures: number): number => Math.min(8000, 500 * 2 ** (failures - 1));

const abortable = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new ApiError(0, 'aborted', 'The upload was cancelled.'));
      },
      { once: true },
    );
  });

/** A failure worth retrying: no answer at all, an overloaded server, or a chunk that did not start where the bytes end. */
const retryable = (err: unknown): boolean =>
  err instanceof ApiError &&
  err.code !== 'aborted' &&
  (err.status === 0 ||
    err.status >= 500 ||
    err.status === 429 ||
    err.code === 'upload_offset_mismatch' ||
    err.code === 'upload_busy');

/** Uploads the file and asks the server to process it; resolves with the video (status `processing`). */
export async function uploadVideoFile(opts: UploadOptions): Promise<VideoAsset> {
  const api = opts.api ?? defaultApi;
  const sleep = opts.sleep ?? ((ms: number) => abortable(ms, opts.signal));
  const maxRetries = opts.maxRetries ?? 6;
  const { file, offeringId, signal } = opts;

  let videoId: string;
  let chunkBytes: number;
  let offset = 0;
  if (opts.resume) {
    ({ videoId, chunkBytes } = opts.resume);
    offset = (await api.getUploadOffset(offeringId, videoId, signal)).uploadOffset;
  } else {
    const created = await api.createVideo(offeringId, file.name, file.size);
    videoId = created.video.id;
    chunkBytes = created.upload.chunkBytes;
    opts.onCreated?.({ videoId, chunkBytes }, created.video);
  }
  opts.onProgress(file.size === 0 ? 0 : offset / file.size);

  let failures = 0;
  while (offset < file.size) {
    if (signal?.aborted) throw new ApiError(0, 'aborted', 'The upload was cancelled.');
    const end = Math.min(offset + chunkBytes, file.size);
    try {
      const r: UploadOffset = await api.patchChunk(
        offeringId,
        videoId,
        offset,
        file.slice(offset, end),
        signal,
      );
      offset = r.uploadOffset;
      failures = 0;
      opts.onProgress(offset / file.size);
    } catch (err) {
      if (!retryable(err) || ++failures > maxRetries) throw err;
      await sleep(backoffMs(failures));
      // where do the stored bytes really end? (the failed chunk may have arrived whole, in part, or not at all)
      try {
        offset = (await api.getUploadOffset(offeringId, videoId, signal)).uploadOffset;
      } catch (again) {
        if (!retryable(again) || ++failures > maxRetries) throw again;
        await sleep(backoffMs(failures));
      }
    }
  }
  return api.completeVideo(offeringId, videoId);
}

// ---------------------------------------------------------------- remembering an interrupted upload
const KEY = 'lms.video.upload';
interface Remembered extends UploadResume {
  offeringId: string;
  fileName: string;
  size: number;
}

/** The browser cannot keep the File across a reload, but it can remember WHICH upload to continue. */
export const resumeStore = {
  save(info: Remembered): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(info));
    } catch {
      // storage blocked: the upload simply cannot be resumed after a reload
    }
  },
  load(offeringId: string): Remembered | null {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Remembered | null;
      return v && v.offeringId === offeringId ? v : null;
    } catch {
      return null;
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // nothing to do
    }
  },
};

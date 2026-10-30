import type {
  OkResponse,
  PlaybackSession,
  UploadOffset,
  VideoAsset,
  VideoCaption,
  VideoUpload,
} from '@lms/backend/contracts';
import { API_BASE, ApiError, api } from '../../shared/api/client';

// Typed with the backend contracts (step 7). The chunk upload is the one call that is not JSON: it sends raw bytes.

export const videoKeys = {
  video: (offeringId: string, videoId: string) =>
    ['offerings', 'video', offeringId, videoId] as const,
  playback: (offeringId: string, itemId: string) =>
    ['offerings', 'playback', offeringId, itemId] as const,
};

export const createVideo = (offeringId: string, fileName: string, size: number) =>
  api<VideoUpload>(`/offerings/${offeringId}/videos`, { method: 'POST', body: { fileName, size } });
export const getVideo = (offeringId: string, videoId: string, signal?: AbortSignal) =>
  api<VideoAsset>(`/offerings/${offeringId}/videos/${videoId}`, { signal });
export const getUploadOffset = (offeringId: string, videoId: string, signal?: AbortSignal) =>
  api<UploadOffset>(`/offerings/${offeringId}/videos/${videoId}/upload`, { signal });
export const completeVideo = (offeringId: string, videoId: string) =>
  api<VideoAsset>(`/offerings/${offeringId}/videos/${videoId}/complete`, { method: 'POST' });
export const deleteVideo = (offeringId: string, videoId: string) =>
  api<OkResponse>(`/offerings/${offeringId}/videos/${videoId}`, { method: 'DELETE' });

export const addCaption = (
  offeringId: string,
  videoId: string,
  body: { language: string; label: string; content: string },
) =>
  api<VideoCaption>(`/offerings/${offeringId}/videos/${videoId}/captions`, {
    method: 'POST',
    body,
  });
export const deleteCaption = (offeringId: string, videoId: string, language: string) =>
  api<OkResponse>(`/offerings/${offeringId}/videos/${videoId}/captions/${language}`, {
    method: 'DELETE',
  });

/** A short-lived playback session for the video of an item (manifest URL, poster, captions). */
export const playbackSession = (offeringId: string, itemId: string, signal?: AbortSignal) =>
  api<PlaybackSession>(`/offerings/${offeringId}/items/${itemId}/playback`, {
    method: 'POST',
    signal,
  });

/** Sends one chunk of the file (raw bytes) starting at `offset`; answers where the stored bytes end now. */
export async function patchChunk(
  offeringId: string,
  videoId: string,
  offset: number,
  chunk: Blob,
  signal?: AbortSignal,
): Promise<UploadOffset> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/offerings/${offeringId}/videos/${videoId}/upload`, {
      method: 'PATCH',
      credentials: 'same-origin',
      signal: signal ?? null,
      headers: {
        'content-type': 'application/offset+octet-stream',
        'upload-offset': String(offset),
        // the same CSRF header as every other mutation
        'x-requested-with': 'lms',
      },
      body: chunk,
    });
  } catch {
    if (signal?.aborted) throw new ApiError(0, 'aborted', 'The upload was cancelled.');
    throw new ApiError(0, 'network_error', 'The connection was interrupted.', null);
  }
  if (res.ok) return (await res.json()) as UploadOffset;
  let code = 'upload_failed';
  let message = 'The upload failed.';
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    // not JSON: keep the generic message
  }
  throw new ApiError(res.status, code, message);
}

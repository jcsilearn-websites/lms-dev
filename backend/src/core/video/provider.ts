import type { Readable } from 'node:stream';

// The video provider abstraction works at the level of "ingest + deliver", because dedicated video services
// (Bunny Stream, Cloudflare Stream, Mux) and Google's Transcoder API + GCS + Cloud CDN all handle both: take an
// upload, produce renditions, and hand out a short-lived way to play them.
//
// LOCAL (this file's LocalVideoProvider) is for development and CI ONLY: the browser PUTs chunks to this API, the
// worker transcodes with ffmpeg and this API serves the HLS files with signed tokens. It is refused when
// NODE_ENV=production; ffmpeg is never shipped in a production image (ADR 0015).

export type VideoProviderKind = 'local' | 'gcp' | 'bunny';

export interface AssetRef {
  tenantId: string;
  assetId: string;
}

/** How the browser must send the bytes. */
export type UploadInstructions =
  | {
      /** our own chunked protocol: PATCH chunks of at most `chunkBytes` to the API, resuming from the offset */
      protocol: 'chunked';
      chunkBytes: number;
    }
  | {
      /** the provider hosts the upload (a GCS resumable session, a tus endpoint): send the file there */
      protocol: 'resumable-url';
      url: string;
      headers: Record<string, string>;
    };

export interface ProviderStatus {
  state: 'processing' | 'ready' | 'failed';
  /** 0..100 */
  progress?: number;
  error?: { code: string; message: string };
}

export interface PlaybackSession {
  manifestUrl: string;
  posterUrl: string | null;
  /** the URL every playback file hangs below (captions are `<baseUrl>/captions/<language>.vtt`) */
  baseUrl: string;
  expiresAt: Date;
}

export interface VideoProvider {
  readonly kind: VideoProviderKind;
  /**
   * true: this system's worker transcodes (the `video.process` job); false: the provider does and its progress
   * is read with `getStatus`.
   */
  readonly processesInWorker: boolean;

  createUpload(input: AssetRef & { fileName: string; size: number }): Promise<UploadInstructions>;
  /** The chunked protocol only: appends/overwrites bytes at `offset`; returns how many were written. */
  appendChunk?(
    input: AssetRef & { offset: number; body: Readable; maxBytes: number },
  ): Promise<number>;
  /** Processing status as the provider knows it; null when the provider keeps no state (the local one). */
  getStatus(ref: AssetRef): Promise<ProviderStatus | null>;
  /** A short-lived playback session bound to the user and tenant. */
  createPlayback(input: AssetRef & { userId: string; ttlSeconds: number }): PlaybackSession;
  /** Deletes everything stored for the asset. */
  deleteAsset(ref: AssetRef): Promise<void>;
}

/** A provider that is not built yet: every call is a clear 503 so a misconfigured deployment is loud. */
export class VideoUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoUnavailableError';
  }
}

/** The key of the uploaded original in object storage (built from two UUIDs only, never from user text). */
export const sourceKey = (r: AssetRef) => `${r.tenantId}/${r.assetId}/source`;
/** Everything the asset owns in object storage. */
export const assetPrefix = (r: AssetRef) => `${r.tenantId}/${r.assetId}`;

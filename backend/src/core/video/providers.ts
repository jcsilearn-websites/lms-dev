import type { LocalStorage } from '../storage';
import {
  type AssetRef,
  assetPrefix,
  type PlaybackSession,
  type ProviderStatus,
  sourceKey,
  type UploadInstructions,
  type VideoProvider,
  VideoUnavailableError,
} from './provider';
import type { PlaybackTokens } from './tokens';

/**
 * Development / CI provider: uploads go through the local StorageProvider, the worker transcodes with ffmpeg and
 * this API serves the HLS tree under `/api/video/play/<token>/...` (see the controller in the video module).
 */
export function createLocalVideoProvider(opts: {
  storage: LocalStorage;
  tokens: PlaybackTokens;
  chunkBytes: number;
  now?: () => number;
}): VideoProvider {
  const now = opts.now ?? (() => Date.now());
  return {
    kind: 'local',
    processesInWorker: true,

    async createUpload(): Promise<UploadInstructions> {
      return { protocol: 'chunked', chunkBytes: opts.chunkBytes };
    },

    appendChunk({ offset, body, maxBytes, ...ref }) {
      return opts.storage.writeAt(sourceKey(ref), offset, body, maxBytes);
    },

    async getStatus(): Promise<ProviderStatus | null> {
      return null; // the worker records its progress in video_assets
    },

    createPlayback({ tenantId, assetId, userId, ttlSeconds }): PlaybackSession {
      const e = Math.floor(now() / 1000) + ttlSeconds;
      const token = opts.tokens.sign({ t: tenantId, a: assetId, u: userId, e });
      const base = `/api/video/play/${token}/${assetId}`;
      return {
        manifestUrl: `${base}/master.m3u8`,
        posterUrl: `${base}/poster.jpg`,
        baseUrl: base,
        expiresAt: new Date(e * 1000),
      };
    },

    async deleteAsset(ref: AssetRef): Promise<void> {
      await opts.storage.removePrefix(assetPrefix(ref));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Stubs. Production uses one of these. GCP and the external service are a LATER step (GCP is out of scope for now):
// every call fails with a clear 503 so a misconfigured deployment is loud, not silent.

function unavailable(what: string): never {
  throw new VideoUnavailableError(`The ${what} video provider is not implemented yet`);
}

/**
 * Google Cloud: Transcoder API (jobs from the uploaded GCS object, HLS/fMP4 output to a bucket), Cloud CDN signed
 * URLs / signed cookies for delivery. TODO(gcp step):
 *  - createUpload: a GCS resumable-upload session URL (protocol 'resumable-url');
 *  - a Pub/Sub notification of the finished upload starts the Transcoder job; job status via getStatus / a webhook;
 *  - createPlayback: a signed cookie scoped to the asset's prefix (the CDN validates it, this API is not on the
 *    segment path), a short-lived manifest URL;
 *  - deleteAsset: delete the objects below the asset prefix.
 */
export function createGcpVideoProvider(): VideoProvider {
  return {
    kind: 'gcp',
    processesInWorker: false,
    createUpload: async () => unavailable('GCP'),
    getStatus: async () => unavailable('GCP'),
    createPlayback: () => unavailable('GCP'),
    deleteAsset: async () => unavailable('GCP'),
  };
}

/**
 * A video service (Bunny Stream shown; Cloudflare Stream / Mux have the same shape). TODO(provider step):
 *  - createUpload: create the video via the API, return its tus endpoint + signature (protocol 'resumable-url');
 *  - getStatus: the video's encode status (or a webhook); progress from the service;
 *  - createPlayback: the service's token-authenticated embed / HLS URL (signed with the library key);
 *  - deleteAsset: delete the video.
 */
export function createBunnyVideoProvider(): VideoProvider {
  return {
    kind: 'bunny',
    processesInWorker: false,
    createUpload: async () => unavailable('Bunny Stream'),
    getStatus: async () => unavailable('Bunny Stream'),
    createPlayback: () => unavailable('Bunny Stream'),
    deleteAsset: async () => unavailable('Bunny Stream'),
  };
}

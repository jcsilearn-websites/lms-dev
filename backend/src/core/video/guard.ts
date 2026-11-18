import { OperationTimeoutError, withTimeout } from '../resilience';
import { type VideoProvider, VideoUnavailableError } from './provider';

/**
 * The video provider behind a deadline (step 14a): `createUpload`, `getStatus` and `deleteAsset` are calls to an EXTERNAL service
 * in production (GCP Transcoder, a video SaaS) and get `timeoutMs`; a deadline becomes VideoUnavailableError (a clean 503), like
 * every other "the provider is not available". `appendChunk` streams the client's body and is not timed here. The local
 * development provider's ffmpeg has its own hard timeout (core/video/ffmpeg.ts).
 */
export function guardVideoProvider(
  provider: VideoProvider,
  opts: { timeoutMs: number },
): VideoProvider {
  const timed = <T>(name: string, call: () => Promise<T>): Promise<T> =>
    withTimeout(`video ${name}`, opts.timeoutMs, () => call()).catch((err: unknown) => {
      if (err instanceof OperationTimeoutError) {
        throw new VideoUnavailableError(`The ${provider.kind} video provider timed out`);
      }
      throw err;
    });
  const guarded: VideoProvider = {
    kind: provider.kind,
    processesInWorker: provider.processesInWorker,
    createUpload: (input) => timed('createUpload', () => provider.createUpload(input)),
    getStatus: (ref) => timed('getStatus', () => provider.getStatus(ref)),
    deleteAsset: (ref) => timed('deleteAsset', () => provider.deleteAsset(ref)),
    createPlayback: (input) => provider.createPlayback(input),
  };
  if (provider.appendChunk)
    guarded.appendChunk = (input) => provider.appendChunk?.(input) as Promise<number>;
  return guarded;
}

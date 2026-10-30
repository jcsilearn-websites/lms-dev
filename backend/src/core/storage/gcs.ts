import { type StorageProvider, StorageUnavailableError } from './storage';

// Google Cloud Storage driver: NOT built yet (GCP is a later step). The contract it will fulfil is the
// StorageProvider interface: V4 signed PUT URLs with a content-type and size condition, V4 signed GET URLs
// with response-content-disposition, object metadata for size / md5 (instead of re-reading the bytes),
// and a malware scan before a file may become `ready` (see the TODO in CLAUDE.md). Until then every call
// fails with a clear 503 so a misconfigured deployment is loud, not silent.
export function createGcsStorage(_opts: { bucket: string }): StorageProvider {
  const unavailable = (): never => {
    throw new StorageUnavailableError('The GCS storage driver is not implemented yet');
  };
  return {
    driver: 'gcs',
    createUploadTarget: unavailable,
    createDownloadTarget: unavailable,
    inspect: async () => unavailable(),
    remove: async () => unavailable(),
  };
}

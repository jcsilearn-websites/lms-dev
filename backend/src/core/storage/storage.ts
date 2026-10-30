// The storage abstraction: the application never touches a bucket or a directory directly. Uploads and
// downloads go through short-lived signed URLs (the browser talks to the storage, not through the API's
// business code), exactly how Google Cloud Storage signed URLs work; the local driver imitates that with
// HMAC-signed URLs served by this API (development only).

export interface UploadTarget {
  /** Where the browser PUTs the bytes. */
  url: string;
  method: 'PUT';
  /** Headers the upload must carry (besides the ones the browser sets itself). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface DownloadTarget {
  url: string;
  expiresAt: Date;
}

/** What the confirm step learns about an uploaded object by reading it. */
export interface StoredObject {
  size: number;
  /** The first bytes (up to 8 KB) for the magic-number check. */
  head: Buffer;
  sha256: string;
}

export interface StorageProvider {
  readonly driver: 'local' | 'gcs';
  /** A signed URL to upload ONE object under `key`, at most `maxBytes`, with exactly this content type. */
  createUploadTarget(input: { key: string; contentType: string; maxBytes: number }): UploadTarget;
  /** A signed URL that downloads the object with the given name and disposition. */
  createDownloadTarget(input: {
    key: string;
    fileName: string;
    contentType: string;
    inline: boolean;
  }): DownloadTarget;
  /** Reads the object (size, head, sha256); null when nothing was uploaded under the key. */
  inspect(key: string): Promise<StoredObject | null>;
  /** Deletes objects; a missing object is not an error. */
  remove(keys: readonly string[]): Promise<void>;
}

export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

/** The key of a file's bytes: `<tenant id>/<file id>`. Built from two UUIDs only, never from user text. */
export function storageKey(tenantId: string, fileId: string): string {
  return `${tenantId}/${fileId}`;
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DownloadTarget, StorageProvider, StoredObject, UploadTarget } from './storage';

// Development storage: bytes in a directory, signed expiring URLs served by this API's /storage routes.
// Mirrors GCS: a URL is a capability (HMAC over method, key, expiry and limits), it carries no session.

/** `<tenant uuid>/<file uuid>`: the only shape of a key the local driver accepts (no traversal possible). */
const KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Keys of the video objects: `<tenant uuid>/<asset uuid>` and up to three levels below it
 * (`hls/720p/seg_00001.m4s`). Every segment starts with a letter or digit, so `..` can never appear.
 */
const UUID_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OBJECT_KEY = new RegExp(`^${UUID_PART}/${UUID_PART}(/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){1,3}$`);
const PREFIX_KEY = new RegExp(`^${UUID_PART}/${UUID_PART}(/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,2}$`);

export interface ObjectRange {
  stream: Readable;
  /** total size of the object */
  size: number;
  /** first and last byte served (inclusive) */
  start: number;
  end: number;
}

export interface UrlClaims {
  /** object key */
  k: string;
  /** put | get */
  a: 'put' | 'get';
  /** expiry, epoch seconds */
  e: number;
  /** put: size limit */
  m?: number;
  /** put: the content type the upload must declare; get: the type to serve */
  c?: string;
  /** get: the Content-Disposition value */
  d?: string;
}

export class TooLargeError extends Error {
  constructor() {
    super('The upload is larger than allowed');
    this.name = 'TooLargeError';
  }
}

export interface LocalStorage extends StorageProvider {
  readonly driver: 'local';
  /** Checks signature and expiry of a URL token; null for anything else (the caller answers 403). */
  verify(token: string, action: 'put' | 'get'): UrlClaims | null;
  /** Streams an upload into the object, never keeping more than `maxBytes`; throws TooLargeError. */
  write(key: string, body: Readable, maxBytes: number): Promise<number>;
  /** The object as a stream with its size; null when it does not exist. */
  read(key: string): Promise<{ stream: Readable; size: number } | null>;

  // ---- object-level operations used by the video provider (keys: see OBJECT_KEY)
  /**
   * Writes `body` into the object starting at byte `offset` (creating it when `offset` is 0), never more than
   * `maxBytes`; returns the number of bytes written. This is the resumable upload: bytes past a failed chunk
   * are simply overwritten by the retry.
   */
  writeAt(key: string, offset: number, body: Readable, maxBytes: number): Promise<number>;
  /** Bytes `start..end` (inclusive; default all) of an object; null when it does not exist. */
  readRange(key: string, range?: { start: number; end: number }): Promise<ObjectRange | null>;
  /** The size of an object; null when it does not exist. */
  sizeOf(key: string): Promise<number | null>;
  /** Stores a file from the local disk under `key` (replacing it). */
  putFile(key: string, localPath: string): Promise<void>;
  /** Atomically replaces everything below `prefix` with the contents of the local directory. */
  replacePrefix(prefix: string, localDir: string): Promise<void>;
  /** Deletes everything below `prefix` (a missing prefix is not an error). */
  removePrefix(prefix: string): Promise<void>;
  /** The absolute path of an object (for ffmpeg, which reads files). Local driver only. */
  pathOf(key: string): string;
}

export function createLocalStorage(opts: {
  dir: string;
  secret: string;
  ttlSeconds: number;
  /** Public path the storage routes are mounted at (the SPA calls it on its own origin). */
  basePath?: string;
  now?: () => number;
}): LocalStorage {
  const root = path.resolve(opts.dir);
  const base = opts.basePath ?? '/api/storage';
  const now = opts.now ?? (() => Date.now());

  const fileOf = (key: string): string => {
    if (!KEY.test(key)) throw new Error('invalid storage key');
    const file = path.resolve(root, key);
    if (!file.startsWith(root + path.sep)) throw new Error('invalid storage key');
    return file;
  };
  const objectFile = (key: string): string => {
    if (!OBJECT_KEY.test(key)) throw new Error('invalid storage key');
    const file = path.resolve(root, key);
    if (!file.startsWith(root + path.sep)) throw new Error('invalid storage key');
    return file;
  };
  const prefixDir = (prefix: string): string => {
    if (!PREFIX_KEY.test(prefix)) throw new Error('invalid storage prefix');
    const dir = path.resolve(root, prefix);
    if (!dir.startsWith(root + path.sep)) throw new Error('invalid storage prefix');
    return dir;
  };
  const sign = (payload: string) =>
    createHmac('sha256', opts.secret).update(payload).digest('base64url');
  const token = (claims: UrlClaims): string => {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${payload}.${sign(payload)}`;
  };
  const expiry = () => Math.floor(now() / 1000) + opts.ttlSeconds;

  return {
    driver: 'local',

    createUploadTarget({ key, contentType, maxBytes }): UploadTarget {
      fileOf(key);
      const e = expiry();
      return {
        url: `${base}/upload/${token({ k: key, a: 'put', e, m: maxBytes, c: contentType })}`,
        method: 'PUT',
        headers: { 'content-type': contentType },
        expiresAt: new Date(e * 1000),
      };
    },

    createDownloadTarget({ key, fileName, contentType, inline }): DownloadTarget {
      fileOf(key);
      const e = expiry();
      const d = JSON.stringify({ n: fileName, i: inline });
      return {
        url: `${base}/download/${token({ k: key, a: 'get', e, c: contentType, d })}`,
        expiresAt: new Date(e * 1000),
      };
    },

    verify(raw, action): UrlClaims | null {
      const [payload, mac, extra] = raw.split('.');
      if (!payload || !mac || extra !== undefined) return null;
      const expected = Buffer.from(sign(payload));
      const given = Buffer.from(mac);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as UrlClaims;
        if (claims.a !== action || typeof claims.e !== 'number' || claims.e * 1000 < now())
          return null;
        if (typeof claims.k !== 'string' || !KEY.test(claims.k)) return null;
        return claims;
      } catch {
        return null;
      }
    },

    async write(key, body, maxBytes): Promise<number> {
      const file = fileOf(key);
      await mkdir(path.dirname(file), { recursive: true });
      const part = `${file}.part-${randomBytes(6).toString('hex')}`;
      let size = 0;
      const counter = async function* (src: Readable) {
        for await (const chunk of src) {
          size += (chunk as Buffer).length;
          if (size > maxBytes) throw new TooLargeError();
          yield chunk;
        }
      };
      try {
        await pipeline(body, counter, createWriteStream(part, { flags: 'wx' }));
        await rename(part, file);
        return size;
      } catch (err) {
        await rm(part, { force: true });
        throw err;
      }
    },

    async read(key) {
      const file = fileOf(key);
      try {
        const s = await stat(file);
        return { stream: createReadStream(file), size: s.size };
      } catch {
        return null;
      }
    },

    async inspect(key): Promise<StoredObject | null> {
      const file = fileOf(key);
      let size: number;
      try {
        size = (await stat(file)).size;
      } catch {
        return null;
      }
      const hash = createHash('sha256');
      const handle = await open(file, 'r');
      try {
        const head = Buffer.alloc(Math.min(8192, size));
        await handle.read(head, 0, head.length, 0);
        for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
          hash.update(chunk as Buffer);
        }
        return { size, head, sha256: hash.digest('hex') };
      } finally {
        await handle.close();
      }
    },

    async remove(keys): Promise<void> {
      // a file key (<tenant>/<file>) or a video object key (<tenant>/<asset>/...)
      for (const key of keys)
        await rm(KEY.test(key) ? fileOf(key) : objectFile(key), { force: true });
    },

    async writeAt(key, offset, body, maxBytes): Promise<number> {
      const file = objectFile(key);
      await mkdir(path.dirname(file), { recursive: true });
      let size = 0;
      const counter = async function* (src: Readable) {
        for await (const chunk of src) {
          size += (chunk as Buffer).length;
          if (size > maxBytes) throw new TooLargeError();
          yield chunk;
        }
      };
      // 'r+' keeps what is already there; a first chunk creates the file
      const exists = await stat(file).then(
        () => true,
        () => false,
      );
      await pipeline(
        body,
        counter,
        createWriteStream(file, { flags: exists ? 'r+' : 'w', start: offset }),
      );
      return size;
    },

    async readRange(key, range) {
      const file = objectFile(key);
      let total: number;
      try {
        total = (await stat(file)).size;
      } catch {
        return null;
      }
      const start = range?.start ?? 0;
      const end = Math.min(range?.end ?? total - 1, total - 1);
      if (total === 0 || start > end || start < 0) return null;
      return { stream: createReadStream(file, { start, end }), size: total, start, end };
    },

    async sizeOf(key) {
      try {
        return (await stat(objectFile(key))).size;
      } catch {
        return null;
      }
    },

    async putFile(key, localPath) {
      const file = objectFile(key);
      await mkdir(path.dirname(file), { recursive: true });
      await cp(localPath, file, { force: true });
    },

    async replacePrefix(prefix, localDir) {
      const dir = prefixDir(prefix);
      await mkdir(path.dirname(dir), { recursive: true });
      const old = `${dir}.old-${randomBytes(6).toString('hex')}`;
      const had = await rename(dir, old).then(
        () => true,
        () => false,
      );
      try {
        await rename(localDir, dir);
      } catch {
        // another volume: copy instead of renaming
        await cp(localDir, dir, { recursive: true, force: true });
        await rm(localDir, { recursive: true, force: true });
      }
      if (had) await rm(old, { recursive: true, force: true });
    },

    async removePrefix(prefix) {
      await rm(prefixDir(prefix), { recursive: true, force: true });
    },

    pathOf(key) {
      return objectFile(key);
    },
  };
}

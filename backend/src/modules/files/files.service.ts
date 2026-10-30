import { can, type Permission, participationsGranting } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { ForbiddenError } from '../../core/errors';
import {
  classify,
  cleanFileName,
  kindForName,
  type StorageProvider,
  StorageUnavailableError,
  storageKey,
} from '../../core/storage';
import { newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import { type AccessSpec, assertAccess, OfferingArchivedError } from '../courses';
import {
  FileContentMismatchError,
  FileNotFoundError,
  FileSizeMismatchError,
  FileTooLargeError,
  FileTypeNotAllowedError,
  StorageUnavailable,
  UploadMissingError,
} from './files.errors';
import type { FilesRepository, Row } from './files.repository';

export type { Row } from './files.repository';

export interface FilesConfig {
  maxBytes: number;
  purgeGraceHours: number;
}

export function createFilesService(deps: {
  db: Pick<Database, 'withTenant' | 'withoutTenant'>;
  filesRepo: FilesRepository;
  storage: StorageProvider;
  config: FilesConfig;
}) {
  const { db, filesRepo, storage, config } = deps;

  const spec = (ctx: RequestContext, offeringId: string, permission: Permission): AccessSpec => {
    if (!ctx.tenantId) throw new ForbiddenError();
    return {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      offeringId,
      viewAll: can(ctx, 'course.read'),
      accountAllowed: can(ctx, permission),
      allowedBy: participationsGranting(permission),
    };
  };

  /** Storage failures (driver not implemented / unreachable) become a clear 503. */
  async function storageCall<T>(fn: () => Promise<T> | T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StorageUnavailableError) throw new StorageUnavailable();
      throw err;
    }
  }

  return {
    /**
     * Step 1 of an upload: records a PENDING file for an offering the caller may edit and returns a signed
     * URL to PUT the bytes to. The type is decided here from the extension (and re-checked against the bytes
     * at confirm); the size is limited here and again by the storage.
     */
    async requestUpload(
      ctx: RequestContext,
      offeringId: string,
      input: { name: string; size: number },
    ) {
      const name = cleanFileName(input.name);
      const kind = kindForName(name);
      if (!name || !kind) throw new FileTypeNotAllowedError();
      if (input.size > config.maxBytes) throw new FileTooLargeError(config.maxBytes);
      const a = spec(ctx, offeringId, 'course.edit');
      const id = newId();
      const key = storageKey(a.tenantId, id);
      const r = await db.withTenant(a.tenantId, (tx) =>
        filesRepo.createPending(
          tx,
          a,
          { id, storageKey: key, name, contentType: kind.mime, size: input.size },
          ctx.userId,
        ),
      );
      const acc = assertAccess(r.acc);
      if (!r.row) throw new OfferingArchivedError();
      void acc;
      const upload = await storageCall(() =>
        storage.createUploadTarget({ key, contentType: kind.mime, maxBytes: config.maxBytes }),
      );
      return { row: r.row, upload, maxBytes: config.maxBytes };
    },

    /**
     * Step 2: the browser says it finished. The bytes are read (size, first bytes, SHA-256) with NO database
     * transaction open, the type is checked against the content, and only then the row becomes `ready`.
     * Two short transactions: 7 round trips with the session lookup (a documented exception to the budget of 4).
     */
    async confirm(ctx: RequestContext, fileId: string): Promise<Row> {
      if (!ctx.tenantId) throw new ForbiddenError();
      const tenantId = ctx.tenantId;
      const file = await db.withTenant(tenantId, (tx) =>
        filesRepo.findOwn(tx, tenantId, fileId, ctx.userId),
      );
      if (!file) throw new FileNotFoundError();
      if (file.status === 'ready') return file;
      const key = file.storage_key as string;
      const stored = await storageCall(() => storage.inspect(key));
      if (!stored) throw new UploadMissingError();
      const reject = async (err: Error): Promise<never> => {
        await storageCall(() => storage.remove([key]));
        throw err;
      };
      if (stored.size > config.maxBytes) return reject(new FileTooLargeError(config.maxBytes));
      if (stored.size !== Number(file.declared_size)) return reject(new FileSizeMismatchError());
      const kind = classify(file.original_name as string, stored.head);
      if (!kind) return reject(new FileContentMismatchError());
      const ready = await db.withTenant(tenantId, (tx) =>
        filesRepo.markReady(tx, tenantId, fileId, {
          size: stored.size,
          sha256: stored.sha256,
          contentType: kind.mime,
        }),
      );
      // lost a race with a second confirm of the same file: it is ready now
      return (
        ready ??
        (await db.withTenant(tenantId, (tx) =>
          filesRepo.findOwn(tx, tenantId, fileId, ctx.userId),
        )) ??
        file
      );
    },

    /** A short-lived signed download URL for a READY file (the caller has already been authorized for it). */
    async downloadTarget(file: {
      storage_key: string;
      original_name: string;
      content_type: string;
    }) {
      const kind = kindForName(file.original_name);
      const inline = kind?.inline === true && kind.mime === file.content_type;
      const target = await storageCall(() =>
        storage.createDownloadTarget({
          key: file.storage_key,
          fileName: file.original_name,
          contentType: file.content_type,
          inline,
        }),
      );
      return { ...target, fileName: file.original_name, inline };
    },

    /** Worker: deletes files nothing references (past their grace period), rows first and then the objects. */
    async purgeUnreferenced(limit = 500): Promise<number> {
      const keys = await db.withoutTenant((conn) =>
        filesRepo.purge(conn, config.purgeGraceHours, limit),
      );
      if (keys.length > 0) await storageCall(() => storage.remove(keys));
      return keys.length;
    },
  };
}
export type FilesService = ReturnType<typeof createFilesService>;

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { DataExport, DataExportDownload } from '../../contracts';
import type { RequestContext } from '../../core/context';
import type { JobContext } from '../../core/handlers';
import type { StorageProvider } from '../../core/storage';
import { storageKey } from '../../core/storage/storage';
import { type ZipEntry, zipStream } from '../../core/zip';
import type { Database } from '../../db/client';
import type { JobsService } from '../jobs';
import { buildArchive, countsOf } from './privacy.archive';
import {
  ExportExpiredError,
  ExportLimitError,
  ExportNotFoundError,
  ExportNotReadyError,
  NotAnActiveMemberError,
} from './privacy.errors';
import type { ExportRow, PrivacyRepository } from './privacy.repository';

/** An archive is kept this long after it was prepared. */
export const EXPORT_TTL_SECONDS = 7 * 24 * 3600;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const LIST_LIMIT = 10;
const EXPIRE_BATCH = 200;
const MAX_EXPIRE_BATCHES = 50;

export interface PrivacyConfig {
  /** the largest archive that is stored (a runaway is a failure, not a full disk) */
  maxBytes: number;
}

const toDto = (r: ExportRow): DataExport => ({ ...r });

/**
 * Data protection: "download my data". The member re-enters their password (the sign-in lockout counts a wrong one), the request,
 * its job and its audit row are ONE database call; the worker builds the archive from ONE collected document and stores it; the
 * member downloads it through a short-lived signed link (audited) for 7 days; an expiry job deletes it.
 */
export function createPrivacyService(deps: {
  db: Pick<Database, 'withTenant' | 'withoutTenant'>;
  privacyRepo: PrivacyRepository;
  passwords: { confirm(ctx: RequestContext, password: string): Promise<void> };
  storage: StorageProvider;
  jobsService: Pick<JobsService, 'notifyEnqueued'>;
  config?: Partial<PrivacyConfig>;
  /** the clock; tests pass explicit instants */
  now?: () => Date;
}) {
  const { db, privacyRepo, passwords, storage, jobsService } = deps;
  const maxBytes = deps.config?.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = deps.now ?? (() => new Date());

  const member = (ctx: RequestContext): { tenantId: string; userId: string } => {
    if (!ctx.tenantId || ctx.isPlatformAdmin) throw new NotAnActiveMemberError();
    return { tenantId: ctx.tenantId, userId: ctx.userId };
  };

  return {
    /** POST /me/data-exports */
    async requestExport(
      ctx: RequestContext,
      input: { password: string },
    ): Promise<{ export: DataExport; alreadyInProgress: boolean }> {
      const { tenantId, userId } = member(ctx);
      await passwords.confirm(ctx, input.password);
      const r = await db.withoutTenant((exec) =>
        privacyRepo.request(exec, { tenantId, userId, ip: ctx.ip, now: now() }),
      );
      if (r.result === 'not_a_member') throw new NotAnActiveMemberError();
      if (r.result === 'too_many') throw new ExportLimitError();
      const row: DataExport = {
        id: r.id as string,
        status: r.status as DataExport['status'],
        requestedAt: new Date(r.requestedAt as string).toISOString(),
        readyAt: null,
        expiresAt: null,
        sizeBytes: null,
        counts: null,
      };
      if (r.result === 'ok') jobsService.notifyEnqueued('privacy.export'); // committed: wake an in-process worker
      return { export: row, alreadyInProgress: r.result === 'in_progress' };
    },

    /** GET /me/data-exports: the caller's own rows (the policy shows no one else's) */
    async listExports(ctx: RequestContext): Promise<{ items: DataExport[] }> {
      const { tenantId, userId } = member(ctx);
      const rows = await db.withTenant(tenantId, (tx) => privacyRepo.list(tx, LIST_LIMIT), {
        userId,
      });
      return { items: rows.map(toDto) };
    },

    /** GET /me/data-exports/:id/download: owner only, ready and not expired; audited */
    async downloadLink(ctx: RequestContext, id: string): Promise<DataExportDownload> {
      const { tenantId, userId } = member(ctx);
      const r = await db.withoutTenant((exec) =>
        privacyRepo.download(exec, { tenantId, userId, id, now: now(), ip: ctx.ip }),
      );
      if (r.result === 'not_found') throw new ExportNotFoundError();
      if (r.result === 'not_ready') throw new ExportNotReadyError();
      if (r.result === 'expired') throw new ExportExpiredError();
      const target = storage.createDownloadTarget({
        key: r.key as string,
        fileName: 'my-data.zip',
        contentType: 'application/zip',
        inline: false,
      });
      return {
        url: target.url,
        expiresAt: target.expiresAt.toISOString(),
        fileName: 'my-data.zip',
      };
    },

    /**
     * The worker: build and store the archive of one claimed export. A transient failure is retried by the queue (the key is
     * fixed, a retry replaces the object); the LAST attempt, or an archive that is too large, marks the export failed.
     */
    async buildExport(
      tenantId: string,
      exportId: string,
      job: Pick<JobContext, 'attempt' | 'maxAttempts'>,
    ): Promise<{ built: number }> {
      const started = now();
      const claim = await db.withoutTenant((exec) =>
        privacyRepo.claim(exec, tenantId, exportId, started),
      );
      if (claim.result !== 'ok') return { built: 0 };
      try {
        const doc = await db.withoutTenant((exec) => privacyRepo.collect(exec, tenantId, exportId));
        const files = buildArchive(doc, started);
        const entries: ZipEntry[] = files.map((f) => {
          const bytes = Buffer.from(f.content, 'utf8');
          return {
            name: f.name,
            size: bytes.length,
            modified: started,
            open: async () => Readable.from([bytes]),
          };
        });
        const hash = createHash('sha256');
        const zip = zipStream(entries);
        const tapped = Readable.from(
          (async function* () {
            for await (const chunk of zip) {
              hash.update(chunk as Buffer);
              yield chunk;
            }
          })(),
        );
        const key = storageKey(tenantId, exportId);
        const size = await storage.put(key, tapped, maxBytes);
        await db.withoutTenant((exec) =>
          privacyRepo.finish(exec, {
            tenantId,
            id: exportId,
            key,
            size,
            sha256: hash.digest('hex'),
            counts: countsOf(doc),
            now: now(),
            ttlSeconds: EXPORT_TTL_SECONDS,
          }),
        );
        return { built: 1 };
      } catch (err) {
        const tooLarge = (err as Error)?.name === 'TooLargeError';
        if (tooLarge || job.attempt >= job.maxAttempts) {
          await db.withoutTenant((exec) =>
            privacyRepo.fail(
              exec,
              tenantId,
              exportId,
              tooLarge ? 'archive too large' : 'build failed',
            ),
          );
          if (tooLarge) return { built: 0 };
        }
        throw err;
      }
    },

    /** scheduled: delete the archives that expired (or failed after storing), then clear their keys */
    async expireExports(): Promise<number> {
      let total = 0;
      for (let i = 0; i < MAX_EXPIRE_BATCHES; i++) {
        const due = await db.withoutTenant((exec) =>
          privacyRepo.expireList(exec, now(), EXPIRE_BATCH),
        );
        if (due.length === 0) break;
        await storage.remove(due.map((d) => d.key));
        total += await db.withoutTenant((exec) =>
          privacyRepo.purged(
            exec,
            due.map((d) => d.id),
          ),
        );
        if (due.length < EXPIRE_BATCH) break;
      }
      return total;
    },
  };
}
export type PrivacyService = ReturnType<typeof createPrivacyService>;

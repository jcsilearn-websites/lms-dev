import type { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import { can } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { ForbiddenError } from '../../core/errors';
import type { JobContext } from '../../core/handlers';
import { buildPage, normalizePage, type Page } from '../../core/pagination';
import { newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import { pgConstraint, pgErrorCode } from '../../db/pg-errors';
import type { JobsService } from '../jobs';
import {
  type ColumnSpec,
  IMPORT_KINDS,
  type ImportKind,
  mapHeader,
  type ParsedRow,
  reportHeader,
  reportLine,
  templateCsv,
  toParsedRow,
} from './imports.csv';
import {
  HasInvalidRowsError,
  headerProblemError,
  ImportInProgressError,
  ImportNotConfirmableError,
  ImportNotFoundError,
  InvalidImportFileError,
  NothingToImportError,
  PayloadTooLargeError,
  RowsPurgedError,
} from './imports.errors';
import type { ImportsRepository, Row } from './imports.repository';

export type { Row } from './imports.repository';

export interface ImportsConfig {
  maxBytes: number;
  maxRows: number;
  /** rows applied per transaction by the worker */
  batchSize: number;
  /** staged rows (names, emails) are deleted this many days after the import finished */
  retentionDays: number;
  /** invite emails are spread out to at most this many per second */
  inviteRatePerSecond: number;
  /** rows deleted per purge statement */
  purgeBatchSize: number;
}

export const DEFAULT_IMPORTS_CONFIG: ImportsConfig = {
  maxBytes: 5 * 1024 * 1024,
  maxRows: 10_000,
  batchSize: 500,
  retentionDays: 7,
  inviteRatePerSecond: 5,
  purgeBatchSize: 1000,
};

/** Rows staged per statement while the file is parsed. */
const STAGE_BATCH = 1000;
const REPORT_PAGE = 1000;
const MAX_PURGE_BATCHES = 100;

export interface UploadInput {
  kind: string;
  fileName: string;
  /** the file as it arrives (multipart stream): parsed on the fly, never buffered whole */
  stream: Readable;
}

export function createImportsService(deps: {
  db: Pick<Database, 'withTenant' | 'withoutTenant'>;
  importsRepo: ImportsRepository;
  jobsService: Pick<JobsService, 'notifyEnqueued' | 'config'>;
  config?: Partial<ImportsConfig>;
}) {
  const { db, importsRepo, jobsService } = deps;
  const config: ImportsConfig = { ...DEFAULT_IMPORTS_CONFIG, ...deps.config };

  function tenantFor(ctx: RequestContext): string {
    if (!ctx.tenantId || !can(ctx, 'import.run')) throw new ForbiddenError();
    return ctx.tenantId;
  }
  const stamp = (actorUserId: string | null) => ({ id: newId(), actorUserId });

  function cleanFileName(name: string): string {
    // a name for display and audit only: no path, no control characters
    const base = name.split(/[\\/]/).pop() ?? '';
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return (cleaned || 'upload.csv').slice(0, 255);
  }

  /** Reads the CSV as a stream, staging rows in batches of STAGE_BATCH inside the caller's transaction. */
  async function parseInto(
    tx: Parameters<Parameters<Database['withTenant']>[1]>[0],
    tenantId: string,
    importId: string,
    kind: ImportKind,
    stream: Readable,
  ): Promise<void> {
    const parser = stream.pipe(
      parse({
        bom: true,
        skip_empty_lines: true,
        relax_column_count: true,
        info: true,
        columns: false,
      }),
    );
    stream.on('error', (err) => parser.destroy(err));
    let columns: (ColumnSpec | null)[] | undefined;
    let batch: ParsedRow[] = [];
    let count = 0;
    try {
      for await (const item of parser as AsyncIterable<{
        record: string[];
        info: { lines: number };
      }>) {
        if (!columns) {
          const mapped = mapHeader(kind, item.record);
          if (!mapped.ok) throw headerProblemError(mapped.problem);
          columns = mapped.columns;
          continue;
        }
        count++;
        if (count > config.maxRows) {
          throw new PayloadTooLargeError(
            'too_many_rows',
            `The file has more than ${config.maxRows} rows: split it`,
          );
        }
        batch.push(toParsedRow(columns, item.record, item.info.lines));
        if (batch.length >= STAGE_BATCH) {
          await importsRepo.stageRows(tx, tenantId, importId, batch);
          batch = [];
        }
      }
    } catch (err) {
      stream.destroy();
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new PayloadTooLargeError(
          'file_too_large',
          `The file is larger than ${Math.round(config.maxBytes / 1024 / 1024)} MB`,
        );
      }
      const code = (err as { code?: string }).code ?? '';
      if (code.startsWith('CSV_')) {
        const line = (err as { lines?: number }).lines;
        throw new InvalidImportFileError(
          'invalid_csv',
          `The file is not valid CSV${line ? ` (line ${line})` : ''}`,
        );
      }
      throw err;
    }
    if ((stream as { truncated?: boolean }).truncated) {
      throw new PayloadTooLargeError(
        'file_too_large',
        `The file is larger than ${Math.round(config.maxBytes / 1024 / 1024)} MB`,
      );
    }
    if (!columns) throw new InvalidImportFileError('empty_file', 'The file is empty');
    if (count === 0) {
      throw new InvalidImportFileError('no_rows', 'The file has a header but no rows');
    }
    if (batch.length > 0) await importsRepo.stageRows(tx, tenantId, importId, batch);
  }

  /** Runs a confirm/cancel/finish write and maps the one-running-import constraint. */
  async function guardedRunning<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (pgErrorCode(err) === '23505' && pgConstraint(err) === 'import_jobs_one_running') {
        throw new ImportInProgressError();
      }
      throw err;
    }
  }

  async function processBatch(
    tenantId: string,
    importId: string,
    kind: ImportKind,
    update: boolean,
  ) {
    const n = config.batchSize;
    return db.withTenant(tenantId, (tx) =>
      importsRepo.processBatch(tx, {
        tenantId,
        importId,
        kind,
        updateExisting: update,
        batchSize: n,
        ratePerSecond: config.inviteRatePerSecond,
        // UUIDv7 ids are made here (never by the database): one per row of the batch
        userIds: Array.from({ length: n }, () => newId()),
        membershipIds: Array.from({ length: n }, () => newId()),
        profileIds: Array.from({ length: n }, () => newId()),
      }),
    );
  }

  return {
    config,

    /** GET /imports/templates/<kind>.csv */
    template(kind: string): string {
      if (!(IMPORT_KINDS as readonly string[]).includes(kind)) throw new ImportNotFoundError();
      return templateCsv(kind as ImportKind);
    },

    /**
     * POST /imports: streams the CSV into the staging table, validates it with set-based SQL (the dry
     * run) and leaves it 'validated'. ONE transaction: a refused or failed upload leaves no trace, and
     * nothing is written to any real table.
     */
    async upload(ctx: RequestContext, input: UploadInput): Promise<Row> {
      const tenantId = tenantFor(ctx);
      if (!(IMPORT_KINDS as readonly string[]).includes(input.kind)) {
        throw new InvalidImportFileError('invalid_kind', 'kind must be students or faculty');
      }
      const kind = input.kind as ImportKind;
      const importId = newId();
      return db.withTenant(tenantId, async (tx) => {
        await importsRepo.createJob(tx, {
          id: importId,
          tenantId,
          kind,
          fileName: cleanFileName(input.fileName),
          userId: ctx.userId,
        });
        await parseInto(tx, tenantId, importId, kind, input.stream);
        await importsRepo.validate(tx, tenantId, importId, kind);
        return importsRepo.finalizeUpload(tx, tenantId, importId, stamp(ctx.userId));
      });
    },

    async list(ctx: RequestContext, input: { limit?: number; after?: string }): Promise<Page<Row>> {
      const tenantId = tenantFor(ctx);
      const { limit, after } = normalizePage(input);
      const rows = await db.withTenant(tenantId, (tx) =>
        importsRepo.listJobs(tx, tenantId, { limit: limit + 1, after }),
      );
      return buildPage(rows as (Row & { id: string })[], limit);
    },

    /** GET /imports/:id: status and counts (also while it runs: they are refreshed every batch). */
    async get(ctx: RequestContext, id: string): Promise<Row> {
      const tenantId = tenantFor(ctx);
      const row = await db.withTenant(tenantId, (tx) => importsRepo.getJob(tx, tenantId, id));
      if (!row) throw new ImportNotFoundError();
      return row;
    },

    /** The staged rows (review the dry run): filter by status, keyset on the row number. */
    async rows(
      ctx: RequestContext,
      id: string,
      input: {
        status?: string | undefined;
        limit?: number | undefined;
        after?: number | undefined;
      },
    ): Promise<{ items: Row[]; nextCursor: number | null }> {
      const tenantId = tenantFor(ctx);
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
      // the import and its page of rows in ONE transaction (one extra statement, no second BEGIN/COMMIT)
      const { job, rows } = await db.withTenant(tenantId, async (tx) => {
        const j = await importsRepo.getJob(tx, tenantId, id);
        if (!j || j.rows_purged_at) return { job: j, rows: [] as Row[] };
        return {
          job: j,
          rows: await importsRepo.rowsPage(tx, tenantId, id, {
            statuses: input.status ? [input.status] : undefined,
            after: input.after ?? 0,
            limit: limit + 1,
          }),
        };
      });
      if (!job) throw new ImportNotFoundError();
      if (job.rows_purged_at) throw new RowsPurgedError();
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: rows.length > limit && last ? Number(last.row_number) : null,
      };
    },

    /**
     * GET /imports/:id/errors.csv: every row that was not imported (invalid, failed or skipped) with the
     * reason, streamed in pages of 1,000 rows. Every echoed cell is neutralized against formula injection.
     */
    async *errorReport(ctx: RequestContext, id: string): AsyncGenerator<string> {
      const tenantId = tenantFor(ctx);
      // the first page is read together with the import itself (one transaction)
      const first = await db.withTenant(tenantId, async (tx) => {
        const j = await importsRepo.getJob(tx, tenantId, id);
        if (!j || j.rows_purged_at) return { job: j, page: [] as Row[] };
        return {
          job: j,
          page: await importsRepo.rowsPage(tx, tenantId, id, {
            statuses: ['invalid', 'failed', 'skipped'],
            after: 0,
            limit: REPORT_PAGE,
          }),
        };
      });
      const job = first.job;
      if (!job) throw new ImportNotFoundError();
      if (job.rows_purged_at) throw new RowsPurgedError();
      const kind = job.kind as ImportKind;
      yield reportHeader(kind);
      let after = 0;
      let pending: Row[] | null = first.page;
      for (;;) {
        const page: Row[] =
          pending ??
          (await db.withTenant(tenantId, (tx) =>
            importsRepo.rowsPage(tx, tenantId, id, {
              statuses: ['invalid', 'failed', 'skipped'],
              after,
              limit: REPORT_PAGE,
            }),
          ));
        pending = null;
        for (const r of page) {
          yield reportLine(kind, {
            rowNumber: Number(r.row_number),
            status: String(r.status),
            raw: (r.raw as Record<string, string>) ?? {},
            errors: (r.errors as { column: string; message: string }[]) ?? [],
            result: (r.result as string | null) ?? null,
          });
        }
        const last = page[page.length - 1];
        if (page.length < REPORT_PAGE || !last) return;
        after = Number(last.row_number);
      }
    },

    /** POST /imports/:id/confirm: validated -> queued, and the background job exists in the same transaction. */
    async confirm(
      ctx: RequestContext,
      id: string,
      input: { updateExisting?: boolean | undefined; skipInvalid?: boolean | undefined },
    ): Promise<Row> {
      const tenantId = tenantFor(ctx);
      const r = await guardedRunning(() =>
        db.withTenant(tenantId, (tx) =>
          importsRepo.confirm(
            tx,
            tenantId,
            id,
            {
              updateExisting: input.updateExisting ?? false,
              skipInvalid: input.skipInvalid ?? false,
              jobId: newId(),
              maxAttempts: jobsService.config.maxAttempts,
            },
            stamp(ctx.userId),
          ),
        ),
      );
      if (!r.found || !r.before) throw new ImportNotFoundError();
      if (!r.after) {
        const b = r.before;
        if (b.status !== 'validated') throw new ImportNotConfirmableError(String(b.status));
        if (Number(b.valid_rows) === 0) throw new NothingToImportError();
        throw new HasInvalidRowsError(Number(b.invalid_rows));
      }
      jobsService.notifyEnqueued('imports.process'); // committed: wake an in-process worker
      return r.after;
    },

    /** POST /imports/:id/cancel: only a validated (not yet confirmed) import. */
    async cancel(ctx: RequestContext, id: string): Promise<Row> {
      const tenantId = tenantFor(ctx);
      const r = await db.withTenant(tenantId, (tx) =>
        importsRepo.cancel(tx, tenantId, id, stamp(ctx.userId)),
      );
      if (!r.before) throw new ImportNotFoundError();
      if (!r.after) throw new ImportNotConfirmableError(String(r.before.status));
      return r.after;
    },

    // ------------------------------------------------------------------ the worker side

    /** One batch (tests drive it directly to simulate a crash after N batches). Returns the rows it picked. */
    async processOneBatch(tenantId: string, importId: string): Promise<number> {
      const state = await db.withTenant(tenantId, (tx) =>
        importsRepo.markProcessing(tx, tenantId, importId),
      );
      if (!state) return 0;
      const r = await processBatch(tenantId, importId, state.kind, state.updateExisting);
      return r.picked;
    },

    /**
     * The job handler's body: applies the valid rows batch by batch until none are left, then closes the
     * import. A re-run (retry, or another worker after a crash) simply continues with the rows that are
     * still valid. Stops early, without finishing, when the worker is shutting down (ctx.signal).
     */
    async process(
      tenantId: string,
      importId: string,
      ctx: Pick<JobContext, 'signal' | 'attempt' | 'maxAttempts'>,
    ): Promise<{ batches: number; rows: number }> {
      const state = await db.withTenant(tenantId, (tx) =>
        importsRepo.markProcessing(tx, tenantId, importId),
      );
      if (!state) return { batches: 0, rows: 0 }; // cancelled / already finished: nothing to do
      let batches = 0;
      let rows = 0;
      try {
        while (!ctx.signal.aborted) {
          const r = await processBatch(tenantId, importId, state.kind, state.updateExisting);
          if (r.picked === 0) break;
          batches++;
          rows += r.picked;
        }
        if (ctx.signal.aborted) return { batches, rows };
        await db.withTenant(tenantId, (tx) =>
          importsRepo.finish(tx, tenantId, importId, stamp(null)),
        );
      } catch (err) {
        if (ctx.attempt >= ctx.maxAttempts) {
          // the queue will not try again: free the tenant for its next import
          const message = err instanceof Error ? err.message : String(err);
          await db
            .withTenant(tenantId, (tx) =>
              importsRepo.fail(tx, tenantId, importId, message, stamp(null)),
            )
            .catch(() => undefined);
        }
        throw err;
      }
      return { batches, rows };
    },

    /** Retention: staged rows of finished / cancelled / abandoned imports after IMPORT_RETENTION_DAYS. */
    async purgeRows(): Promise<number> {
      let total = 0;
      for (let i = 0; i < MAX_PURGE_BATCHES; i++) {
        const n = await db.withoutTenant((exec) =>
          importsRepo.purgeRows(exec, config.retentionDays, config.purgeBatchSize),
        );
        total += n;
        if (n < config.purgeBatchSize) break;
      }
      return total;
    },

    /** Imports whose job is dead-lettered are marked failed (so they stop blocking the tenant). */
    reapDead(): Promise<number> {
      return db.withoutTenant((exec) => importsRepo.reapDead(exec));
    },
  };
}
export type ImportsService = ReturnType<typeof createImportsService>;

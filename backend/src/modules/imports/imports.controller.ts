import { Readable } from 'node:stream';
import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  ConfirmImportRequestSchema,
  ImportListQuerySchema,
  ImportRowsQuerySchema,
  UploadQuerySchema,
} from '../../contracts';
import { contextFrom } from '../../core/context';
import { BadRequestError } from '../../core/errors';
import { NoFileError, UnsupportedFileTypeError } from './imports.errors';
import type { ImportsService, Row } from './imports.service';

// Reads the validated request, calls the service, maps the result to the response DTO. The upload hands
// the file STREAM to the service (never a buffer). No DB access, no business rules.
type Params = { Params: { id: string } };

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export function toImportDto(r: Row) {
  return {
    id: r.id as string,
    kind: r.kind as 'students' | 'faculty',
    fileName: r.file_name as string,
    status: r.status as never,
    updateExisting: r.update_existing === true,
    skipInvalid: r.skip_invalid === true,
    counts: {
      total: Number(r.total_rows),
      valid: Number(r.valid_rows),
      invalid: Number(r.invalid_rows),
      processed: Number(r.processed_rows),
      skipped: Number(r.skipped_rows),
      failed: Number(r.failed_rows),
      created: Number(r.created_members),
      updated: Number(r.updated_members),
    },
    error: (r.error as string | null) ?? null,
    createdAt: iso(r.created_at) as string,
    confirmedAt: iso(r.confirmed_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    rowsPurged: r.rows_purged_at != null,
  };
}

const ACCEPTED_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
  'application/octet-stream',
]);

const toRowDto = (r: Row) => ({
  rowNumber: Number(r.row_number),
  status: r.status as never,
  cells: (r.raw as Record<string, string>) ?? {},
  errors: (r.errors as { column: string; message: string }[]) ?? [],
  result: (r.result as string | null) ?? null,
});

export function createImportsController(deps: { importsService: ImportsService }) {
  const { importsService: svc } = deps;
  return {
    template:
      (kind: 'students' | 'faculty') => async (_request: FastifyRequest, reply: FastifyReply) => {
        reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="${kind}.csv"`);
        return svc.template(kind);
      },

    upload: async (
      request: FastifyRequest<{ Querystring: Static<typeof UploadQuerySchema> }>,
      reply: FastifyReply,
    ) => {
      const ctx = contextFrom(request);
      const file = await request.file();
      if (!file) throw new NoFileError();
      const name = file.filename ?? '';
      if (!/\.csv$/i.test(name) || !ACCEPTED_TYPES.has(file.mimetype.toLowerCase())) {
        file.file.resume();
        throw new UnsupportedFileTypeError();
      }
      const row = await svc.upload(ctx, {
        kind: request.query.kind,
        fileName: name,
        stream: file.file,
      });
      reply.status(201);
      return toImportDto(row);
    },

    list: async (
      request: FastifyRequest<{ Querystring: Static<typeof ImportListQuerySchema> }>,
    ) => {
      const page = await svc.list(contextFrom(request), request.query);
      return { items: page.items.map(toImportDto), nextCursor: page.nextCursor };
    },

    get: async (request: FastifyRequest<Params>) =>
      toImportDto(await svc.get(contextFrom(request), request.params.id)),

    rows: async (
      request: FastifyRequest<Params & { Querystring: Static<typeof ImportRowsQuerySchema> }>,
    ) => {
      const r = await svc.rows(contextFrom(request), request.params.id, request.query);
      return { items: r.items.map(toRowDto), nextCursor: r.nextCursor };
    },

    /** The error report as a stream: the first page is read before the headers go out (404 / 410 stay JSON). */
    errorsCsv: async (request: FastifyRequest<Params>, reply: FastifyReply) => {
      const gen = svc.errorReport(contextFrom(request), request.params.id);
      const first = await gen.next(); // throws not-found / purged before any byte is sent
      if (first.done) throw new BadRequestError('empty_report', 'Nothing to report');
      const stream = Readable.from(
        (async function* () {
          yield first.value;
          yield* gen;
        })(),
      );
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="import-${request.params.id}-errors.csv"`,
        )
        .header('cache-control', 'no-store');
      return reply.send(stream);
    },

    confirm: async (
      request: FastifyRequest<Params & { Body: Static<typeof ConfirmImportRequestSchema> }>,
    ) =>
      toImportDto(await svc.confirm(contextFrom(request), request.params.id, request.body ?? {})),

    cancel: async (request: FastifyRequest<Params>) =>
      toImportDto(await svc.cancel(contextFrom(request), request.params.id)),
  };
}
export type ImportsController = ReturnType<typeof createImportsController>;

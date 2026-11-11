import type { Readable } from 'node:stream';
import { CsvError, parse } from 'csv-parse';
import {
  MAX_QUESTION_IMPORT_ROWS,
  type QuestionImportDto,
  type QuestionInput,
} from '../../contracts';
import { can, type Permission, participationsGranting } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { ForbiddenError } from '../../core/errors';
import { newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import { assertCourseAccess, type CourseAccessSpec } from '../courses';
import { mapHeader, parseRow, templateCsv } from './questions.csv';
import {
  InvalidQuestionFileError,
  QuestionChangedError,
  QuestionImportFileError,
  QuestionImportInvalidRowsError,
  QuestionImportNotFoundError,
  QuestionImportStateError,
  QuestionNotFoundError,
  QuestionVersionNotFoundError,
} from './questions.errors';
import { type AnswerKey, buildVersion, type Presentation, toQuestionDto } from './questions.keys';
import type { ListFilter, QuestionsRepository, Row } from './questions.repository';

export type { Row } from './questions.repository';

const iso = (v: unknown) => new Date(v as string).toISOString();

function dtoOf(r: Row) {
  return toQuestionDto({
    id: r.id as string,
    courseId: r.courseId as string,
    status: r.status as 'active',
    version: Number(r.version),
    latestVersion: Number(r.latestVersion),
    versionId: r.versionId as string,
    type: r.type as never,
    difficulty: r.difficulty as never,
    presentation: r.presentation as Presentation,
    answerKey: r.answerKey as AnswerKey,
    tags: (r.tags as string[]) ?? [],
    createdAt: r.createdAt as string,
    updatedAt: r.updatedAt as string,
  });
}

export function createQuestionsService(deps: {
  db: Pick<Database, 'withTenant' | 'withoutTenant'>;
  questionsRepo: QuestionsRepository;
}) {
  const { db, questionsRepo: repo } = deps;

  const spec = (
    ctx: RequestContext,
    courseId: string,
    permission: Permission,
  ): CourseAccessSpec => {
    if (!ctx.tenantId) throw new ForbiddenError();
    return {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      courseId,
      viewAll: can(ctx, 'course.read'),
      accountAllowed: can(ctx, permission),
      allowedBy: participationsGranting(permission),
    };
  };
  const importDto = (r: Row): QuestionImportDto => ({
    id: r.id as string,
    courseId: r.course_id as string,
    fileName: r.file_name as string,
    status: r.status as 'staged',
    totalRows: Number(r.total_rows),
    validRows: Number(r.valid_rows),
    invalidRows: Number(r.total_rows) - Number(r.valid_rows),
    createdCount: Number(r.created_count),
    createdAt: iso(r.created_at),
  });

  return {
    async list(
      ctx: RequestContext,
      courseId: string,
      q: Partial<Omit<ListFilter, 'limit' | 'after'>> & {
        limit?: number | undefined;
        after?: string | undefined;
      },
    ) {
      const a = spec(ctx, courseId, 'question.read');
      const limit = q.limit ?? 50;
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.list(tx, a, {
          type: q.type ?? null,
          difficulty: q.difficulty ?? null,
          tag: q.tag ?? null,
          status: q.status ?? 'active',
          limit,
          after: q.after ?? null,
        }),
      );
      assertCourseAccess(r.acc);
      const more = r.rows.length > limit;
      const rows = more ? r.rows.slice(0, limit) : r.rows;
      return {
        items: rows.map(dtoOf),
        nextCursor: more ? ((rows.at(-1)?.id as string | undefined) ?? null) : null,
      };
    },

    async get(ctx: RequestContext, courseId: string, questionId: string, version?: number) {
      const a = spec(ctx, courseId, 'question.read');
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.get(tx, a, questionId, version ?? null),
      );
      assertCourseAccess(r.acc);
      if (r.versionMissing) throw new QuestionVersionNotFoundError();
      if (!r.row) throw new QuestionNotFoundError();
      return dtoOf(r.row);
    },

    async versions(ctx: RequestContext, courseId: string, questionId: string) {
      const a = spec(ctx, courseId, 'question.read');
      const r = await db.withTenant(a.tenantId, (tx) => repo.versions(tx, a, questionId));
      assertCourseAccess(r.acc);
      if (r.rows.length === 0) throw new QuestionNotFoundError();
      return {
        items: r.rows.map((v) => ({
          version: Number(v.version),
          versionId: v.versionId as string,
          current: v.current === true,
          createdAt: iso(v.createdAt),
          createdByName: (v.createdByName as string | null) ?? null,
        })),
      };
    },

    async tags(ctx: RequestContext, courseId: string) {
      const a = spec(ctx, courseId, 'question.read');
      const r = await db.withTenant(a.tenantId, (tx) => repo.tags(tx, a));
      assertCourseAccess(r.acc);
      return { items: r.rows.map((t) => ({ tag: t.tag as string, count: Number(t.count) })) };
    },

    async create(ctx: RequestContext, courseId: string, input: QuestionInput) {
      const a = spec(ctx, courseId, 'question.manage');
      const built = buildVersion(input);
      const id = newId();
      const versionId = newId();
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.create(tx, a, id, { ...built, versionId, userId: ctx.userId }),
      );
      assertCourseAccess(r.acc);
      if (!r.filesOk) throw new InvalidQuestionFileError();
      const at = r.createdAt ?? new Date().toISOString();
      return toQuestionDto({
        id,
        courseId,
        status: 'active',
        version: 1,
        latestVersion: 1,
        versionId,
        type: built.type,
        difficulty: built.difficulty,
        presentation: built.presentation,
        answerKey: built.answerKey,
        tags: [...built.tags].sort(),
        createdAt: at,
        updatedAt: at,
      });
    },

    /** Editing = a NEW version. The question keeps its id; attempts keep the version they showed. */
    /**
     * Editing = a NEW version, in ONE transaction: read the current version (the kept option ids), then save the next
     * one only if nobody saved in between (the second statement checks the version it was built on). 5 round trips.
     */
    async update(ctx: RequestContext, courseId: string, questionId: string, input: QuestionInput) {
      const a = spec(ctx, courseId, 'question.manage');
      const versionId = newId();
      const out = await db.withTenant(a.tenantId, async (tx) => {
        const cur = await repo.get(tx, a, questionId, null);
        assertCourseAccess(cur.acc);
        if (!cur.row) throw new QuestionNotFoundError();
        const presentation = cur.row.presentation as Presentation;
        const built = buildVersion(input, {
          optionIds: (presentation.options ?? []).map((o) => o.id),
          type: cur.row.type as string,
        });
        const r = await repo.addVersion(tx, a, questionId, cur.row.versionId as string, {
          ...built,
          versionId,
          userId: ctx.userId,
        });
        return { cur: cur.row, built, r };
      });
      const { cur, built, r } = out;
      assertCourseAccess(r.acc);
      if (!r.found) throw new QuestionNotFoundError();
      if (!r.filesOk) throw new InvalidQuestionFileError();
      if (r.version === null) throw new QuestionChangedError();
      return toQuestionDto({
        id: questionId,
        courseId,
        status: cur.status as 'active' | 'archived',
        version: r.version,
        latestVersion: r.version,
        versionId,
        type: built.type,
        difficulty: built.difficulty,
        presentation: built.presentation,
        answerKey: built.answerKey,
        tags: [...built.tags].sort(),
        createdAt: r.createdAt ?? new Date().toISOString(),
        updatedAt: r.updatedAt ?? new Date().toISOString(),
      });
    },

    async setStatus(
      ctx: RequestContext,
      courseId: string,
      questionId: string,
      status: 'active' | 'archived',
    ) {
      const a = spec(ctx, courseId, 'question.manage');
      const r = await db.withTenant(a.tenantId, (tx) => repo.setStatus(tx, a, questionId, status));
      assertCourseAccess(r.acc);
      if (!r.row) throw new QuestionNotFoundError();
      return dtoOf(r.row);
    },

    /** The row of an image of this question, for a signed download (instructors, assistants, administrators). */
    async imageFile(ctx: RequestContext, courseId: string, questionId: string, fileId: string) {
      const a = spec(ctx, courseId, 'question.read');
      const r = await db.withTenant(a.tenantId, (tx) => repo.imageFile(tx, a, questionId, fileId));
      assertCourseAccess(r.acc);
      if (!r.file) throw new QuestionNotFoundError();
      return r.file as { storage_key: string; original_name: string; content_type: string };
    },

    // ---------------------------------------------------------------- CSV import
    async template(ctx: RequestContext, courseId: string) {
      const a = spec(ctx, courseId, 'question.manage');
      assertCourseAccess(await db.withTenant(a.tenantId, (tx) => repo.access(tx, a)));
      return templateCsv();
    },

    /** Parses the whole file (at most 1,000 rows), validates every row, stages it. Nothing is created yet. */
    async upload(
      ctx: RequestContext,
      courseId: string,
      file: { name: string; stream: Readable },
    ): Promise<QuestionImportDto> {
      const a = spec(ctx, courseId, 'question.manage');
      const parser = file.stream.pipe(
        parse({ bom: true, skip_empty_lines: true, relax_column_count: true, columns: false }),
      );
      file.stream.on('error', (e) => parser.destroy(e));
      const rows: { rowNo: number; raw: unknown; parsed: unknown; errors: unknown }[] = [];
      let columns: Map<string, number> | undefined;
      try {
        for await (const record of parser as AsyncIterable<string[]>) {
          if (!columns) {
            const h = mapHeader(record);
            if (!h.ok) throw new QuestionImportFileError(400, 'invalid_header', h.message);
            columns = h.index;
            continue;
          }
          if (rows.length >= MAX_QUESTION_IMPORT_ROWS)
            throw new QuestionImportFileError(
              413,
              'too_many_rows',
              `The file has more than ${MAX_QUESTION_IMPORT_ROWS} rows: split it`,
            );
          const row = parseRow(columns as never, record);
          rows.push({
            rowNo: rows.length + 1,
            raw: row.raw,
            parsed: row.parsed,
            errors: row.errors,
          });
        }
      } catch (err) {
        file.stream.destroy();
        if (err instanceof QuestionImportFileError) throw err;
        if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE')
          throw new QuestionImportFileError(413, 'file_too_large', 'The file is too large');
        // csv-parse names its own errors (codes such as INVALID_OPENING_QUOTE and CSV_RECORD_INCONSISTENT_COLUMNS)
        if (err instanceof CsvError)
          throw new QuestionImportFileError(
            400,
            'invalid_csv',
            `The file is not valid CSV${err.lines ? ` (line ${err.lines})` : ''}`,
          );
        throw err;
      }
      if (!columns) throw new QuestionImportFileError(400, 'empty_file', 'The file is empty');
      if (rows.length === 0)
        throw new QuestionImportFileError(400, 'no_rows', 'The file has a header but no questions');
      const name = (file.name.split(/[\\/]/).pop() ?? 'questions.csv').slice(0, 255);
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.stageImport(tx, a, { id: newId(), fileName: name, userId: ctx.userId, rows }),
      );
      assertCourseAccess(r.acc);
      if (!r.row) throw new QuestionNotFoundError();
      return importDto(r.row);
    },

    async getImport(ctx: RequestContext, courseId: string, importId: string) {
      const a = spec(ctx, courseId, 'question.manage');
      const r = await db.withTenant(a.tenantId, (tx) => repo.getImport(tx, a, importId));
      assertCourseAccess(r.acc);
      if (!r.row) throw new QuestionImportNotFoundError();
      return importDto(r.row);
    },

    async importRows(
      ctx: RequestContext,
      courseId: string,
      importId: string,
      q: {
        status?: 'valid' | 'invalid' | undefined;
        after?: number | undefined;
        limit?: number | undefined;
      },
    ) {
      const a = spec(ctx, courseId, 'question.manage');
      const limit = q.limit ?? 100;
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.importRows(tx, a, importId, { status: q.status ?? null, after: q.after ?? 0, limit }),
      );
      assertCourseAccess(r.acc);
      if (!r.found) throw new QuestionImportNotFoundError();
      const more = r.rows.length > limit;
      const rows = more ? r.rows.slice(0, limit) : r.rows;
      return {
        items: rows.map((x) => ({
          rowNo: Number(x.rowNo),
          valid: x.valid === true,
          errors: (x.errors as { column: string; message: string }[]) ?? [],
          question: x.question as string,
          type: x.type as string,
        })),
        nextCursor: more ? Number(rows.at(-1)?.rowNo ?? 0) : null,
      };
    },

    async confirmImport(
      ctx: RequestContext,
      courseId: string,
      importId: string,
      skipInvalid: boolean,
    ) {
      const a = spec(ctx, courseId, 'question.manage');
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.applyImport(tx, a, importId, ctx.userId, skipInvalid),
      );
      assertCourseAccess(r.acc);
      if (!r.row) throw new QuestionImportNotFoundError();
      if (r.blocked === 'state') throw new QuestionImportStateError(r.row.status as string);
      if (r.blocked === 'invalid')
        throw new QuestionImportInvalidRowsError(
          Number(r.row.total_rows) - Number(r.row.valid_rows),
        );
      return importDto(r.row);
    },

    /** Worker: a staged import nobody confirmed or cancelled is removed after a day. */
    purgeImports: (hours = 24) => db.withoutTenant((conn) => repo.purgeImports(conn, hours)),

    async cancelImport(ctx: RequestContext, courseId: string, importId: string) {
      const a = spec(ctx, courseId, 'question.manage');
      const r = await db.withTenant(a.tenantId, (tx) => repo.cancelImport(tx, a, importId));
      assertCourseAccess(r.acc);
      if (!r.row) throw new QuestionImportNotFoundError();
      if (!r.wasStaged) throw new QuestionImportStateError(r.row.status as string);
      return importDto(r.row);
    },
  };
}
export type QuestionsService = ReturnType<typeof createQuestionsService>;

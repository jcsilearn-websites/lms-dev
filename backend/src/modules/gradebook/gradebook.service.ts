import { Readable } from 'node:stream';
import { parse } from 'csv-parse/sync';
import type {
  CategoryInput,
  ExportColumn,
  GradeScaleInput,
  ItemInput,
  SettingsPatch,
} from '../../contracts';
import { can, type Permission, participationsGranting } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { csvLine } from '../../core/csv';
import { ForbiddenError } from '../../core/errors';
import { xlsxStream } from '../../core/xlsx';
import type { Database, Executor } from '../../db/client';
import { isUniqueViolation } from '../../db/pg-errors';
import { type AccessRow, type AccessSpec, assertAccess, OfferingNotFoundError } from '../courses';
import {
  CategoryInUseError,
  GradebookItemNotFoundError,
  GradebookLockedError,
  GradebookNotFoundError,
  GradebookNotReadyError,
  GradeScaleNameTakenError,
  GradeScaleNotFoundError,
  InvalidGradebookError,
  InvalidMarkError,
  InvalidMarksCsvError,
  LearnerNotInClassError,
  MarkImportDoneError,
  MarkImportHasErrorsError,
  MarkImportNotFoundError,
  NoOverrideError,
  NoSnapshotError,
  NotLockedError,
  NotSubmittedError,
  SelfApprovalError,
} from './gradebook.errors';
import type { GradebookRepository, Row } from './gradebook.repository';

export type { Row } from './gradebook.repository';

const MAX_IMPORT_ROWS = 2000;
const MAX_IMPORT_COLUMNS = 61;
const EXPORT_PAGE = 500;
const IMPORT_TTL_HOURS = 24;

export interface ExportFile {
  fileName: string;
  contentType: string;
  stream: Readable;
}

export function createGradebookService(deps: {
  db: Pick<Database, 'withTenant' | 'withoutTenant'>;
  gradebookRepo: GradebookRepository;
}) {
  const { db, gradebookRepo: repo } = deps;

  const tenantOf = (ctx: RequestContext): string => {
    if (!ctx.tenantId) throw new ForbiddenError();
    return ctx.tenantId;
  };
  const spec = (ctx: RequestContext, offeringId: string, permission: Permission): AccessSpec => ({
    tenantId: tenantOf(ctx),
    userId: ctx.userId,
    offeringId,
    viewAll: can(ctx, 'course.read'),
    accountAllowed: can(ctx, permission),
    allowedBy: participationsGranting(permission),
  });

  /** Maps the `result` code of a database function to the error every route answers with; returns the row when ok. */
  function verdict(res: Row | null): Row {
    if (!res) throw new GradebookNotFoundError();
    switch (res.result) {
      case undefined:
      case 'ok':
        return res;
      case 'not_found':
        throw new GradebookNotFoundError();
      case 'not_editable':
        throw new GradebookLockedError(String(res.status));
      case 'invalid':
        throw new InvalidGradebookError(res.details as { path: string; message: string }[]);
      case 'category_in_use':
        throw new CategoryInUseError(String(res.name));
      case 'bad_participant':
        throw new LearnerNotInClassError();
      case 'bad_item':
        throw new GradebookItemNotFoundError();
      case 'bad_value':
        throw new InvalidMarkError(Number(res.max));
      case 'forbidden':
        throw new ForbiddenError();
      case 'no_override':
        throw new NoOverrideError();
      case 'not_ready':
        throw new GradebookNotReadyError(
          res.problems as { code: string; message: string; items?: string[] }[],
        );
      case 'not_submitted':
        throw new NotSubmittedError();
      case 'self_approval':
        throw new SelfApprovalError();
      case 'not_locked':
        throw new NotLockedError();
      case 'import_done':
        throw new MarkImportDoneError();
      case 'has_errors':
        throw new MarkImportHasErrorsError(Number(res.errorCells));
      default:
        throw new GradebookNotFoundError();
    }
  }

  async function read(
    ctx: RequestContext,
    offeringId: string,
    permission: Permission,
    fn: (tx: Executor, a: AccessSpec) => Promise<{ acc: AccessRow | null; res: Row | null }>,
  ): Promise<Row> {
    const a = spec(ctx, offeringId, permission);
    const r = await db.withTenant(a.tenantId, (tx) => fn(tx, a));
    assertAccess(r.acc);
    return verdict(r.res);
  }

  // ---------------------------------------------------------------- the marks CSV
  const registerHeader = (h: string) =>
    ['registernumber', 'registerno', 'regno', 'register'].includes(
      h.toLowerCase().replace(/[\s_.-]/g, ''),
    );

  function parseMarksCsv(csv: string): {
    rows: number;
    cells: { row: number; cell: number; register: string; column: string; raw: string }[];
  } {
    let records: string[][];
    try {
      records = parse(csv, {
        bom: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: false,
        columns: false,
      }) as string[][];
    } catch (err) {
      throw new InvalidMarksCsvError(
        `The file could not be read as CSV: ${(err as { code?: string }).code ?? 'malformed'}`,
      );
    }
    const header = records[0];
    if (!header || header.length < 2)
      throw new InvalidMarksCsvError(
        'The file needs a header row: register_number, then one column per manual item (named like the item)',
      );
    if (header.length > MAX_IMPORT_COLUMNS)
      throw new InvalidMarksCsvError(
        `The file has more than ${MAX_IMPORT_COLUMNS - 1} item columns`,
      );
    if (!registerHeader(header[0] ?? ''))
      throw new InvalidMarksCsvError('The first column must be register_number');
    const names = header.slice(1).map((h) => h.trim());
    if (names.some((n) => n === ''))
      throw new InvalidMarksCsvError('Every column after the first needs the name of an item');
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length)
      throw new InvalidMarksCsvError('Two columns have the same name');
    const data = records.slice(1);
    if (data.length === 0) throw new InvalidMarksCsvError('The file has no rows');
    if (data.length > MAX_IMPORT_ROWS)
      throw new InvalidMarksCsvError(`At most ${MAX_IMPORT_ROWS} rows per import`);
    const cells: { row: number; cell: number; register: string; column: string; raw: string }[] =
      [];
    data.forEach((rec, i) => {
      const register = (rec[0] ?? '').trim();
      names.forEach((column, j) => {
        const raw = (rec[j + 1] ?? '').trim();
        // an empty cell leaves the mark as it is; the value is kept short because the answer echoes it
        if (raw !== '')
          cells.push({ row: i + 2, cell: j + 1, register, column, raw: raw.slice(0, 40) });
      });
    });
    if (cells.length === 0) throw new InvalidMarksCsvError('The file has no marks in it');
    return { rows: data.length, cells };
  }

  // ---------------------------------------------------------------- export
  const DEFAULT_COLUMNS = (cfg: { items: Row[]; categories: Row[] }): ExportColumn[] => [
    { key: 'register', header: 'Register number' },
    { key: 'name', header: 'Name' },
    ...cfg.items.map((i) => ({ key: `item:${i.id}`, header: String(i.title) })),
    ...cfg.categories.map((c) => ({ key: `cat:${c.id}`, header: `${c.name} (%)` })),
    { key: 'final', header: 'Final marks' },
    { key: 'percent', header: 'Final percent' },
    { key: 'grade', header: 'Grade' },
  ];

  const cellValue = (key: string, row: Row): string | number | null => {
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    switch (key) {
      case 'register':
        return (row.registerNumber as string | null) ?? '';
      case 'name':
        return row.name as string;
      case 'email':
        return (row.email as string | null) ?? '';
      case 'section':
        return (row.section as string | null) ?? '';
      case 'final':
        return num(row.finalMarks);
      case 'percent':
        return num(row.finalPercent);
      case 'grade':
        return (row.grade as string | null) ?? '';
      default: {
        const [kind, id] = key.split(':') as [string, string];
        if (kind === 'item') {
          const c = (row.cells as Record<string, [string, string | null, number]>)[id];
          return c && ['s', 'o', 'z'].includes(c[0]) && c[1] !== null ? Number(c[1]) : null;
        }
        const t = (row.cats as Record<string, { p: number | null }>)[id];
        return t?.p ?? null;
      }
    }
  };

  async function* exportRows(
    ctx: RequestContext,
    meta: Row,
    columns: ExportColumn[],
  ): AsyncGenerator<(string | number | null)[]> {
    yield columns.map((c) => c.header);
    const tenantId = tenantOf(ctx);
    let after: { key: string; id: string } | null = null;
    for (;;) {
      const page: Row[] = await db.withTenant(tenantId, (tx) =>
        repo.snapshotPage(tx, tenantId, String(meta.id), after, EXPORT_PAGE, false),
      );
      for (const row of page) yield columns.map((c) => cellValue(c.key, row));
      const last = page[page.length - 1];
      if (page.length < EXPORT_PAGE || !last) return;
      after = { key: String(last.sortKey), id: String(last.participantId) };
    }
  }

  return {
    config: (ctx: RequestContext, offeringId: string) =>
      read(ctx, offeringId, 'gradebook.read', (tx, a) => repo.config(tx, a)),
    review: (ctx: RequestContext, offeringId: string) =>
      read(ctx, offeringId, 'gradebook.read', (tx, a) => repo.review(tx, a)),

    async updateSettings(ctx: RequestContext, offeringId: string, patch: SettingsPatch) {
      const r = await read(ctx, offeringId, 'gradebook.manage', (tx, a) =>
        repo.updateSettings(tx, a, patch),
      );
      return r.config as Row;
    },

    async saveCategories(ctx: RequestContext, offeringId: string, categories: CategoryInput[]) {
      const names = categories.map((c) => c.name.trim().toLowerCase());
      if (new Set(names).size !== names.length)
        throw new InvalidGradebookError([
          { path: 'categories', message: 'two categories have the same name' },
        ]);
      const r = await read(ctx, offeringId, 'gradebook.manage', (tx, a) =>
        repo.saveCategories(tx, a, categories),
      );
      return r.config as Row;
    },

    async saveItems(ctx: RequestContext, offeringId: string, items: ItemInput[]) {
      const problems: { path: string; message: string }[] = [];
      items.forEach((i, n) => {
        if (i.source === 'manual' && !i.title?.trim())
          problems.push({ path: `items[${n}].title`, message: 'name the column' });
        if (i.source !== 'manual' && !i.contentItemId && !i.id)
          problems.push({ path: `items[${n}].contentItemId`, message: 'choose the item' });
      });
      const titles = items
        .filter((i) => i.source === 'manual')
        .map((i) => i.title?.trim().toLowerCase());
      if (new Set(titles).size !== titles.length)
        problems.push({ path: 'items', message: 'two manual columns have the same name' });
      if (problems.length > 0) throw new InvalidGradebookError(problems);
      try {
        const r = await read(ctx, offeringId, 'gradebook.manage', (tx, a) =>
          repo.saveItems(tx, a, items),
        );
        return r.config as Row;
      } catch (err) {
        // the function refuses the whole call with an exception (nothing is kept): its DETAIL lists the problems
        let cur: unknown = err;
        for (let i = 0; i < 5 && cur; i++) {
          const c = cur as { message?: string; detail?: string; cause?: unknown };
          if (c.message === 'gradebook_items_invalid' && c.detail)
            throw new InvalidGradebookError(
              JSON.parse(c.detail) as { path: string; message: string }[],
            );
          cur = c.cause;
        }
        if (isUniqueViolation(err))
          throw new InvalidGradebookError([
            { path: 'items', message: 'two items of the gradebook have the same name' },
          ]);
        throw err;
      }
    },

    async grid(
      ctx: RequestContext,
      offeringId: string,
      q: { section?: string | undefined; after?: string | undefined; limit?: number | undefined },
    ) {
      let afterKey: string | null = null;
      let afterId: string | null = null;
      if (q.after) {
        const at = q.after.lastIndexOf('|');
        afterKey = at > 0 ? q.after.slice(0, at) : null;
        afterId = at > 0 ? q.after.slice(at + 1) : null;
        if (!afterKey || !afterId || !/^[0-9a-f-]{36}$/i.test(afterId))
          throw new InvalidGradebookError([{ path: 'after', message: 'not a valid cursor' }]);
      }
      const r = await read(ctx, offeringId, 'gradebook.read', (tx, a) =>
        repo.grid(tx, a, {
          section: q.section ?? null,
          afterKey,
          afterId,
          limit: q.limit ?? 500,
        }),
      );
      return {
        rows: r.rows as Row[],
        nextCursor: (r.next as string | null) ?? null,
        total: (r.total as number | null) ?? null,
      };
    },

    async explain(ctx: RequestContext, offeringId: string, participantId: string) {
      const a = spec(ctx, offeringId, 'gradebook.read');
      const r = await db.withTenant(a.tenantId, (tx) => repo.explain(tx, a, participantId));
      assertAccess(r.acc);
      if (!r.res) throw new LearnerNotInClassError();
      return r.res;
    },

    async saveMarks(
      ctx: RequestContext,
      offeringId: string,
      cells: {
        itemId: string;
        participantId: string;
        points: string | null;
        expected?: string | null | undefined;
      }[],
    ) {
      const r = await read(ctx, offeringId, 'gradebook.enter_marks', (tx, a) =>
        repo.saveMarks(tx, a, cells),
      );
      return {
        saved: Number(r.saved),
        unchanged: Number(r.unchanged),
        conflicts: r.conflicts as Row[],
        invalid: r.invalid as Row[],
        rows: r.rows as Record<string, Row>,
      };
    },

    async stageImport(ctx: RequestContext, offeringId: string, csv: string) {
      const parsed = parseMarksCsv(csv);
      return read(ctx, offeringId, 'gradebook.enter_marks', (tx, a) =>
        repo.stageImport(tx, a, parsed.rows, parsed.cells),
      );
    },
    async getImport(ctx: RequestContext, offeringId: string, importId: string) {
      const a = spec(ctx, offeringId, 'gradebook.enter_marks');
      const r = await db.withTenant(a.tenantId, (tx) => repo.getImport(tx, a, importId));
      assertAccess(r.acc);
      if (!r.res) throw new MarkImportNotFoundError();
      return r.res;
    },
    async applyImport(
      ctx: RequestContext,
      offeringId: string,
      importId: string,
      skipInvalid: boolean,
    ) {
      const a = spec(ctx, offeringId, 'gradebook.enter_marks');
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.applyImport(tx, a, importId, skipInvalid),
      );
      assertAccess(r.acc);
      if (r.res?.result === 'not_found') throw new MarkImportNotFoundError();
      const res = verdict(r.res);
      return {
        saved: Number(res.saved),
        unchanged: Number(res.unchanged),
        skippedRows: Number(res.skippedRows ?? 0),
      };
    },

    async setOverride(
      ctx: RequestContext,
      offeringId: string,
      participantId: string,
      v: { itemId: string | null; points: string; reason: string },
    ) {
      await read(ctx, offeringId, 'gradebook.override', (tx, a) =>
        repo.setOverride(tx, a, { participantId, ...v }),
      );
    },
    async revokeOverride(
      ctx: RequestContext,
      offeringId: string,
      participantId: string,
      itemId: string | null,
    ) {
      await read(ctx, offeringId, 'gradebook.override', (tx, a) =>
        repo.revokeOverride(tx, a, participantId, itemId),
      );
    },

    async submit(ctx: RequestContext, offeringId: string) {
      const r = await read(ctx, offeringId, 'gradebook.manage', (tx, a) => repo.submit(tx, a));
      return { status: 'submitted' as const, versionNo: Number(r.versionNo ?? 0) };
    },
    async approve(ctx: RequestContext, offeringId: string, comment: string | null) {
      const r = await read(ctx, offeringId, 'gradebook.approve', (tx, a) =>
        repo.reviewAction(tx, a, 'approve', comment),
      );
      return { status: 'locked' as const, versionNo: Number(r.versionNo) };
    },
    async returnToInstructor(ctx: RequestContext, offeringId: string, comment: string) {
      const r = await read(ctx, offeringId, 'gradebook.approve', (tx, a) =>
        repo.reviewAction(tx, a, 'return', comment),
      );
      return { status: 'returned' as const, versionNo: Number(r.versionNo) };
    },
    async unlock(ctx: RequestContext, offeringId: string, reason: string) {
      const r = await read(ctx, offeringId, 'gradebook.approve', (tx, a) =>
        repo.unlock(tx, a, reason),
      );
      return { status: 'draft' as const, versionNo: Number(r.versionNo) };
    },

    async queue(
      ctx: RequestContext,
      q: { status?: string | undefined; after?: string | undefined; limit?: number | undefined },
    ) {
      const tenantId = tenantOf(ctx);
      const limit = q.limit ?? 50;
      let afterAt: string | null = null;
      let afterId: string | null = null;
      if (q.after) {
        const at = q.after.lastIndexOf('|');
        afterAt = at > 0 ? q.after.slice(0, at) : null;
        afterId = at > 0 ? q.after.slice(at + 1) : null;
        if (!afterAt || !afterId || Number.isNaN(Date.parse(afterAt)))
          throw new InvalidGradebookError([{ path: 'after', message: 'not a valid cursor' }]);
      }
      const rows = await db.withTenant(tenantId, (tx) =>
        repo.queue(tx, tenantId, {
          status: q.status ?? 'submitted',
          afterAt,
          afterId,
          limit: limit + 1,
        }),
      );
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page,
        nextCursor: rows.length > limit && last ? `${last.sortAt}|${last.gradebookId}` : null,
      };
    },

    async me(ctx: RequestContext, offeringId: string) {
      const tenantId = tenantOf(ctx);
      const r = await db.withoutTenant((conn) =>
        repo.me(conn, { tenantId, userId: ctx.userId, offeringId }),
      );
      switch (r.result) {
        case 'ok':
          return r;
        case 'forbidden':
          throw new ForbiddenError();
        default:
          throw new OfferingNotFoundError();
      }
    },

    /** The approved record as a download. Pages of 500 learners are read while the file streams. */
    async exportSnapshot(
      ctx: RequestContext,
      offeringId: string,
      version: number | null,
      format: 'csv' | 'xlsx',
    ): Promise<ExportFile> {
      const a = spec(ctx, offeringId, 'gradebook.read');
      const r = await db.withTenant(a.tenantId, (tx) => repo.snapshotMeta(tx, a, version));
      assertAccess(r.acc);
      if (!r.res) throw new NoSnapshotError();
      const meta = r.res;
      const config = meta.config as { items: Row[]; categories: Row[] };
      const known = new Set([
        ...config.items.map((i) => `item:${i.id}`),
        ...config.categories.map((c) => `cat:${c.id}`),
      ]);
      const layout = (
        (meta.exportLayout as ExportColumn[] | null) ?? DEFAULT_COLUMNS(config)
      ).filter((c) => !/^(item|cat):/.test(c.key) || known.has(c.key));
      const columns = layout.length > 0 ? layout : DEFAULT_COLUMNS(config);
      const base = `gradebook-v${meta.versionNo}`;
      const rows = exportRows(ctx, meta, columns);
      if (format === 'xlsx')
        return {
          fileName: `${base}.xlsx`,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          stream: await xlsxStream('Gradebook', rows),
        };
      return {
        fileName: `${base}.csv`,
        contentType: 'text/csv; charset=utf-8',
        stream: Readable.from(
          (async function* () {
            for await (const row of rows) yield csvLine(row);
          })(),
        ),
      };
    },

    // ---------------------------------------------------------------- grade scales (college level)
    async listScales(ctx: RequestContext, includeArchived: boolean) {
      const tenantId = tenantOf(ctx);
      return db.withTenant(tenantId, (tx) => repo.listScales(tx, tenantId, includeArchived));
    },
    async saveScale(ctx: RequestContext, input: GradeScaleInput) {
      const tenantId = tenantOf(ctx);
      let res: Row;
      try {
        res = await db.withTenant(tenantId, (tx) =>
          repo.saveScale(tx, tenantId, ctx.userId, input),
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw new GradeScaleNameTakenError();
        throw err;
      }
      if (res.result === 'not_found') throw new GradeScaleNotFoundError();
      verdict(res);
      return res.scale as Row;
    },
    async archiveScale(ctx: RequestContext, scaleId: string, archived: boolean) {
      const tenantId = tenantOf(ctx);
      const res = await db.withTenant(tenantId, (tx) =>
        repo.archiveScale(tx, tenantId, ctx.userId, scaleId, archived),
      );
      if (res.result === 'not_found') throw new GradeScaleNotFoundError();
      return res.scale as Row;
    },

    // ---------------------------------------------------------------- the college setting
    async getSettings(ctx: RequestContext) {
      const tenantId = tenantOf(ctx);
      return db.withTenant(tenantId, (tx) => repo.getSettings(tx, tenantId));
    },
    async updateCollegeSettings(ctx: RequestContext, allowSelfApproval: boolean) {
      const tenantId = tenantOf(ctx);
      return db.withTenant(tenantId, (tx) =>
        repo.setSettings(tx, tenantId, ctx.userId, allowSelfApproval),
      );
    },

    async purgeImports(): Promise<number> {
      return db.withoutTenant((conn) => repo.purgeImports(conn, IMPORT_TTL_HOURS));
    },
  };
}
export type GradebookService = ReturnType<typeof createGradebookService>;

import { can } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { ForbiddenError } from '../../core/errors';
import { buildPage, normalizePage, type Page } from '../../core/pagination';
import { newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import { ENTITIES, type EntityKey, type FieldProblem, normalizeField } from './academics.entities';
import {
  AcademicNotFoundError,
  AlreadyInStateError,
  InvalidAcademicValueError,
  mapAcademicsDbError,
  NothingToUpdateError,
} from './academics.errors';
import type { AcademicsRepository, Row } from './academics.repository';

export type { Row } from './academics.repository';

export interface AcademicListInput {
  archived?: 'false' | 'true' | 'all' | undefined;
  limit?: number | undefined;
  after?: string | undefined;
  current?: boolean | undefined;
  /** any of the entity's filter params (departmentId, programId, batchId, academicYearId, admissionYear) */
  [filter: string]: unknown;
}

export function createAcademicsService(deps: {
  db: Pick<Database, 'withTenant'>;
  academicsRepo: AcademicsRepository;
}) {
  const { db, academicsRepo } = deps;

  /** Account-level check, re-done here because services are the source of truth. */
  function tenantFor(ctx: RequestContext, permission: 'academic.read' | 'academic.manage'): string {
    if (!ctx.tenantId || !can(ctx, permission)) throw new ForbiddenError();
    return ctx.tenantId;
  }

  /** Validates and normalizes the body fields (all required on create, any subset on update). */
  function values(key: EntityKey, body: Record<string, unknown>, mode: 'create' | 'update') {
    const e = ENTITIES[key];
    const out: Record<string, unknown> = {};
    const problems: FieldProblem[] = [];
    for (const f of e.fields) {
      if (mode === 'update' && !f.patchable) continue;
      const v = body[f.key];
      if (v === undefined) {
        if (mode === 'create') problems.push({ path: f.key, message: 'is required' });
        continue;
      }
      const r = normalizeField(f, v);
      if ('problem' in r) problems.push({ path: f.key, message: r.problem });
      else out[f.column] = r.value;
    }
    if (problems.length > 0) throw new InvalidAcademicValueError(problems);
    if (mode === 'update' && Object.keys(out).length === 0) throw new NothingToUpdateError();
    return out;
  }

  /** Runs a write and turns the database's constraint errors into API errors. */
  async function guarded<T>(op: 'write' | 'delete', fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapAcademicsDbError(err, op) ?? err;
    }
  }

  async function transition(
    ctx: RequestContext,
    key: EntityKey,
    id: string,
    archive: boolean,
  ): Promise<Row> {
    const tenantId = tenantFor(ctx, 'academic.manage');
    const e = ENTITIES[key];
    const r = await guarded('write', () =>
      db.withTenant(tenantId, (tx) =>
        academicsRepo.setArchived(tx, e, tenantId, id, archive, stamp(ctx)),
      ),
    );
    if (!r.found || !r.row) throw new AcademicNotFoundError(e.singular);
    if (!r.changed) throw new AlreadyInStateError(archive ? 'already_archived' : 'not_archived');
    return r.row;
  }

  const stamp = (ctx: RequestContext) => ({ id: newId(), actorUserId: ctx.userId });

  return {
    /** GET /<entity>: keyset page, `archived` filter and the entity's own filters. */
    async list(ctx: RequestContext, key: EntityKey, input: AcademicListInput): Promise<Page<Row>> {
      const tenantId = tenantFor(ctx, 'academic.read');
      const e = ENTITIES[key];
      const { limit, after } = normalizePage(input);
      const equals: Record<string, string | number> = {};
      for (const f of e.filters) {
        const v = input[f.param];
        if (v !== undefined) equals[f.column] = v as string | number;
      }
      const rows = await db.withTenant(tenantId, (tx) =>
        academicsRepo.list(tx, e, tenantId, {
          limit: limit + 1,
          after,
          archived: input.archived ?? 'false',
          equals,
          current: key === 'academic-years' ? input.current : undefined,
        }),
      );
      return buildPage(
        rows.map((r) => r as Row & { id: string }),
        limit,
      );
    },

    async get(ctx: RequestContext, key: EntityKey, id: string): Promise<Row> {
      const tenantId = tenantFor(ctx, 'academic.read');
      const e = ENTITIES[key];
      const row = await db.withTenant(tenantId, (tx) => academicsRepo.get(tx, e, tenantId, id));
      if (!row) throw new AcademicNotFoundError(e.singular);
      return row;
    },

    async create(ctx: RequestContext, key: EntityKey, body: Record<string, unknown>): Promise<Row> {
      const tenantId = tenantFor(ctx, 'academic.manage');
      const e = ENTITIES[key];
      const vals = values(key, body, 'create');
      return guarded('write', () =>
        db.withTenant(tenantId, (tx) =>
          academicsRepo.create(tx, e, tenantId, newId(), vals, stamp(ctx)),
        ),
      );
    },

    async update(
      ctx: RequestContext,
      key: EntityKey,
      id: string,
      body: Record<string, unknown>,
    ): Promise<Row> {
      const tenantId = tenantFor(ctx, 'academic.manage');
      const e = ENTITIES[key];
      const vals = values(key, body, 'update');
      const row = await guarded('write', () =>
        db.withTenant(tenantId, (tx) =>
          academicsRepo.update(tx, e, tenantId, id, vals, stamp(ctx)),
        ),
      );
      if (!row) throw new AcademicNotFoundError(e.singular);
      return row;
    },

    /** Archive: refused (409) while active children exist; the current academic year cannot be archived. */
    async archive(ctx: RequestContext, key: EntityKey, id: string): Promise<Row> {
      return transition(ctx, key, id, true);
    },

    /** Unarchive: refused (409) while the parent is archived. */
    async unarchive(ctx: RequestContext, key: EntityKey, id: string): Promise<Row> {
      return transition(ctx, key, id, false);
    },

    /** Hard delete: only when nothing references the row (the database refuses otherwise: 409 in_use). */
    async remove(ctx: RequestContext, key: EntityKey, id: string): Promise<void> {
      const tenantId = tenantFor(ctx, 'academic.manage');
      const e = ENTITIES[key];
      const removed = await guarded('delete', () =>
        db.withTenant(tenantId, (tx) => academicsRepo.remove(tx, e, tenantId, id, stamp(ctx))),
      );
      if (!removed) throw new AcademicNotFoundError(e.singular);
    },

    /** The tenant's one current academic year (the previous one stops being current in the same statement). */
    async setCurrent(ctx: RequestContext, id: string): Promise<Row> {
      const tenantId = tenantFor(ctx, 'academic.manage');
      const e = ENTITIES['academic-years'];
      const r = await guarded('write', () =>
        db.withTenant(tenantId, (tx) => academicsRepo.setCurrent(tx, e, tenantId, id, stamp(ctx))),
      );
      if (!r.found || !r.row) throw new AcademicNotFoundError(e.singular);
      return r.row;
    },
  };
}
export type AcademicsService = ReturnType<typeof createAcademicsService>;

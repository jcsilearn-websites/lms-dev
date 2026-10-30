import { can, type Permission, participationsGranting } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { BadRequestError, ForbiddenError } from '../../core/errors';
import { buildPage, normalizePage, type Page } from '../../core/pagination';
import { prefixPattern } from '../../core/search';
import { newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import { MemberNotFoundError } from '../memberships';
import { type AccessSpec, assertAccess } from './courses.access';
import {
  CourseNotFoundError,
  InvalidStatusChangeError,
  mapCourseDbError,
  NothingToChangeError,
  OfferingArchivedError,
  OfferingSectionNotFoundError,
  ParticipantNotFoundError,
} from './courses.errors';
import type { CoursesRepository, ParticipantInput, Row } from './courses.repository';

export type { Row } from './courses.repository';

const CODE = /^[A-Z0-9][A-Z0-9._-]{0,19}$/;
const clean = (s: string) => s.trim().replace(/\s+/g, ' ');

export interface CourseInput {
  code: string;
  title: string;
  description?: string | undefined;
  credits?: number | undefined;
  departmentId?: string | undefined;
}

export interface CourseChange {
  title?: string | undefined;
  description?: string | undefined;
  credits?: number | null | undefined;
  departmentId?: string | null | undefined;
  archived?: boolean | undefined;
}

export interface PageQuery {
  limit?: number | undefined;
  after?: string | undefined;
}

export function createCoursesService(deps: {
  db: Pick<Database, 'withTenant'>;
  coursesRepo: CoursesRepository;
}) {
  const { db, coursesRepo } = deps;

  function tenantFor(ctx: RequestContext, permission: Permission): string {
    if (!ctx.tenantId || !can(ctx, permission)) throw new ForbiddenError();
    return ctx.tenantId;
  }

  /** What the access CTE needs to decide "may THIS caller do `permission` in THIS offering". */
  function spec(ctx: RequestContext, offeringId: string, permission: Permission): AccessSpec {
    if (!ctx.tenantId) throw new ForbiddenError();
    return {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      offeringId,
      viewAll: can(ctx, 'course.read'),
      accountAllowed: can(ctx, permission),
      allowedBy: participationsGranting(permission),
    };
  }

  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapCourseDbError(err) ?? err;
    }
  }

  const stamp = (ctx: RequestContext) => ({ id: newId(), actorUserId: ctx.userId });

  return {
    // ---------------------------------------------------------------- courses
    async listCourses(
      ctx: RequestContext,
      q: PageQuery & {
        q?: string | undefined;
        department?: string | undefined;
        archived?: boolean | undefined;
      },
    ): Promise<Page<Row>> {
      const tenantId = tenantFor(ctx, 'course.read');
      const page = normalizePage(q);
      const rows = await db.withTenant(tenantId, (tx) =>
        coursesRepo.listCourses(
          tx,
          tenantId,
          {
            q: q.q ? prefixPattern(q.q, 1) : undefined,
            department: q.department,
            includeArchived: q.archived === true,
          },
          page,
        ),
      );
      return buildPage(rows as (Row & { id: string })[], page.limit);
    },

    async getCourse(ctx: RequestContext, id: string): Promise<Row> {
      const tenantId = tenantFor(ctx, 'course.read');
      const row = await db.withTenant(tenantId, (tx) => coursesRepo.getCourse(tx, tenantId, id));
      if (!row) throw new CourseNotFoundError();
      return row;
    },

    async createCourse(ctx: RequestContext, input: CourseInput): Promise<Row> {
      const tenantId = tenantFor(ctx, 'course.create');
      const code = input.code.trim().toUpperCase();
      if (!CODE.test(code)) {
        throw new BadRequestError('invalid_value', 'The course code is not valid', [
          { path: 'code', message: 'use letters, digits and . _ - (up to 20 characters)' },
        ]);
      }
      return guarded(() =>
        db.withTenant(tenantId, (tx) =>
          coursesRepo.createCourse(
            tx,
            tenantId,
            {
              id: newId(),
              code,
              title: clean(input.title),
              description: input.description?.trim() ?? '',
              credits: input.credits ?? null,
              departmentId: input.departmentId ?? null,
            },
            stamp(ctx),
          ),
        ),
      );
    },

    async updateCourse(ctx: RequestContext, id: string, change: CourseChange): Promise<Row> {
      const tenantId = tenantFor(ctx, 'course.manage');
      const values: Parameters<CoursesRepository['updateCourse']>[3] = {};
      if (change.title !== undefined) values.title = clean(change.title);
      if (change.description !== undefined) values.description = change.description.trim();
      if (change.credits !== undefined) values.credits = change.credits;
      if (change.departmentId !== undefined) values.department_id = change.departmentId;
      if (change.archived !== undefined) values.archived = change.archived;
      if (Object.keys(values).length === 0) throw new NothingToChangeError();
      const row = await guarded(() =>
        db.withTenant(tenantId, (tx) =>
          coursesRepo.updateCourse(tx, tenantId, id, values, stamp(ctx)),
        ),
      );
      if (!row) throw new CourseNotFoundError();
      return row;
    },

    // ---------------------------------------------------------------- offerings
    async listOfferings(
      ctx: RequestContext,
      q: PageQuery & {
        courseId?: string | undefined;
        termId?: string | undefined;
        status?: string | undefined;
      },
    ): Promise<Page<Row>> {
      const tenantId = tenantFor(ctx, 'course.read');
      const page = normalizePage(q);
      const rows = await db.withTenant(tenantId, (tx) =>
        coursesRepo.listOfferings(
          tx,
          tenantId,
          ctx.userId,
          { courseId: q.courseId, termId: q.termId, status: q.status },
          page,
        ),
      );
      return buildPage(rows as (Row & { id: string })[], page.limit);
    },

    /** The courses I take part in (any member). */
    async listMine(ctx: RequestContext, q: PageQuery): Promise<Page<Row>> {
      if (!ctx.tenantId) throw new ForbiddenError();
      const tenantId = ctx.tenantId;
      const page = normalizePage(q);
      const rows = await db.withTenant(tenantId, (tx) =>
        coursesRepo.listMine(tx, tenantId, ctx.userId, page),
      );
      return buildPage(rows as (Row & { id: string })[], page.limit);
    },

    async getOffering(ctx: RequestContext, id: string): Promise<Row> {
      const a = spec(ctx, id, 'content.view');
      const r = await db.withTenant(a.tenantId, (tx) => coursesRepo.getOffering(tx, a));
      assertAccess(r.acc);
      return r.row as Row;
    },

    async createOffering(
      ctx: RequestContext,
      input: {
        courseId: string;
        termId: string;
        label?: string | undefined;
        titleOverride?: string | undefined;
      },
    ): Promise<Row> {
      const tenantId = tenantFor(ctx, 'offering.manage');
      return guarded(() =>
        db.withTenant(tenantId, (tx) =>
          coursesRepo.createOffering(
            tx,
            tenantId,
            ctx.userId,
            {
              id: newId(),
              courseId: input.courseId,
              termId: input.termId,
              label: clean(input.label ?? ''),
              titleOverride: input.titleOverride ? clean(input.titleOverride) : null,
            },
            stamp(ctx),
          ),
        ),
      );
    },

    async updateOffering(
      ctx: RequestContext,
      id: string,
      change: { label?: string | undefined; titleOverride?: string | null | undefined },
    ): Promise<Row> {
      const change2: Parameters<CoursesRepository['changeOffering']>[2] = {
        fromStatuses: ['draft', 'published'],
      };
      if (change.label !== undefined) change2.label = clean(change.label);
      if (change.titleOverride !== undefined) {
        change2.titleOverride = change.titleOverride === null ? null : clean(change.titleOverride);
      }
      if (change2.label === undefined && change2.titleOverride === undefined)
        throw new NothingToChangeError();
      return runChange(ctx, id, 'offering.manage', change2, 'offering.updated', undefined);
    },

    publish: (ctx: RequestContext, id: string) =>
      runChange(
        ctx,
        id,
        'course.publish',
        { status: 'published', fromStatuses: ['draft'] },
        'offering.published',
        'published',
      ),
    unpublish: (ctx: RequestContext, id: string) =>
      runChange(
        ctx,
        id,
        'course.publish',
        { status: 'draft', fromStatuses: ['published'] },
        'offering.unpublished',
        'draft',
      ),
    archive: (ctx: RequestContext, id: string) =>
      runChange(
        ctx,
        id,
        'offering.manage',
        { status: 'archived', fromStatuses: ['draft', 'published'] },
        'offering.archived',
        'archived',
      ),

    // ---------------------------------------------------------------- sections
    async listSections(ctx: RequestContext, id: string): Promise<Row[]> {
      const a = spec(ctx, id, 'offering.manage');
      const r = await db.withTenant(a.tenantId, (tx) => coursesRepo.listSections(tx, a));
      assertAccess(r.acc);
      return r.rows;
    },

    async addSection(ctx: RequestContext, id: string, sectionId: string): Promise<void> {
      await changeSection(ctx, id, sectionId, 'add');
    },

    async removeSection(ctx: RequestContext, id: string, sectionId: string): Promise<void> {
      await changeSection(ctx, id, sectionId, 'remove');
    },

    // ---------------------------------------------------------------- participants
    async listParticipants(
      ctx: RequestContext,
      id: string,
      q: PageQuery & { participation?: string | undefined; includeRemoved?: boolean | undefined },
    ): Promise<Page<Row>> {
      const a = spec(ctx, id, 'participant.read');
      const page = normalizePage(q);
      const r = await db.withTenant(a.tenantId, (tx) =>
        coursesRepo.listParticipants(
          tx,
          a,
          { participation: q.participation, includeRemoved: q.includeRemoved === true },
          page,
        ),
      );
      assertAccess(r.acc);
      return buildPage(r.rows as (Row & { id: string })[], page.limit);
    },

    async addParticipant(ctx: RequestContext, id: string, input: ParticipantInput): Promise<Row> {
      const a = spec(ctx, id, 'offering.manage');
      const r = await guarded(() =>
        db.withTenant(a.tenantId, (tx) =>
          coursesRepo.upsertParticipant(tx, a, { ...input, id: newId() }, stamp(ctx)),
        ),
      );
      const acc = assertAccess(r.acc);
      if (acc.status === 'archived') throw new OfferingArchivedError();
      if (!r.memberFound) throw new MemberNotFoundError();
      return r.row as Row;
    },

    async changeParticipant(
      ctx: RequestContext,
      id: string,
      participantId: string,
      participation: string,
    ): Promise<Row> {
      return participantChange(ctx, id, participantId, { participation });
    },

    async removeParticipant(ctx: RequestContext, id: string, participantId: string): Promise<void> {
      await participantChange(ctx, id, participantId, { remove: true });
    },

    // ---------------------------------------------------------------- enrolment sync (worker)
    /**
     * Applies the pending enrolment changes of one college in bounded batches (each batch is one transaction
     * that also deletes the pending rows it took), until none are left. Idempotent. A change that arrives
     * during the run is picked up by its next batch or by the job its trigger queued.
     */
    async syncEnrolments(
      tenantId: string,
      opts: {
        batchSize: number;
        maxBatches: number;
        /** batches applied at the same time (each takes DIFFERENT members: the pending rows are claimed with SKIP LOCKED) */
        concurrency?: number | undefined;
        signal?: AbortSignal | undefined;
      },
    ): Promise<{ members: number; batches: number }> {
      let members = 0;
      let batches = 0;
      const lane = async () => {
        while (batches < opts.maxBatches && !opts.signal?.aborted) {
          batches++; // reserved before the work, so lanes never exceed maxBatches together
          const n = await db.withTenant(tenantId, (tx) =>
            coursesRepo.syncBatch(tx, tenantId, opts.batchSize),
          );
          if (n === 0) {
            batches--;
            break;
          }
          members += n;
          if (n < opts.batchSize) break;
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 1) }, lane));
      return { members, batches };
    },
  };

  async function runChange(
    ctx: RequestContext,
    id: string,
    permission: Permission,
    change: Parameters<CoursesRepository['changeOffering']>[2],
    action: string,
    to: string | undefined,
  ): Promise<Row> {
    const a = spec(ctx, id, permission);
    const r = await guarded(() =>
      db.withTenant(a.tenantId, (tx) =>
        coursesRepo.changeOffering(tx, a, change, { ...stamp(ctx), action }),
      ),
    );
    const acc = assertAccess(r.acc);
    if (!r.row) {
      if (acc.status === 'archived') throw new OfferingArchivedError();
      throw new InvalidStatusChangeError(acc.status, to ?? acc.status);
    }
    return r.row;
  }

  async function changeSection(
    ctx: RequestContext,
    id: string,
    sectionId: string,
    op: 'add' | 'remove',
  ): Promise<void> {
    const a = spec(ctx, id, 'offering.manage');
    const r = await guarded(() =>
      db.withTenant(a.tenantId, (tx) => coursesRepo.setSection(tx, a, sectionId, op, stamp(ctx))),
    );
    const acc = assertAccess(r.acc);
    if (acc.status === 'archived') throw new OfferingArchivedError();
    if (!r.sectionFound || !r.changed) throw new OfferingSectionNotFoundError();
  }

  async function participantChange(
    ctx: RequestContext,
    id: string,
    participantId: string,
    change: { participation: string } | { remove: true },
  ): Promise<Row> {
    const a = spec(ctx, id, 'offering.manage');
    const r = await guarded(() =>
      db.withTenant(a.tenantId, (tx) =>
        coursesRepo.changeParticipant(tx, a, participantId, change, stamp(ctx)),
      ),
    );
    const acc = assertAccess(r.acc);
    if (acc.status === 'archived') throw new OfferingArchivedError();
    if (!r.row) throw new ParticipantNotFoundError();
    return r.row;
  }
}
export type CoursesService = ReturnType<typeof createCoursesService>;

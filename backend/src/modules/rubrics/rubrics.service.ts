import { randomBytes } from 'node:crypto';
import type { RubricCriterion, RubricInput } from '../../contracts';
import { can, type Permission, participationsGranting } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { ForbiddenError } from '../../core/errors';
import { buildPage, normalizePage } from '../../core/pagination';
import { newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import { assertCourseAccess, type CourseAccessSpec } from '../courses';
import { InvalidRubricError, RubricNotFoundError } from './rubrics.errors';
import type { RubricsRepository } from './rubrics.repository';

const newKey = () => randomBytes(6).toString('hex');

/**
 * Checks and completes the criteria of a rubric: ids are kept when given (a grade of an older version refers to them) and
 * made when missing; every id is unique; the maximum is the sum, over criteria, of the best level.
 */
export function normalizeCriteria(input: RubricInput['criteria']): {
  criteria: RubricCriterion[];
  maxPoints: number;
} {
  const problems: { path: string; message: string }[] = [];
  const seen = new Set<string>();
  const unique = (id: string | undefined, path: string): string => {
    let k = id ?? newKey();
    if (seen.has(k)) {
      if (id) problems.push({ path, message: 'this id is used twice' });
      k = newKey();
    }
    seen.add(k);
    return k;
  };
  let maxPoints = 0;
  const criteria = input.map((c, i) => {
    const levels = c.levels.map((l, j) => ({
      id: unique(l.id, `criteria[${i}].levels[${j}].id`),
      title: l.title.trim(),
      description: (l.description ?? '').trim(),
      points: Math.round(l.points * 100) / 100,
    }));
    if (new Set(levels.map((l) => l.title.toLowerCase())).size !== levels.length)
      problems.push({ path: `criteria[${i}].levels`, message: 'level titles must differ' });
    for (const [j, l] of levels.entries())
      if (l.title === '')
        problems.push({ path: `criteria[${i}].levels[${j}].title`, message: 'name the level' });
    maxPoints += Math.max(...levels.map((l) => l.points));
    const title = c.title.trim();
    if (title === '')
      problems.push({ path: `criteria[${i}].title`, message: 'name the criterion' });
    return {
      id: unique(c.id, `criteria[${i}].id`),
      title,
      description: (c.description ?? '').trim(),
      levels,
    };
  });
  maxPoints = Math.round(maxPoints * 100) / 100;
  if (maxPoints <= 0)
    problems.push({
      path: 'criteria',
      message: 'the best levels must add up to more than 0 points',
    });
  if (problems.length > 0) throw new InvalidRubricError(problems);
  return { criteria, maxPoints };
}

export function createRubricsService(deps: {
  db: Pick<Database, 'withTenant'>;
  rubricsRepo: RubricsRepository;
}) {
  const { db, rubricsRepo: repo } = deps;

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

  return {
    async list(
      ctx: RequestContext,
      courseId: string,
      q: {
        includeArchived?: boolean | undefined;
        limit?: number | undefined;
        after?: string | undefined;
      },
    ) {
      const a = spec(ctx, courseId, 'rubric.read');
      const page = normalizePage({ limit: q.limit, after: q.after });
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.list(tx, a, {
          includeArchived: q.includeArchived === true,
          limit: page.limit,
          after: page.after ?? null,
        }),
      );
      assertCourseAccess(r.acc);
      return buildPage(r.rows as { id: string }[], page.limit);
    },

    async get(ctx: RequestContext, courseId: string, rubricId: string) {
      const a = spec(ctx, courseId, 'rubric.read');
      const r = await db.withTenant(a.tenantId, (tx) => repo.get(tx, a, rubricId));
      assertCourseAccess(r.acc);
      if (!r.row) throw new RubricNotFoundError();
      return r.row;
    },

    async create(ctx: RequestContext, courseId: string, input: RubricInput) {
      const a = spec(ctx, courseId, 'rubric.manage');
      const { criteria, maxPoints } = normalizeCriteria(input.criteria);
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.create(
          tx,
          a,
          { rubricId: newId(), versionId: newId() },
          { title: input.title.trim(), criteria, maxPoints, userId: ctx.userId },
        ),
      );
      assertCourseAccess(r.acc);
      if (!r.row) throw new RubricNotFoundError();
      return r.row;
    },

    async update(ctx: RequestContext, courseId: string, rubricId: string, input: RubricInput) {
      const a = spec(ctx, courseId, 'rubric.manage');
      const { criteria, maxPoints } = normalizeCriteria(input.criteria);
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.addVersion(tx, a, rubricId, newId(), {
          title: input.title.trim(),
          criteria,
          maxPoints,
          userId: ctx.userId,
        }),
      );
      assertCourseAccess(r.acc);
      if (!r.row) throw new RubricNotFoundError();
      return r.row;
    },

    async archive(ctx: RequestContext, courseId: string, rubricId: string, archived: boolean) {
      const a = spec(ctx, courseId, 'rubric.manage');
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.setArchived(tx, a, rubricId, archived),
      );
      assertCourseAccess(r.acc);
      if (!r.row) throw new RubricNotFoundError();
      return r.row;
    },
  };
}
export type RubricsService = ReturnType<typeof createRubricsService>;

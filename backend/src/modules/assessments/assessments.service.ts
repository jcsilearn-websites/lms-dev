import type { AssessmentFinalScore, AssessmentSettings, SaveRequest } from '../../contracts';
import { MAX_ATTEMPT_QUESTIONS } from '../../contracts';
import { can, type Permission, participationsGranting } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { ForbiddenError } from '../../core/errors';
import { newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import { pgConstraint, pgErrorCode } from '../../db/pg-errors';
import {
  type AccessSpec,
  assertAccess,
  OfferingNotFoundError,
  ParticipantNotFoundError,
} from '../courses';
import type { FilesService } from '../files';
import {
  AnswerNotFoundError,
  AssessmentClosedError,
  AssessmentNotFoundError,
  AssessmentNotOpenError,
  AttemptInProgressError,
  AttemptNotFoundError,
  EmptyAssessmentError,
  InvalidSettingsError,
  InvalidSlotsError,
  NoAttemptsLeftError,
  PoolTooSmallError,
  RegradeOptionsChangedError,
  RegradeVersionError,
  ScoreOutOfRangeError,
} from './assessments.errors';
import type { AssessmentsRepository, Row, SettingsPatch, SlotRow } from './assessments.repository';

export type { Row } from './assessments.repository';

export interface AssessmentsConfig {
  /** answers are accepted this long after the server deadline */
  graceSeconds: number;
  /** attempts closed per statement by the sweeper */
  sweepBatch: number;
}
const DEFAULT_CONFIG: AssessmentsConfig = { graceSeconds: 30, sweepBatch: 200 };

const MAX_SWEEP_BATCHES = 100;

export function createAssessmentsService(deps: {
  db: Pick<Database, 'withTenant' | 'withoutTenant'>;
  assessmentsRepo: AssessmentsRepository;
  filesService: Pick<FilesService, 'downloadTarget'>;
  config?: Partial<AssessmentsConfig>;
}) {
  const { db, assessmentsRepo: repo, filesService } = deps;
  const config: AssessmentsConfig = { ...DEFAULT_CONFIG, ...deps.config };

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
  const tenantOf = (ctx: RequestContext): string => {
    if (!ctx.tenantId) throw new ForbiddenError();
    return ctx.tenantId;
  };

  /** Maps the verdict of a learner function to the answers every offering route gives. */
  function learnerVerdict(result: unknown): void {
    switch (result) {
      case 'ok':
        return;
      case 'no_offering':
        throw new OfferingNotFoundError();
      case 'forbidden':
        throw new ForbiddenError();
      case 'not_open':
        throw new AssessmentNotOpenError();
      case 'closed':
        throw new AssessmentClosedError();
      case 'no_attempts_left':
        throw new NoAttemptsLeftError();
      case 'empty':
        throw new EmptyAssessmentError();
      case 'pool_too_small':
        throw new PoolTooSmallError();
      case 'not_found':
        throw new AttemptNotFoundError();
      default:
        throw new AssessmentNotFoundError();
    }
  }

  /**
   * A learner call found no such attempt. Someone who takes no part in the offering is told what every offering route
   * tells them (404 offering_not_found: its existence is not revealed); a participant lacking the permission gets 403;
   * only a real participant hears "no such attempt". One extra read, on the failure path only.
   */
  async function missing(ctx: RequestContext, offeringId: string): Promise<never> {
    const a = spec(ctx, offeringId, 'submission.create');
    const acc = await db.withTenant(a.tenantId, (tx) => repo.offeringAccess(tx, a));
    assertAccess(acc);
    throw new AttemptNotFoundError();
  }

  /** when the request reached the server (core/deadline.ts), for the deadline checks of the database functions */
  const arrivalOf = (ctx: RequestContext) =>
    ctx.arrival
      ? { at: new Date(ctx.arrival.atMs), maxAgeSeconds: ctx.arrival.maxAgeSeconds }
      : null;

  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

  return {
    // ================================================================ configuration
    async config(ctx: RequestContext, offeringId: string, itemId: string) {
      const a = spec(ctx, offeringId, 'assessment.create');
      const r = await db.withTenant(a.tenantId, (tx) => repo.getConfig(tx, a, itemId));
      assertAccess(r.acc);
      if (!r.row) throw new AssessmentNotFoundError();
      const slots = (r.row.slots as { count: number; points: number }[]) ?? [];
      return {
        ...r.row,
        totalPoints: slots.reduce((s, x) => s + Number(x.count) * Number(x.points), 0),
        questionCount: slots.reduce((s, x) => s + Number(x.count), 0),
      };
    },

    async updateSettings(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      patch: Partial<AssessmentSettings>,
    ) {
      const a = spec(ctx, offeringId, 'assessment.create');
      if (Object.keys(patch).length === 0) throw new InvalidSettingsError('Nothing to change');
      const p: SettingsPatch = { ...patch } as SettingsPatch;
      if (p.opensAt && p.closesAt && new Date(p.closesAt) <= new Date(p.opensAt))
        throw new InvalidSettingsError('The assessment must close after it opens');
      try {
        const r = await db.withTenant(a.tenantId, (tx) => repo.updateSettings(tx, a, itemId, p));
        assertAccess(r.acc);
        if (!r.settings) throw new AssessmentNotFoundError();
        return r.settings;
      } catch (err) {
        if (pgErrorCode(err) === '23514') {
          const c = pgConstraint(err);
          throw new InvalidSettingsError(
            c === 'assessments_after_close_ck'
              ? 'Showing results or answers "after close" needs a close date'
              : c === 'assessments_window_ck'
                ? 'The assessment must close after it opens'
                : 'These settings are not valid',
          );
        }
        throw err;
      }
    },

    async replaceSlots(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      input: {
        kind: 'fixed' | 'pool';
        questionId?: string | undefined;
        tag?: string | undefined;
        difficulty?: 'easy' | 'medium' | 'hard' | undefined;
        count?: number | undefined;
        points: number;
      }[],
    ) {
      const a = spec(ctx, offeringId, 'assessment.create');
      const problems: { path: string; message: string }[] = [];
      const slots: SlotRow[] = input.map((s, i) => {
        if (s.kind === 'fixed' && !s.questionId)
          problems.push({ path: `slots[${i}].questionId`, message: 'choose the question' });
        if (s.kind === 'fixed' && (s.tag || s.difficulty || (s.count ?? 1) !== 1))
          problems.push({
            path: `slots[${i}]`,
            message: 'a fixed question has no tag, difficulty or count',
          });
        if (s.kind === 'pool' && s.questionId)
          problems.push({
            path: `slots[${i}].questionId`,
            message: 'a pool draws by tag and difficulty',
          });
        return {
          position: i + 1,
          kind: s.kind,
          questionId: s.kind === 'fixed' ? (s.questionId ?? null) : null,
          tag: s.kind === 'pool' ? (s.tag?.trim().toLowerCase() ?? null) : null,
          difficulty: s.kind === 'pool' ? (s.difficulty ?? null) : null,
          count: s.kind === 'pool' ? (s.count ?? 1) : 1,
          points: s.points,
        };
      });
      if (slots.reduce((n, s) => n + s.count, 0) > MAX_ATTEMPT_QUESTIONS)
        problems.push({
          path: 'slots',
          message: `an assessment has at most ${MAX_ATTEMPT_QUESTIONS} questions`,
        });
      if (problems.length > 0) throw new InvalidSlotsError(problems);
      const r = await db.withTenant(a.tenantId, (tx) => repo.replaceSlots(tx, a, itemId, slots));
      assertAccess(r.acc);
      if (!r.found) throw new AssessmentNotFoundError();
      if (!r.questionsOk)
        throw new InvalidSlotsError([
          { path: 'slots', message: 'a question is not in the course of this offering' },
        ]);
      return { slots: slots.length };
    },

    async preview(ctx: RequestContext, offeringId: string, itemId: string) {
      const a = spec(ctx, offeringId, 'assessment.create');
      try {
        const r = await db.withTenant(a.tenantId, (tx) => repo.preview(tx, a, itemId));
        assertAccess(r.acc);
        if (!r.found) throw new AssessmentNotFoundError();
        return { questions: r.questions };
      } catch (err) {
        if (pgErrorCode(err) === 'LMS01') throw new PoolTooSmallError();
        throw err;
      }
    },

    // ================================================================ accommodations
    async accommodations(ctx: RequestContext, offeringId: string, itemId: string) {
      const a = spec(ctx, offeringId, 'assessment.view_accommodations');
      const r = await db.withTenant(a.tenantId, (tx) => repo.accommodations(tx, a, itemId));
      assertAccess(r.acc);
      if (!r.found) throw new AssessmentNotFoundError();
      return { items: r.rows };
    },

    async setAccommodation(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      participantId: string,
      v: {
        extraMinutes: number;
        extendedCloseAt?: string | null | undefined;
        reason?: string | null | undefined;
      },
    ) {
      const a = spec(ctx, offeringId, 'assessment.create');
      const reason = v.reason?.trim() ? v.reason.trim() : null;
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.setAccommodation(tx, a, itemId, participantId, {
          extraMinutes: v.extraMinutes,
          extendedCloseAt: v.extendedCloseAt ?? null,
          reason,
        }),
      );
      assertAccess(r.acc);
      if (!r.found) throw new AssessmentNotFoundError();
      if (!r.participantOk) throw new ParticipantNotFoundError();
      if (!r.row) throw new AssessmentNotFoundError();
      return r.row;
    },

    async removeAccommodation(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      participantId: string,
    ) {
      const a = spec(ctx, offeringId, 'assessment.create');
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.removeAccommodation(tx, a, itemId, participantId),
      );
      assertAccess(r.acc);
      if (!r.found || !r.removed) throw new AssessmentNotFoundError();
    },

    // ================================================================ the learner (2 round trips with the session lookup)
    async me(ctx: RequestContext, offeringId: string, itemId: string) {
      const tenantId = tenantOf(ctx);
      const r = await db.withoutTenant((conn) =>
        repo.me(conn, {
          tenantId,
          userId: ctx.userId,
          offeringId,
          itemId,
          grace: config.graceSeconds,
        }),
      );
      learnerVerdict(r.result);
      return r;
    },

    async start(ctx: RequestContext, offeringId: string, itemId: string) {
      const tenantId = tenantOf(ctx);
      const r = await db.withoutTenant((conn) =>
        repo.start(conn, {
          tenantId,
          userId: ctx.userId,
          offeringId,
          itemId,
          grace: config.graceSeconds,
        }),
      );
      learnerVerdict(r.result);
      return { attemptId: r.attemptId as string, resumed: r.resumed === true };
    },

    async readAttempt(ctx: RequestContext, offeringId: string, attemptId: string) {
      const tenantId = tenantOf(ctx);
      const r = await db.withoutTenant((conn) =>
        repo.readAttempt(conn, {
          tenantId,
          userId: ctx.userId,
          offeringId,
          attemptId,
          grace: config.graceSeconds,
        }),
      );
      if (r.result === 'not_found') return missing(ctx, offeringId);
      learnerVerdict(r.result);
      return { attempt: r.attempt, questions: r.questions };
    },

    /** Autosave: a batch of changed answers (and integrity events). One definer call. */
    async save(ctx: RequestContext, offeringId: string, attemptId: string, body: SaveRequest) {
      const tenantId = tenantOf(ctx);
      const r = await db.withoutTenant((conn) =>
        repo.save(conn, {
          tenantId,
          userId: ctx.userId,
          offeringId,
          attemptId,
          grace: config.graceSeconds,
          arrival: arrivalOf(ctx),
          answers: body.answers.map((x) => ({
            p: x.position,
            a: x.answer,
            rev: x.rev,
            f: x.flagged ?? false,
            at: x.at,
            ms: x.spentMs ?? 0,
          })),
          events: (body.events ?? []).map((e) => ({ k: e.kind, t: e.at })),
        }),
      );
      if (r.result === 'not_found') return missing(ctx, offeringId);
      return {
        result: r.result as 'ok' | 'submitted' | 'closed',
        applied: Number(r.applied ?? 0),
        stale: (r.stale as Row[] | undefined) ?? [],
        serverNow: (r.serverNow as string | undefined) ?? null,
        deadlineAt: (r.deadlineAt as string | undefined) ?? null,
      };
    },

    async submit(ctx: RequestContext, offeringId: string, attemptId: string) {
      const tenantId = tenantOf(ctx);
      const r = await db.withoutTenant((conn) =>
        repo.submit(conn, {
          tenantId,
          userId: ctx.userId,
          offeringId,
          attemptId,
          grace: config.graceSeconds,
          arrival: arrivalOf(ctx),
        }),
      );
      if (r.result === 'not_found') return missing(ctx, offeringId);
      learnerVerdict(r.result);
      return {
        status: r.status as 'submitted' | 'graded',
        submittedAt: iso(r.submittedAt) as string,
      };
    },

    async result(ctx: RequestContext, offeringId: string, attemptId: string) {
      const tenantId = tenantOf(ctx);
      const r = await db.withoutTenant((conn) =>
        repo.result(conn, { tenantId, userId: ctx.userId, offeringId, attemptId }),
      );
      if (r.result === 'not_found') return missing(ctx, offeringId);
      if (r.result === 'in_progress') throw new AttemptInProgressError();
      learnerVerdict(r.result === 'not_released' ? 'ok' : r.result);
      return {
        result: r.result,
        attempt: r.attempt,
        questions: (r.questions as Row[] | undefined) ?? [],
      };
    },

    /** The row of an image shown in THIS learner's attempt, as a signed download. */
    async attemptImage(ctx: RequestContext, offeringId: string, attemptId: string, fileId: string) {
      const tenantId = tenantOf(ctx);
      const file = await db.withTenant(tenantId, (tx) =>
        repo.attemptFile(tx, { tenantId, userId: ctx.userId, offeringId, attemptId, fileId }),
      );
      if (!file) return missing(ctx, offeringId);
      return filesService.downloadTarget(
        file as { storage_key: string; original_name: string; content_type: string },
      );
    },

    // ================================================================ instructors and assistants
    async attempts(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      q: { status?: string | undefined; limit?: number | undefined; after?: string | undefined },
    ) {
      const a = spec(ctx, offeringId, 'submission.grade');
      const limit = q.limit ?? 50;
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.attempts(tx, a, itemId, { status: q.status ?? null, limit, after: q.after ?? null }),
      );
      assertAccess(r.acc);
      if (!r.found) throw new AssessmentNotFoundError();
      const more = r.rows.length > limit;
      const rows = more ? r.rows.slice(0, limit) : r.rows;
      return {
        items: rows,
        nextCursor: more ? ((rows.at(-1)?.attemptId as string | undefined) ?? null) : null,
      };
    },

    async gradingSummary(ctx: RequestContext, offeringId: string, itemId: string) {
      const a = spec(ctx, offeringId, 'submission.grade');
      const r = await db.withTenant(a.tenantId, (tx) => repo.gradingSummary(tx, a, itemId));
      assertAccess(r.acc);
      if (!r.found) throw new AssessmentNotFoundError();
      return { questions: r.rows, attemptsToGrade: r.attemptsToGrade };
    },

    async gradingAnswers(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      q: {
        questionId: string;
        state?: 'pending' | 'graded' | 'all' | undefined;
        limit?: number | undefined;
        after?: string | undefined;
      },
    ) {
      const a = spec(ctx, offeringId, 'submission.grade');
      const limit = q.limit ?? 25;
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.gradingAnswers(tx, a, itemId, {
          questionId: q.questionId,
          state: q.state ?? 'pending',
          limit,
          after: q.after ?? null,
        }),
      );
      assertAccess(r.acc);
      if (!r.found || !r.question) throw new AssessmentNotFoundError();
      const more = r.rows.length > limit;
      const rows = more ? r.rows.slice(0, limit) : r.rows;
      return {
        question: r.question,
        items: rows,
        nextCursor: more ? ((rows.at(-1)?.attemptId as string | undefined) ?? null) : null,
      };
    },

    async script(ctx: RequestContext, offeringId: string, attemptId: string) {
      const a = spec(ctx, offeringId, 'submission.grade');
      const r = await db.withTenant(a.tenantId, (tx) => repo.script(tx, a, attemptId));
      assertAccess(r.acc);
      if (!r.row) throw new AttemptNotFoundError();
      return r.row;
    },

    async grade(
      ctx: RequestContext,
      offeringId: string,
      attemptId: string,
      position: number,
      v: { score: number; feedback?: string | null | undefined },
    ) {
      const a = spec(ctx, offeringId, 'submission.grade');
      const feedback = v.feedback?.trim() ? v.feedback.trim() : null;
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.grade(tx, a, attemptId, position, {
          score: Math.round(v.score * 100) / 100,
          feedback,
        }),
      );
      assertAccess(r.acc);
      if (!r.found) throw new AnswerNotFoundError();
      if (!r.scoreOk || !r.row) throw new ScoreOutOfRangeError();
      return {
        attemptId,
        position,
        score: Math.round(v.score * 100) / 100,
        attemptStatus: r.row.status as 'submitted' | 'graded',
        attemptScore: r.row.score == null ? null : Number(r.row.score),
        pendingManual: Number(r.row.pending_manual),
      };
    },

    async setFeedback(
      ctx: RequestContext,
      offeringId: string,
      attemptId: string,
      feedback: string | null,
    ) {
      const a = spec(ctx, offeringId, 'submission.grade');
      const text = feedback?.trim() ? feedback.trim() : null;
      const r = await db.withTenant(a.tenantId, (tx) => repo.setFeedback(tx, a, attemptId, text));
      assertAccess(r.acc);
      if (!r.found) throw new AttemptNotFoundError();
    },

    async regrade(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      v: {
        questionId: string;
        action: 'rekey' | 'drop' | 'credit';
        toVersionId?: string | undefined;
        dryRun: boolean;
      },
    ) {
      const a = spec(ctx, offeringId, 'grade.finalize');
      if (v.action === 'rekey' && !v.toVersionId) throw new RegradeVersionError();
      const runId = newId();
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.regrade(tx, a, itemId, {
          runId,
          questionId: v.questionId,
          action: v.action,
          toVersionId: v.action === 'rekey' ? (v.toVersionId ?? null) : null,
          dryRun: v.dryRun,
          userId: ctx.userId,
        }),
      );
      assertAccess(r.acc);
      if (!r.found) throw new AssessmentNotFoundError();
      if (!r.versionOk) throw new RegradeVersionError();
      if (!r.compatible) throw new RegradeOptionsChangedError();
      const s = r.summary ?? {};
      const affected = Number(s.affectedAttempts ?? 0);
      return {
        applied: !v.dryRun && affected > 0,
        runId: !v.dryRun && affected > 0 ? runId : null,
        affectedAttempts: affected,
        changedScores: Number(s.changedScores ?? 0),
        averageBefore: s.averageBefore == null ? null : Number(s.averageBefore),
        averageAfter: s.averageAfter == null ? null : Number(s.averageAfter),
        changes: (s.changes as Row[] | undefined) ?? [],
      };
    },

    async regrades(ctx: RequestContext, offeringId: string, itemId: string) {
      const a = spec(ctx, offeringId, 'grade.finalize');
      const r = await db.withTenant(a.tenantId, (tx) => repo.regrades(tx, a, itemId));
      assertAccess(r.acc);
      if (!r.found) throw new AssessmentNotFoundError();
      return { items: r.rows };
    },

    async release(ctx: RequestContext, offeringId: string, itemId: string, attemptIds?: string[]) {
      const a = spec(ctx, offeringId, 'grade.finalize');
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.release(tx, a, itemId, attemptIds ?? null),
      );
      assertAccess(r.acc);
      if (!r.found) throw new AssessmentNotFoundError();
      return { released: r.released, stillPending: r.stillPending };
    },

    async analysis(ctx: RequestContext, offeringId: string, itemId: string) {
      const a = spec(ctx, offeringId, 'assessment.analyze');
      const r = await db.withTenant(a.tenantId, (tx) => repo.analysis(tx, a, itemId));
      assertAccess(r.acc);
      if (!r.found || !r.data) throw new AssessmentNotFoundError();
      return r.data;
    },

    // ================================================================ for other modules and the worker
    /**
     * The interface the gradebook (step 11) consumes: the score that counts per learner and assessment of an offering
     * (highest / latest / average of the fully graded attempts, as each assessment says). The caller has checked access.
     */
    async finalScores(tenantId: string, offeringId: string): Promise<AssessmentFinalScore[]> {
      const rows = await db.withTenant(tenantId, (tx) =>
        repo.finalScores(tx, tenantId, offeringId),
      );
      return rows.map((r) => ({
        itemId: r.item_id as string,
        participantId: r.participant_id as string,
        attemptsGraded: Number(r.attempts_graded),
        score: Number(r.score),
        maxScore: Number(r.max_score),
        percent: Number(r.percent),
        scoring: r.scoring as 'highest',
        released: r.released === true,
        passingScore: r.passing_score == null ? null : Number(r.passing_score),
      }));
    },

    /** Worker: closes (auto-submits) every attempt past deadline + grace, in batches, until a short batch. */
    async sweep(signal?: AbortSignal): Promise<number> {
      let closed = 0;
      for (let i = 0; i < MAX_SWEEP_BATCHES && !signal?.aborted; i++) {
        const n = await db.withoutTenant((conn) =>
          repo.sweep(conn, config.sweepBatch, config.graceSeconds),
        );
        closed += n;
        if (n < config.sweepBatch) break;
      }
      return closed;
    },
  };
}
export type AssessmentsService = ReturnType<typeof createAssessmentsService>;

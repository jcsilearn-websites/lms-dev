import type pg from 'pg';
import type { TestApp } from './app';
import {
  addAssessment,
  addQuestion,
  fixed,
  learnerOption,
  posOf,
  q,
  readAttempt,
  save,
  startAttempt,
  submit,
} from './assessments-helpers';
import {
  addAssignment,
  classOf,
  handIn,
  keyFromDb,
  minutesAgo,
  queue,
  setDates,
} from './assignments-helpers';
import type { TestClient } from './client';
import type { Structure } from './courses-helpers';
import { type Json, ok, type Person } from './courses-helpers';
import type { AuthFixture } from './support';

// Shared setup of the step 11 tests (gradebook).

export type Class = Awaited<ReturnType<typeof classOf>> & { tenantId: string };

export async function gradebookClass(
  owner: pg.Pool,
  t: TestApp,
  A: AuthFixture,
  admin: TestClient,
  st: Structure,
  names: string[],
): Promise<Class> {
  const c = await classOf(owner, t, A, admin, st, names);
  return { ...c, tenantId: A.tenantId };
}

export const gb = (offeringId: string) => `/offerings/${offeringId}/gradebook`;

/** The participant ids of the learners by e-mail order of `learners`. */
export async function participantIds(owner: pg.Pool, offeringId: string, learners: Person[]) {
  const out: string[] = [];
  for (const l of learners) {
    const { rows } = await owner.query(
      `SELECT p.id FROM lms.course_participants p
         JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
        WHERE p.offering_id = $1 AND m.user_id = $2`,
      [offeringId, l.userId],
    );
    out.push(rows[0].id);
  }
  return out;
}

export interface DbCategory {
  name: string;
  weight: number;
  dropLowest?: number;
  missing?: 'exclude' | 'zero_after_due';
}
export interface DbManual {
  title: string;
  points: number;
  category: string;
  extra?: boolean;
  dueAt?: string | null;
  released?: boolean;
  assistants?: boolean;
}

/** Configures the gradebook of an offering straight in the database (owner connection): fast and exact for calc tests. */
export async function configureDb(
  owner: pg.Pool,
  tenantId: string,
  offeringId: string,
  o: {
    weighted?: boolean;
    outOf?: number;
    roundMode?: string;
    roundDecimals?: number;
    categories: DbCategory[];
    manual: DbManual[];
    scale?: { min: number; label: string; pass?: boolean }[];
  },
): Promise<{
  gradebookId: string;
  categoryIds: Record<string, string>;
  itemIds: Record<string, string>;
}> {
  const { rows } = await owner.query(
    'SELECT id FROM lms.gradebooks WHERE tenant_id = $1 AND offering_id = $2',
    [tenantId, offeringId],
  );
  const gid = rows[0].id as string;
  await owner.query(
    'DELETE FROM lms.gradebook_categories WHERE tenant_id = $1 AND gradebook_id = $2 AND NOT EXISTS (SELECT 1 FROM lms.gradebook_items i WHERE i.category_id = gradebook_categories.id)',
    [tenantId, gid],
  );
  const categoryIds: Record<string, string> = {};
  let pos = 0;
  for (const c of o.categories) {
    const r = await owner.query(
      `INSERT INTO lms.gradebook_categories (id, tenant_id, gradebook_id, name, weight, drop_lowest, missing_policy, position)
       VALUES (lms.uuid_v7(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [tenantId, gid, c.name, c.weight, c.dropLowest ?? 0, c.missing ?? 'exclude', ++pos],
    );
    categoryIds[c.name] = r.rows[0].id;
  }
  const itemIds: Record<string, string> = {};
  pos = 0;
  for (const m of o.manual) {
    const r = await owner.query(
      `INSERT INTO lms.gradebook_items (id, tenant_id, gradebook_id, category_id, source, title, points, extra_credit, position,
                                        due_at, released, assistants_may_enter)
       VALUES (lms.uuid_v7(), $1, $2, $3, 'manual', $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        tenantId,
        gid,
        categoryIds[m.category],
        m.title,
        m.points,
        m.extra ?? false,
        ++pos,
        m.dueAt ?? null,
        m.released ?? false,
        m.assistants ?? false,
      ],
    );
    itemIds[m.title] = r.rows[0].id;
  }
  let scaleId: string | null = null;
  if (o.scale) {
    const s = await owner.query(
      `INSERT INTO lms.grade_scales (id, tenant_id, name, created_by) VALUES (lms.uuid_v7(), $1, $2, (SELECT id FROM lms.users LIMIT 1)) RETURNING id`,
      [tenantId, `scale-${Math.random().toString(36).slice(2, 8)}`],
    );
    scaleId = s.rows[0].id;
    for (const b of o.scale)
      await owner.query(
        'INSERT INTO lms.grade_scale_bands (tenant_id, scale_id, min_percent, label, is_pass) VALUES ($1, $2, $3, $4, $5)',
        [tenantId, scaleId, b.min, b.label, b.pass ?? true],
      );
  }
  await owner.query(
    `UPDATE lms.gradebooks SET weighted = $3, out_of = $4, round_mode = $5, round_decimals = $6, scale_id = coalesce($7, scale_id)
      WHERE tenant_id = $1 AND id = $2`,
    [
      tenantId,
      gid,
      o.weighted ?? true,
      o.outOf ?? 100,
      o.roundMode ?? 'half_up',
      o.roundDecimals ?? 0,
      scaleId,
    ],
  );
  return { gradebookId: gid, categoryIds, itemIds };
}

/** Empties a gradebook (marks, overrides, items, categories, snapshots are left alone) so a test can configure it again. */
export async function resetGradebook(owner: pg.Pool, tenantId: string, offeringId: string) {
  await owner.query(
    `DELETE FROM lms.manual_marks WHERE tenant_id = $1 AND item_id IN (
       SELECT i.id FROM lms.gradebook_items i JOIN lms.gradebooks g ON g.tenant_id = i.tenant_id AND g.id = i.gradebook_id
        WHERE g.offering_id = $2)`,
    [tenantId, offeringId],
  );
  await owner.query(
    `DELETE FROM lms.grade_overrides WHERE tenant_id = $1 AND gradebook_id = (SELECT id FROM lms.gradebooks WHERE tenant_id = $1 AND offering_id = $2)`,
    [tenantId, offeringId],
  );
  await owner.query(
    `DELETE FROM lms.gradebook_items WHERE tenant_id = $1 AND gradebook_id = (SELECT id FROM lms.gradebooks WHERE tenant_id = $1 AND offering_id = $2)`,
    [tenantId, offeringId],
  );
  await owner.query(
    `DELETE FROM lms.gradebook_categories WHERE tenant_id = $1 AND gradebook_id = (SELECT id FROM lms.gradebooks WHERE tenant_id = $1 AND offering_id = $2)`,
    [tenantId, offeringId],
  );
}

export async function setOverrideDb(
  owner: pg.Pool,
  tenantId: string,
  gradebookId: string,
  participantId: string,
  itemId: string | null,
  points: number | string,
) {
  await owner.query(
    `INSERT INTO lms.grade_overrides (id, tenant_id, gradebook_id, participant_id, item_id, points, reason, set_by)
     VALUES (lms.uuid_v7(), $1, $2, $3, $4, $5, 'test override', (SELECT id FROM lms.users LIMIT 1))`,
    [tenantId, gradebookId, participantId, itemId, points],
  );
}

export async function setMark(
  owner: pg.Pool,
  tenantId: string,
  itemId: string,
  participantId: string,
  points: number | string,
) {
  await owner.query(
    `INSERT INTO lms.manual_marks (tenant_id, item_id, participant_id, points, entered_by)
     VALUES ($1, $2, $3, $4, (SELECT id FROM lms.users LIMIT 1))
     ON CONFLICT (tenant_id, item_id, participant_id) DO UPDATE SET points = EXCLUDED.points`,
    [tenantId, itemId, participantId, points],
  );
}

export interface Computed {
  participant_id: string;
  cells: Record<string, [string, string | null, number]>;
  cats: Json;
  final_marks: string | null;
  final_percent: string | null;
  grade: string | null;
  is_pass: boolean | null;
  overridden: boolean;
  explanation: Json;
}

export async function compute(
  owner: pg.Pool,
  tenantId: string,
  offeringId: string,
  mode: 'staff' | 'learner' = 'staff',
  participants: string[] | null = null,
  explain = false,
): Promise<Computed[]> {
  const { rows } = await owner.query(
    'SELECT * FROM lms.gradebook_compute($1, $2, $3, $4::uuid[], $5)',
    [tenantId, offeringId, mode, participants, explain],
  );
  return rows;
}

export { ok };

export const base = (offeringId: string) => `/offerings/${offeringId}/gradebook`;

/**
 * A quiz of ONE auto-graded 10-point question. `answers[i]` is learner i's answer: true = right, false = wrong, null = no attempt.
 * `settings` goes to the assessment (e.g. { resultsVisibility: 'manual' }). Returns the content item.
 */
export async function quiz(
  e: Class,
  title: string,
  answers: (boolean | null)[],
  settings: Json = {},
): Promise<Json> {
  const stem = `Question of ${title}`;
  const qn = await addQuestion(
    e.instructor.client,
    e.courseId,
    q.single(stem, ['right', 'wrong'], 0),
  );
  const item = await addAssessment(e, { title, settings, slots: [fixed(qn.id, 10)] });
  for (const [i, l] of e.learners.entries()) {
    const a = answers[i];
    if (a === null || a === undefined) continue;
    const s = await startAttempt(e, l, item.id);
    const att = await readAttempt(e, l, s.attemptId);
    ok(
      await save(e, l, s.attemptId, [
        {
          position: posOf(att, stem),
          answer: { o: [learnerOption(att, stem, a ? 'right' : 'wrong')] },
          rev: 1,
          at: 1,
        },
      ]),
    );
    ok(await submit(e, l, s.attemptId));
  }
  return item;
}

export const releaseQuiz = async (e: Class, itemId: string) =>
  ok(
    await e.instructor.client.post(
      `/offerings/${e.offeringId}/items/${itemId}/assessment/release`,
      {},
    ),
  );

/**
 * An assignment out of `max` points. `raw[i]` is learner i's raw score (null = nothing handed in). The due date is moved to the
 * past after the hand-ins, so the deadline has passed. `release`: release every grade now.
 */
export async function assignment(
  owner: pg.Pool,
  e: Class,
  title: string,
  raw: (number | null)[],
  opts: { max?: number; release?: boolean; dueInPast?: boolean; settings?: Json } = {},
): Promise<Json> {
  const item = await addAssignment(e, {
    title,
    settings: { maxPoints: opts.max ?? 100, ...(opts.settings ?? {}) },
  });
  const ic = e.instructor.client;
  const b = `/offerings/${e.offeringId}/items/${item.id}/assignment`;
  for (const [i, l] of e.learners.entries())
    if (raw[i] !== null && raw[i] !== undefined) ok(await handIn(e, l, item.id));
  await queue(e, e.instructor, item.id);
  for (const [i, l] of e.learners.entries()) {
    const score = raw[i];
    if (score === null || score === undefined) continue;
    const { key } = await keyFromDb(owner, item.id, l);
    const sid = ok(await ic.get(`${b}/grading/learners/${key}`)).submissions[0].id;
    ok(
      await ic.put(`${b}/grading/learners/${key}/grade`, {
        submissionId: sid,
        rawScore: score,
        feedback: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ok' }] }],
        },
      }),
    );
  }
  if (opts.release) ok(await ic.post(`${b}/release`, {}));
  if (opts.dueInPast)
    await setDates(owner, item.id, { opensAt: null, dueAt: minutesAgo(60), cutoffAt: null });
  return item;
}

import type pg from 'pg';
import type { TestApp } from './app';
import type { TestClient } from './client';
import {
  doc,
  type Json,
  newCourse,
  newOffering,
  ok,
  type Person,
  person,
  type Structure,
} from './courses-helpers';
import type { AuthFixture } from './support';

// Shared setup of the step 9 tests (question bank, assessments, attempts, grading).

export interface Exam {
  courseId: string;
  offeringId: string;
  moduleId: string;
  instructor: Person;
  assistant: Person;
  learners: Person[];
}

/** A published offering with an instructor, an assistant, `learners` learners and one published module. */
export async function exam(
  owner: pg.Pool,
  t: TestApp,
  A: AuthFixture,
  admin: TestClient,
  st: Structure,
  learners = 2,
): Promise<Exam> {
  const c = await newCourse(admin);
  const o = await newOffering(admin, c.id, st.termId);
  const instructor = await person(owner, t, A, 'Instructor');
  const assistant = await person(owner, t, A, 'Assistant');
  const ls: Person[] = [];
  for (let i = 0; i < learners; i++) ls.push(await person(owner, t, A, `Learner${i + 1}`));
  for (const [p, participation] of [
    [instructor, 'instructor'],
    [assistant, 'assistant'],
    ...ls.map((l) => [l, 'learner'] as const),
  ] as const) {
    ok(await admin.post(`/offerings/${o.id}/participants`, { userId: p.userId, participation }));
  }
  ok(await instructor.client.post(`/offerings/${o.id}/publish`));
  const m = ok(await instructor.client.post(`/offerings/${o.id}/modules`, { title: 'Week 1' }));
  ok(await instructor.client.patch(`/offerings/${o.id}/modules/${m.id}`, { published: true }));
  return {
    courseId: c.id,
    offeringId: o.id,
    moduleId: m.id,
    instructor,
    assistant,
    learners: ls,
  };
}

const text = (t: string) => doc(t);

/** Input of a question of each kind; `over` is merged on top. */
export const q = {
  single: (stem: string, options: string[], correct: number, over: Json = {}): Json => ({
    type: 'single_choice',
    stem: text(stem),
    options: options.map((o, i) => ({ text: text(o), correct: i === correct })),
    ...over,
  }),
  multi: (stem: string, options: string[], correct: number[], over: Json = {}): Json => ({
    type: 'multiple_choice',
    stem: text(stem),
    options: options.map((o, i) => ({ text: text(o), correct: correct.includes(i) })),
    ...over,
  }),
  tf: (stem: string, isTrue: boolean, over: Json = {}): Json => ({
    type: 'true_false',
    stem: text(stem),
    trueIsCorrect: isTrue,
    ...over,
  }),
  numeric: (stem: string, value: number, tolerance = 0, over: Json = {}): Json => ({
    type: 'numeric',
    stem: text(stem),
    numeric: { value, tolerance },
    ...over,
  }),
  short: (stem: string, accepted: string[], over: Json = {}): Json => ({
    type: 'short_answer',
    stem: text(stem),
    shortAnswer: { mode: 'auto', accepted },
    ...over,
  }),
  essay: (stem: string, over: Json = {}): Json => ({ type: 'essay', stem: text(stem), ...over }),
};

export async function addQuestion(c: TestClient, courseId: string, input: Json): Promise<Json> {
  return ok(await c.post(`/courses/${courseId}/questions`, input));
}

/** The id of the option with this text (instructor view). */
export function optionId(question: Json, label: string): string {
  const o = question.options.find((x: Json) => x.text.content?.[0]?.content?.[0]?.text === label);
  if (!o) throw new Error(`no option "${label}"`);
  return o.id;
}

/** An assessment item in the exam's module with the given settings and slots; published. */
export async function addAssessment(
  e: Exam,
  opts: {
    title?: string;
    settings?: Json;
    slots: Json[];
    published?: boolean;
  },
): Promise<Json> {
  const c = e.instructor.client;
  const item = ok(
    await c.post(`/offerings/${e.offeringId}/modules/${e.moduleId}/items`, {
      kind: 'assessment',
      title: opts.title ?? 'Quiz',
      published: opts.published ?? true,
    }),
  );
  const base = `/offerings/${e.offeringId}/items/${item.id}/assessment`;
  if (opts.settings && Object.keys(opts.settings).length > 0) ok(await c.put(base, opts.settings));
  ok(await c.put(`${base}/slots`, { slots: opts.slots }));
  return item;
}

export const fixed = (questionId: string, points = 1): Json => ({
  kind: 'fixed',
  questionId,
  points,
});
export const pool = (over: Json): Json => ({ kind: 'pool', points: 1, count: 1, ...over });

/** The learner side: start an attempt and read it. */
export async function startAttempt(
  e: Exam,
  learner: Person,
  itemId: string,
): Promise<{ attemptId: string; resumed: boolean }> {
  return ok(await learner.client.post(`/offerings/${e.offeringId}/items/${itemId}/attempts`));
}
export async function readAttempt(e: Exam, learner: Person, attemptId: string): Promise<Json> {
  return ok(await learner.client.get(`/offerings/${e.offeringId}/attempts/${attemptId}`));
}
export function save(
  e: Exam,
  learner: Person,
  attemptId: string,
  answers: Json[],
  events: Json[] = [],
) {
  return learner.client.put(`/offerings/${e.offeringId}/attempts/${attemptId}/answers`, {
    answers,
    events,
  });
}
export function submit(e: Exam, learner: Person, attemptId: string) {
  return learner.client.post(`/offerings/${e.offeringId}/attempts/${attemptId}/submit`);
}

/** The position of the question with this stem in a learner's attempt. */
export function posOf(attempt: Json, stem: string): number {
  const x = attempt.questions.find((qq: Json) => qq.stem.content?.[0]?.content?.[0]?.text === stem);
  if (!x) throw new Error(`no question "${stem}" in the attempt`);
  return x.position;
}
/** The id of an option as the LEARNER sees it. */
export function learnerOption(attempt: Json, stem: string, label: string): string {
  const x = attempt.questions.find((qq: Json) => qq.stem.content?.[0]?.content?.[0]?.text === stem);
  const o = x.options.find((oo: Json) => oo.text.content?.[0]?.content?.[0]?.text === label);
  if (!o) throw new Error(`no option "${label}"`);
  return o.id;
}

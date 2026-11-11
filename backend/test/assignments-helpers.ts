import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { expect } from 'vitest';
import type { TestClient } from './client';
import { type Json, ok, type Person } from './courses-helpers';

// Shared setup of the step 10 tests (assignments, rubrics, grading, ZIP).

export type { Exam } from './assessments-helpers';
export { exam } from './assessments-helpers';

import type { Exam } from './assessments-helpers';

export const base = (e: Exam, itemId: string) =>
  `/offerings/${e.offeringId}/items/${itemId}/assignment`;

/** An assignment item in the exam's module with the given settings; published. */
export async function addAssignment(
  e: Exam,
  opts: { title?: string; settings?: Json; published?: boolean } = {},
): Promise<Json> {
  const c = e.instructor.client;
  const item = ok(
    await c.post(`/offerings/${e.offeringId}/modules/${e.moduleId}/items`, {
      kind: 'assignment',
      title: opts.title ?? 'Essay',
      published: opts.published ?? true,
    }),
  );
  if (opts.settings && Object.keys(opts.settings).length > 0)
    ok(await c.put(base(e, item.id), opts.settings));
  return item;
}

export const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
export const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

export const pdf = (label = 'x') =>
  Buffer.from(`%PDF-1.4\n1 0 obj\n<<>>\nendobj\n% ${label}\ntrailer\n<<>>\n%%EOF\n`);

/** The whole upload of ONE hand-in file: ask for a URL, PUT the bytes, confirm. Returns the ready file. */
export async function uploadHandIn(
  e: Exam,
  learner: Person,
  itemId: string,
  name: string,
  bytes: Buffer,
): Promise<Json> {
  const c = learner.client;
  const req = ok(await c.post(`${base(e, itemId)}/files`, { name, size: bytes.length }));
  const put = await c.request('PUT', req.upload.url, {
    body: bytes,
    headers: { ...req.upload.headers, 'content-length': String(bytes.length) },
  });
  expect(put.statusCode, put.body).toBe(204);
  return ok(await c.post(`${base(e, itemId)}/files/${req.fileId}/confirm`));
}

/**
 * Uploads the files and hands in. `body` is merged into the request. When the assignment refuses the UPLOAD itself
 * (closed, not open, already submitted ...), that refusal is returned: it is the answer a learner would get.
 */
export async function handIn(
  e: Exam,
  learner: Person,
  itemId: string,
  files: { name: string; bytes: Buffer }[] = [{ name: 'essay.pdf', bytes: pdf() }],
  body: Json = {},
) {
  const ids: string[] = [];
  for (const f of files) {
    const c = learner.client;
    const req = await c.post(`${base(e, itemId)}/files`, { name: f.name, size: f.bytes.length });
    if (req.statusCode >= 300) return req;
    const target = req.json();
    const put = await c.request('PUT', target.upload.url, {
      body: f.bytes,
      headers: { ...target.upload.headers, 'content-length': String(f.bytes.length) },
    });
    expect(put.statusCode, put.body).toBe(204);
    ids.push(ok(await c.post(`${base(e, itemId)}/files/${target.fileId}/confirm`)).fileId);
  }
  return learner.client.post(`${base(e, itemId)}/submissions`, {
    requestKey: randomUUID(),
    fileIds: ids,
    ...body,
  });
}

export const me = async (e: Exam, learner: Person, itemId: string): Promise<Json> =>
  ok(await learner.client.get(`${base(e, itemId)}/me`));

export const queue = async (e: Exam, who: Person, itemId: string, qs = ''): Promise<Json> =>
  ok(await who.client.get(`${base(e, itemId)}/grading/queue${qs}`));

/** The key (random, not the participant id) of the learner in the grading queue, by e-mail (not blind) or anon code. */
export async function keyOf(
  e: Exam,
  who: Person,
  itemId: string,
  learner: Person,
): Promise<string> {
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await queue(e, who, itemId, `?limit=100${after ? `&after=${after}` : ''}`);
    const row = r.items.find((x: Json) => x.email === learner.email);
    if (row) return row.learnerKey;
    if (!r.nextCursor) break;
    after = r.nextCursor;
  }
  throw new Error(`${learner.email} is not in the queue`);
}

/** The key of a learner by looking at the database (works while blind). */
export async function keyFromDb(
  owner: pg.Pool,
  itemId: string,
  learner: Person,
): Promise<{ key: string; code: string; participantId: string }> {
  const { rows } = await owner.query(
    `SELECT al.learner_key AS key, al.anon_code AS code, al.participant_id
       FROM lms.assignment_learners al
       JOIN lms.course_participants p ON p.tenant_id = al.tenant_id AND p.id = al.participant_id
       JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
      WHERE al.assignment_item_id = $1 AND m.user_id = $2`,
    [itemId, learner.userId],
  );
  return { key: rows[0].key, code: rows[0].code, participantId: rows[0].participant_id };
}

/** Moves the dates of an assignment (the clock cannot be moved, the stored dates can). */
export async function setDates(
  owner: pg.Pool,
  itemId: string,
  d: { opensAt?: string | null; dueAt?: string | null; cutoffAt?: string | null },
) {
  await owner.query(
    `UPDATE lms.assignments SET opens_at = $2, due_at = $3, late_cutoff_at = $4 WHERE item_id = $1`,
    [itemId, d.opensAt ?? null, d.dueAt ?? null, d.cutoffAt ?? null],
  );
}

export const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/**
 * A published offering with an instructor, an assistant and one STUDENT per name (with a profile: register number and
 * section), all enrolled by hand. The names are what the blind tests look for.
 */
export async function classOf(
  owner: pg.Pool,
  t: import('./app').TestApp,
  A: import('./support').AuthFixture,
  admin: TestClient,
  st: import('./courses-helpers').Structure,
  names: string[],
): Promise<Exam & { register: string[] }> {
  const { newCourse, newOffering, person, student } = await import('./courses-helpers');
  const c = await newCourse(admin);
  const o = await newOffering(admin, c.id, st.termId);
  const instructor = await person(owner, t, A, 'Instructor');
  const assistant = await person(owner, t, A, 'Assistant');
  const learners: Person[] = [];
  for (const n of names) learners.push(await student(owner, t, A, admin, st, st.sectionA, n));
  for (const [p, participation] of [
    [instructor, 'instructor'],
    [assistant, 'assistant'],
    ...learners.map((l) => [l, 'learner'] as const),
  ] as const) {
    ok(await admin.post(`/offerings/${o.id}/participants`, { userId: p.userId, participation }));
  }
  ok(await instructor.client.post(`/offerings/${o.id}/publish`));
  const m = ok(await instructor.client.post(`/offerings/${o.id}/modules`, { title: 'Week 1' }));
  ok(await instructor.client.patch(`/offerings/${o.id}/modules/${m.id}`, { published: true }));
  const register: string[] = [];
  for (const l of learners) {
    const { rows } = await owner.query(
      `SELECT mp.register_number FROM lms.member_profiles mp
         JOIN lms.tenant_memberships tm ON tm.tenant_id = mp.tenant_id AND tm.id = mp.membership_id
        WHERE tm.user_id = $1`,
      [l.userId],
    );
    register.push(rows[0].register_number);
  }
  return {
    courseId: c.id,
    offeringId: o.id,
    moduleId: m.id,
    instructor,
    assistant,
    learners,
    register,
  };
}

/** A rubric of two criteria: Content (0 / 5 / 10) and Language (0 / 5): 15 points. */
export const rubricInput = (title = 'Essay rubric'): Json => ({
  title,
  criteria: [
    {
      title: 'Content',
      levels: [
        { title: 'Missing', points: 0 },
        { title: 'Adequate', points: 5 },
        { title: 'Excellent', points: 10 },
      ],
    },
    {
      title: 'Language',
      levels: [
        { title: 'Poor', points: 0 },
        { title: 'Good', points: 5 },
      ],
    },
  ],
});

/** The selection of the levels by TITLE for a rubric detail. */
export function pickLevels(rubric: Json, titles: string[]): Record<string, { levelId: string }> {
  const out: Record<string, { levelId: string }> = {};
  rubric.criteria.forEach((cr: Json, i: number) => {
    const lv = cr.levels.find((l: Json) => l.title === titles[i]);
    if (!lv) throw new Error(`no level ${titles[i]}`);
    out[cr.id] = { levelId: lv.id };
  });
  return out;
}

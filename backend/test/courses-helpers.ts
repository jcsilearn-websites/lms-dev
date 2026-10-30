import type pg from 'pg';
import { expect } from 'vitest';
import type { TestApp } from './app';
import { TestClient } from './client';
import { addMember } from './fixtures';
import { type AuthFixture, TEST_PASSWORD } from './support';

// Shared setup for the Step 6 tests (courses, offerings, participants, content, files).

// biome-ignore lint/suspicious/noExplicitAny: a test helper that returns whatever JSON the API sent
export type Json = any;
export const ok = (res: { statusCode: number; body: string; json(): Json }): Json => {
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json();
};
export const errorCode = (res: { json(): Json }): string => res.json().error.code;

let n = 0;
export const uniq = (p: string) => `${p}${++n}${Math.random().toString(36).slice(2, 5)}`;

export async function loginAs(t: TestApp, host: string, email: string): Promise<TestClient> {
  const c = new TestClient(t, host);
  expect((await c.login(email, TEST_PASSWORD)).statusCode).toBe(200);
  return c;
}

export interface Structure {
  termId: string;
  yearId: string;
  deptId: string;
  programId: string;
  batchId: string;
  sectionA: string;
  sectionB: string;
}

/** A year, a term, a department -> program -> batch and sections A and B for a college. */
export async function structure(admin: TestClient): Promise<Structure> {
  const year = ok(
    await admin.post('/academic-years', {
      label: uniq('Y'),
      startDate: '2026-06-01',
      endDate: '2027-05-31',
    }),
  );
  const term = ok(
    await admin.post('/terms', {
      academicYearId: year.id,
      name: uniq('Sem'),
      startDate: '2026-06-01',
      endDate: '2026-11-30',
    }),
  );
  const dept = ok(
    await admin.post('/departments', { code: uniq('D').toUpperCase(), name: 'Computing' }),
  );
  const prog = ok(
    await admin.post('/programs', {
      departmentId: dept.id,
      code: uniq('P').toUpperCase(),
      name: 'B.Sc.',
      durationYears: 3,
    }),
  );
  const batch = ok(
    await admin.post('/batches', { programId: prog.id, admissionYear: 2026, graduationYear: 2029 }),
  );
  const a = ok(await admin.post('/sections', { batchId: batch.id, code: 'A' }));
  const b = ok(await admin.post('/sections', { batchId: batch.id, code: 'B' }));
  return {
    termId: term.id,
    yearId: year.id,
    deptId: dept.id,
    programId: prog.id,
    batchId: batch.id,
    sectionA: a.id,
    sectionB: b.id,
  };
}

export async function newCourse(
  admin: TestClient,
  over: Record<string, unknown> = {},
): Promise<Json> {
  return ok(
    await admin.post('/courses', { code: uniq('C').toUpperCase(), title: 'Programming', ...over }),
  );
}

export async function newOffering(
  admin: TestClient,
  courseId: string,
  termId: string,
  over: Record<string, unknown> = {},
): Promise<Json> {
  return ok(await admin.post('/offerings', { courseId, termId, ...over }));
}

export interface Person {
  userId: string;
  membershipId: string;
  email: string;
  client: TestClient;
}

/** A member of the college with a signed-in client. */
export async function person(
  owner: pg.Pool,
  t: TestApp,
  f: AuthFixture,
  name: string,
  opts: { role?: 'member' | 'institution_admin' } = {},
): Promise<Person> {
  const email = `${uniq(name)}@${f.slug}.test`.toLowerCase();
  const m = await addMember(owner, f.tenantId, email, { ...opts, displayName: name });
  return { ...m, client: await loginAs(t, f.host, email) };
}

/** A student with a profile in a section (the enrolment sync follows the section). */
export async function student(
  owner: pg.Pool,
  t: TestApp,
  f: AuthFixture,
  admin: TestClient,
  s: Structure,
  sectionId: string,
  name = 'Student',
): Promise<Person> {
  const p = await person(owner, t, f, name);
  ok(
    await admin.patch(`/members/${p.userId}/profile`, {
      profileType: 'student',
      registerNumber: uniq('R').toUpperCase(),
      batchId: s.batchId,
      sectionId,
    }),
  );
  return p;
}

/** Runs the enrolment sync of a college the way the worker would (until nothing is pending). */
export async function runSync(t: TestApp, tenantId: string) {
  return t.app.modules.courses.service.syncEnrolments(tenantId, { batchSize: 200, maxBatches: 50 });
}

/** The whole upload flow of a file: ask for a URL, PUT the bytes, confirm. Returns the ready file. */
export async function uploadFile(
  client: TestClient,
  offeringId: string,
  name: string,
  bytes: Buffer,
): Promise<Json> {
  const req = ok(await client.post(`/offerings/${offeringId}/files`, { name, size: bytes.length }));
  const put = await client.request('PUT', req.upload.url, {
    body: bytes,
    headers: { ...req.upload.headers, 'content-length': String(bytes.length) },
  });
  expect(put.statusCode, put.body).toBe(204);
  return ok(await client.post(`/files/${req.file.id}/confirm`));
}

/** A tiny but valid PDF / PNG for the type checks. */
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body'),
]);

export const doc = (...paras: string[]) => ({
  type: 'doc',
  content: paras.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })),
});

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { lastTokenFor, TestClient } from './client';
import {
  errorCode,
  loginAs,
  newCourse,
  newOffering,
  ok,
  person,
  runSync,
  type Structure,
  structure,
  student,
  uniq,
} from './courses-helpers';
import { type AuthFixture, createAuthFixture, TEST_PASSWORD, testOwnerPool } from './support';

// Courses, offerings, participants, section enrolment and the visibility rules of an offering.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
let admin: TestClient;
let adminB: TestClient;
let S: Structure;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp();
  A = await createAuthFixture(owner, 'co-a');
  B = await createAuthFixture(owner, 'co-b');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  adminB = await loginAs(t, B.host, B.adminEmail);
  S = await structure(admin);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

describe('courses', () => {
  it('a course needs no department; the department filter finds both kinds', async () => {
    const none = await newCourse(admin, { code: uniq('ELX') });
    expect(none.departmentId).toBeNull();
    const dep = await newCourse(admin, { code: uniq('CSX'), departmentId: S.deptId, credits: 3.5 });
    expect(dep).toMatchObject({
      departmentId: S.deptId,
      departmentCode: expect.any(String),
      credits: 3.5,
    });

    const inDept = ok(
      await admin.get('/courses', { query: `department=${S.deptId}&limit=100` }),
    ).items;
    expect(inDept.map((c: { id: string }) => c.id)).toContain(dep.id);
    expect(inDept.map((c: { id: string }) => c.id)).not.toContain(none.id);
    const noDept = ok(await admin.get('/courses', { query: 'department=none&limit=100' })).items;
    expect(noDept.map((c: { id: string }) => c.id)).toContain(none.id);
    expect(noDept.every((c: { departmentId: string | null }) => c.departmentId === null)).toBe(
      true,
    );
  });

  it('codes are stored upper case and unique per college; a department must exist', async () => {
    const c = await newCourse(admin, { code: 'mx101' });
    expect(c.code).toBe('MX101');
    const dup = await admin.post('/courses', { code: 'MX101', title: 'Again' });
    expect(dup.statusCode).toBe(409);
    expect(errorCode(dup)).toBe('duplicate_code');
    // the same code in another college is fine
    expect(
      (await adminB.post('/courses', { code: 'MX101', title: 'Other college' })).statusCode,
    ).toBe(201);
    const bad = await admin.post('/courses', {
      code: uniq('Z'),
      title: 'x',
      departmentId: '01a183c6-b2f4-7bd0-a6ae-58be9db51f10',
    });
    expect(bad.statusCode).toBe(400);
    expect(errorCode(bad)).toBe('invalid_reference');
  });

  it('a department can be set and cleared; a member without the permission gets 403', async () => {
    const c = await newCourse(admin, { departmentId: S.deptId });
    const cleared = ok(
      await admin.patch(`/courses/${c.id}`, { departmentId: null, title: 'Renamed' }),
    );
    expect(cleared).toMatchObject({ departmentId: null, title: 'Renamed' });
    const p = await person(owner, t, A, 'Plain');
    expect((await p.client.get('/courses')).statusCode).toBe(403);
    expect((await p.client.post('/courses', { code: uniq('Q'), title: 'x' })).statusCode).toBe(403);
  });

  it('cannot be archived while an offering is not archived, but can afterwards', async () => {
    const c = await newCourse(admin);
    const o = await newOffering(admin, c.id, S.termId);
    const refused = await admin.patch(`/courses/${c.id}`, { archived: true });
    expect(refused.statusCode).toBe(409);
    expect(errorCode(refused)).toBe('has_active_children');
    ok(await admin.post(`/offerings/${o.id}/archive`));
    expect(ok(await admin.patch(`/courses/${c.id}`, { archived: true })).archivedAt).not.toBeNull();
    const again = await admin.post('/offerings', { courseId: c.id, termId: S.termId, label: 'x' });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('parent_archived');
  });
});

describe('offerings and who sees them', () => {
  it('one offering per course, term and label', async () => {
    const c = await newCourse(admin);
    const o = await newOffering(admin, c.id, S.termId);
    expect(o).toMatchObject({ status: 'draft', label: '', courseId: c.id, myParticipation: null });
    const dup = await admin.post('/offerings', { courseId: c.id, termId: S.termId });
    expect(errorCode(dup)).toBe('duplicate_offering');
    expect(
      (await admin.post('/offerings', { courseId: c.id, termId: S.termId, label: 'Evening' }))
        .statusCode,
    ).toBe(201);
  });

  it('draft: instructor and administrator see it, a learner and an outsider get 404; published: the learner sees it', async () => {
    const c = await newCourse(admin);
    const o = await newOffering(admin, c.id, S.termId);
    const instructor = await person(owner, t, A, 'Inst');
    const learner = await person(owner, t, A, 'Learner');
    const outsider = await person(owner, t, A, 'Outsider');
    ok(
      await admin.post(`/offerings/${o.id}/participants`, {
        userId: instructor.userId,
        participation: 'instructor',
      }),
    );
    ok(
      await admin.post(`/offerings/${o.id}/participants`, {
        userId: learner.userId,
        participation: 'learner',
      }),
    );

    expect(ok(await instructor.client.get(`/offerings/${o.id}`)).myParticipation).toBe(
      'instructor',
    );
    expect((await admin.get(`/offerings/${o.id}`)).statusCode).toBe(200);
    expect((await learner.client.get(`/offerings/${o.id}`)).statusCode).toBe(404);
    expect((await outsider.client.get(`/offerings/${o.id}`)).statusCode).toBe(404);
    expect(ok(await learner.client.get('/me/courses')).items).toEqual([]);

    // the administrator cannot publish (course.publish is a participant permission); the instructor can
    const denied = await admin.post(`/offerings/${o.id}/publish`);
    expect(denied.statusCode).toBe(403);
    expect(ok(await instructor.client.post(`/offerings/${o.id}/publish`)).status).toBe('published');

    expect(ok(await learner.client.get(`/offerings/${o.id}`)).myParticipation).toBe('learner');
    expect(
      ok(await learner.client.get('/me/courses')).items.map((x: { id: string }) => x.id),
    ).toEqual([o.id]);
    expect((await outsider.client.get(`/offerings/${o.id}`)).statusCode).toBe(404);
    // a learner cannot publish, unpublish or manage: 403 (they take part), an outsider 404
    expect((await learner.client.post(`/offerings/${o.id}/unpublish`)).statusCode).toBe(403);
    expect((await outsider.client.post(`/offerings/${o.id}/unpublish`)).statusCode).toBe(404);
    expect(errorCode(await instructor.client.post(`/offerings/${o.id}/publish`))).toBe(
      'invalid_status',
    );
    // the instructor takes it back to draft: the learner loses sight of it again
    ok(await instructor.client.post(`/offerings/${o.id}/unpublish`));
    expect((await learner.client.get(`/offerings/${o.id}`)).statusCode).toBe(404);
  });

  it('an archived offering is frozen', async () => {
    const c = await newCourse(admin);
    const o = await newOffering(admin, c.id, S.termId);
    ok(await admin.post(`/offerings/${o.id}/archive`));
    const r = await admin.patch(`/offerings/${o.id}`, { label: 'late' });
    expect(r.statusCode).toBe(409);
    expect(errorCode(r)).toBe('offering_archived');
    const p = await person(owner, t, A, 'Late');
    const add = await admin.post(`/offerings/${o.id}/participants`, {
      userId: p.userId,
      participation: 'learner',
    });
    expect(errorCode(add)).toBe('offering_archived');
  });

  it("another college's offering does not exist for us", async () => {
    const c = await newCourse(adminB);
    const outsiderA = await person(owner, t, A, 'Visitor');
    expect((await outsiderA.client.get(`/offerings/${c.id}`)).statusCode).toBe(404);
    expect((await admin.get(`/offerings/${c.id}`)).statusCode).toBe(404);
  });
});

describe('participants', () => {
  it('instructors and assistants read the class list; learners cannot; removal is sticky', async () => {
    const c = await newCourse(admin);
    const o = await newOffering(admin, c.id, S.termId);
    const instructor = await person(owner, t, A, 'I');
    const assistant = await person(owner, t, A, 'TA');
    const learner = await person(owner, t, A, 'L');
    for (const [p, kind] of [
      [instructor, 'instructor'],
      [assistant, 'assistant'],
      [learner, 'learner'],
    ] as const) {
      ok(
        await admin.post(`/offerings/${o.id}/participants`, {
          userId: p.userId,
          participation: kind,
        }),
      );
    }
    ok(await instructor.client.post(`/offerings/${o.id}/publish`));
    const list = (client: TestClient) => client.get(`/offerings/${o.id}/participants`);
    expect(ok(await list(instructor.client)).items).toHaveLength(3);
    expect(ok(await list(assistant.client)).items).toHaveLength(3);
    expect((await list(learner.client)).statusCode).toBe(403);
    expect(ok(await list(admin)).items).toHaveLength(3);

    // instructors read only: they cannot add anyone
    const other = await person(owner, t, A, 'Other');
    const denied = await instructor.client.post(`/offerings/${o.id}/participants`, {
      userId: other.userId,
      participation: 'learner',
    });
    expect(denied.statusCode).toBe(403);

    const row = ok(await list(admin)).items.find(
      (x: { userId: string }) => x.userId === learner.userId,
    );
    ok(await admin.delete(`/offerings/${o.id}/participants/${row.id}`));
    expect(ok(await list(admin)).items).toHaveLength(2);
    expect(
      ok(await admin.get(`/offerings/${o.id}/participants`, { query: 'includeRemoved=true' }))
        .items,
    ).toHaveLength(3);
    expect((await learner.client.get(`/offerings/${o.id}`)).statusCode).toBe(404);
  });

  it('a person is added once; adding again changes the part; only active members can be added', async () => {
    const c = await newCourse(admin);
    const o = await newOffering(admin, c.id, S.termId);
    const p = await person(owner, t, A, 'Twice');
    ok(
      await admin.post(`/offerings/${o.id}/participants`, {
        userId: p.userId,
        participation: 'learner',
      }),
    );
    const again = ok(
      await admin.post(`/offerings/${o.id}/participants`, {
        userId: p.userId,
        participation: 'assistant',
      }),
    );
    expect(again.participation).toBe('assistant');
    expect(ok(await admin.get(`/offerings/${o.id}/participants`)).items).toHaveLength(1);
    const ghost = await admin.post(`/offerings/${o.id}/participants`, {
      userId: '01a183c6-b2f4-7bd0-a6ae-58be9db51f10',
      participation: 'learner',
    });
    expect(ghost.statusCode).toBe(404);
    // somebody of ANOTHER college is not a member here
    const foreign = await admin.post(`/offerings/${o.id}/participants`, {
      userId: B.memberUserId,
      participation: 'learner',
    });
    expect(foreign.statusCode).toBe(404);
  });
});

describe('enrolment through sections', () => {
  it('students of an enrolled section become learners after the sync; moving them updates access', async () => {
    const c = await newCourse(admin);
    const o = await newOffering(admin, c.id, S.termId);
    const s1 = await student(owner, t, A, admin, S, S.sectionA, 'S1');
    const s2 = await student(owner, t, A, admin, S, S.sectionB, 'S2');
    ok(await admin.post(`/offerings/${o.id}/sections`, { sectionId: S.sectionA }));
    expect(
      ok(await admin.get(`/offerings/${o.id}/sections`)).items.map(
        (x: { sectionId: string }) => x.sectionId,
      ),
    ).toEqual([S.sectionA]);
    await runSync(t, A.tenantId);

    const learners = async () =>
      ok(
        await admin.get(`/offerings/${o.id}/participants`, { query: 'participation=learner' }),
      ).items.map((x: { userId: string }) => x.userId);
    expect(await learners()).toContain(s1.userId);
    expect(await learners()).not.toContain(s2.userId);

    // the student moves to section B: the sync removes them, and their access with it
    ok(await admin.post(`/members/${s1.userId}/profile/section`, { sectionId: S.sectionB }));
    await runSync(t, A.tenantId);
    expect(await learners()).not.toContain(s1.userId);
    // and back again: re-enrolled (the removal was by the sync, not by an administrator)
    ok(await admin.post(`/members/${s1.userId}/profile/section`, { sectionId: S.sectionA }));
    await runSync(t, A.tenantId);
    expect(await learners()).toContain(s1.userId);

    // a second run changes nothing (idempotent)
    const before = await learners();
    await runSync(t, A.tenantId);
    expect(await learners()).toEqual(before);
  });

  it('manual participants are never touched; an administrator-removed learner stays removed', async () => {
    const c = await newCourse(admin);
    const o = await newOffering(admin, c.id, S.termId);
    const s1 = await student(owner, t, A, admin, S, S.sectionA, 'M1');
    const s2 = await student(owner, t, A, admin, S, S.sectionA, 'M2');
    // s1 is added by hand BEFORE the section; s2 comes with the section and is then removed by hand
    ok(
      await admin.post(`/offerings/${o.id}/participants`, {
        userId: s1.userId,
        participation: 'assistant',
      }),
    );
    ok(await admin.post(`/offerings/${o.id}/sections`, { sectionId: S.sectionA }));
    await runSync(t, A.tenantId);
    const list = async () => ok(await admin.get(`/offerings/${o.id}/participants`)).items;
    expect((await list()).find((x: { userId: string }) => x.userId === s1.userId)).toMatchObject({
      participation: 'assistant',
      source: 'manual',
    });
    const r2 = (await list()).find((x: { userId: string }) => x.userId === s2.userId);
    expect(r2).toMatchObject({ participation: 'learner', source: 'section', sectionCode: 'A' });
    ok(await admin.delete(`/offerings/${o.id}/participants/${r2.id}`));
    // leaving and re-entering the section does not bring them back
    ok(await admin.post(`/members/${s2.userId}/profile/section`, { sectionId: S.sectionB }));
    ok(await admin.post(`/members/${s2.userId}/profile/section`, { sectionId: S.sectionA }));
    await runSync(t, A.tenantId);
    expect((await list()).find((x: { userId: string }) => x.userId === s2.userId)).toBeUndefined();
    // the manual assistant is still an assistant after every sync, also when their section changes
    ok(await admin.post(`/members/${s1.userId}/profile/section`, { sectionId: S.sectionB }));
    await runSync(t, A.tenantId);
    expect((await list()).find((x: { userId: string }) => x.userId === s1.userId)).toMatchObject({
      participation: 'assistant',
    });
  });

  it('removing a section removes the learners it brought; a suspended member loses access', async () => {
    const c = await newCourse(admin);
    const o = await newOffering(admin, c.id, S.termId);
    const s1 = await student(owner, t, A, admin, S, S.sectionA, 'R1');
    const s2 = await student(owner, t, A, admin, S, S.sectionA, 'R2');
    ok(await admin.post(`/offerings/${o.id}/sections`, { sectionId: S.sectionA }));
    await runSync(t, A.tenantId);
    const active = async () =>
      ok(await admin.get(`/offerings/${o.id}/participants`)).items.map(
        (x: { userId: string }) => x.userId,
      );
    expect(await active()).toEqual(expect.arrayContaining([s1.userId, s2.userId]));
    ok(await admin.post(`/members/${s2.userId}/suspend`));
    await runSync(t, A.tenantId);
    expect(await active()).not.toContain(s2.userId);
    ok(await admin.delete(`/offerings/${o.id}/sections/${S.sectionA}`));
    await runSync(t, A.tenantId);
    expect(await active()).toEqual([]);
    const missing = await admin.delete(`/offerings/${o.id}/sections/${S.sectionA}`);
    expect(missing.statusCode).toBe(404);
  });
});

describe('CourseParticipationResolver', () => {
  it('resolves a participation per offering with ONE query, cached for the life of the resolver', async () => {
    const c = await newCourse(admin);
    const o = await newOffering(admin, c.id, S.termId);
    const other = await newOffering(admin, c.id, S.termId, { label: 'other' });
    const teacher = await person(owner, t, A, 'ResolverTeacher');
    const stranger = await person(owner, t, A, 'ResolverStranger');
    ok(
      await admin.post(`/offerings/${o.id}/participants`, {
        userId: teacher.userId,
        participation: 'instructor',
      }),
    );

    const resolver = t.app.modules.courses.participation.forRequest();
    const q = (userId: string, offeringId: string) =>
      resolver.resolve({ tenantId: A.tenantId, userId, offeringId });
    t.statements.reset();
    expect(await q(teacher.userId, o.id)).toBe('instructor');
    expect(await q(teacher.userId, o.id)).toBe('instructor'); // from the cache
    const first = t.statements.count;
    expect(first).toBeLessThanOrEqual(3); // BEGIN + the query + COMMIT: one lookup, not two
    expect(await q(teacher.userId, other.id)).toBeNull(); // another offering
    expect(await q(stranger.userId, o.id)).toBeNull(); // no participation
    // a new resolver (the next request) sees changes at once
    ok(
      await admin.post(`/offerings/${o.id}/participants`, {
        userId: stranger.userId,
        participation: 'learner',
      }),
    );
    expect(
      await t.app.modules.courses.participation
        .forRequest()
        .resolve({ tenantId: A.tenantId, userId: stranger.userId, offeringId: o.id }),
    ).toBe('learner');
    // never across colleges, and never for a suspended member
    expect(
      await t.app.modules.courses.participation
        .forRequest()
        .resolve({ tenantId: B.tenantId, userId: teacher.userId, offeringId: o.id }),
    ).toBeNull();
    ok(await admin.post(`/members/${teacher.userId}/suspend`));
    expect(
      await t.app.modules.courses.participation
        .forRequest()
        .resolve({ tenantId: A.tenantId, userId: teacher.userId, offeringId: o.id }),
    ).toBeNull();
  });
});

describe('removing a member (soft) keeps the academic history', () => {
  it('closes their participations through the sync, keeps the rows, and restores them when they are invited again', async () => {
    const c = await newCourse(admin);
    const o = await newOffering(admin, c.id, S.termId);
    const teacher = await person(owner, t, A, 'GoneTeacher');
    const learner = await student(owner, t, A, admin, S, S.sectionA, 'GoneStudent');
    ok(
      await admin.post(`/offerings/${o.id}/participants`, {
        userId: teacher.userId,
        participation: 'instructor',
      }),
    );
    ok(await admin.post(`/offerings/${o.id}/sections`, { sectionId: S.sectionA }));
    await runSync(t, A.tenantId);
    const rows = async () =>
      (
        await owner.query(
          `SELECT m.user_id, cp.participation::text AS participation, cp.source::text AS source, cp.status::text AS status, cp.removed_reason
             FROM lms.course_participants cp JOIN lms.tenant_memberships m ON m.id = cp.membership_id
            WHERE cp.offering_id = $1 AND m.user_id = ANY($2::uuid[]) ORDER BY cp.source`,
          [o.id, [teacher.userId, learner.userId]],
        )
      ).rows;
    expect((await rows()).map((r) => r.status)).toEqual(['active', 'active']);

    ok(await admin.delete(`/members/${teacher.userId}`));
    ok(await admin.delete(`/members/${learner.userId}`));
    await runSync(t, A.tenantId);
    const closed = await rows();
    expect(closed).toHaveLength(2); // the history is kept
    expect(closed.every((r) => r.status === 'removed' && r.removed_reason === 'membership')).toBe(
      true,
    );
    // gone from the class list, and the resolver says "no participation"
    const listed = ok(await admin.get(`/offerings/${o.id}/participants?limit=100`)).items.map(
      (x: { userId: string }) => x.userId,
    );
    expect(listed).not.toContain(teacher.userId);
    expect(listed).not.toContain(learner.userId);
    expect(
      await t.app.modules.courses.participation
        .forRequest()
        .resolve({ tenantId: A.tenantId, userId: teacher.userId, offeringId: o.id }),
    ).toBeNull();
    // a membership with history cannot be deleted at all, not even by the owner
    const del = await owner
      .query('DELETE FROM lms.tenant_memberships WHERE user_id = $1', [teacher.userId])
      .catch((e: unknown) => e);
    expect((del as { code?: string }).code).toBe('23503');

    // invited again and accepted: the same membership, and the participations come back
    for (const p of [teacher, learner]) {
      ok(await admin.post('/auth/invites', { email: p.email, role: 'member' }));
      const token = lastTokenFor(t, p.email);
      expect(
        (
          await new TestClient(t, A.host).post('/auth/invites/accept', {
            token,
            password: TEST_PASSWORD,
          })
        ).statusCode,
      ).toBe(200);
    }
    await runSync(t, A.tenantId);
    const back = await rows();
    expect(back).toHaveLength(2);
    expect(back.every((r) => r.status === 'active' && r.removed_reason === null)).toBe(true);
    expect(back.map((r) => r.participation).sort()).toEqual(['instructor', 'learner']);
  });

  it('a removed member who moves section does not come back through the section', async () => {
    const c = await newCourse(admin);
    const o = await newOffering(admin, c.id, S.termId);
    const stu = await student(owner, t, A, admin, S, S.sectionA, 'RemovedMover');
    ok(await admin.post(`/offerings/${o.id}/sections`, { sectionId: S.sectionA }));
    await runSync(t, A.tenantId);
    ok(await admin.delete(`/members/${stu.userId}`));
    ok(await admin.post(`/members/${stu.userId}/profile/section`, { sectionId: S.sectionB }));
    ok(await admin.post(`/members/${stu.userId}/profile/section`, { sectionId: S.sectionA }));
    await runSync(t, A.tenantId);
    expect(
      ok(await admin.get(`/offerings/${o.id}/participants`)).items.map(
        (x: { userId: string }) => x.userId,
      ),
    ).not.toContain(stu.userId);
  });
});

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import { addMember } from './fixtures';
import { type AuthFixture, createAuthFixture, TEST_PASSWORD, testOwnerPool } from './support';

// Member profiles: students / faculty / staff, section assignment and moves, the member-list filters,
// and the rule that profile_type is a LABEL that grants nothing.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
let admin: TestClient;
let adminB: TestClient;
let n = 0;
const uniq = (p: string) => `${p}${++n}`;

// biome-ignore lint/suspicious/noExplicitAny: a test helper that returns whatever JSON the API sent
type Json = any;
const ok = (res: { statusCode: number; body: string; json(): Json }): Json => {
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json();
};
const code = (res: { json(): Json }) => res.json().error.code;
const patch = (c: TestClient, url: string, body: unknown) => c.request('PATCH', url, { body });

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp();
  A = await createAuthFixture(owner, 'pf-a2');
  B = await createAuthFixture(owner, 'pf-b2');
  await t.app.ready();
  const login = async (host: string, email: string) => {
    const c = new TestClient(t, host);
    expect((await c.login(email, TEST_PASSWORD)).statusCode).toBe(200);
    return c;
  };
  admin = await login(A.host, A.adminEmail);
  adminB = await login(B.host, B.adminEmail);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

/** A department -> program -> batch (2023-2027) -> sections A and B of tenant A (or B). */
async function structure(c = admin) {
  const dept = ok(await c.post('/departments', { code: uniq('D'), name: 'Mechanical' }));
  const prog = ok(
    await c.post('/programs', {
      departmentId: dept.id,
      code: uniq('P'),
      name: 'B.E.',
      durationYears: 4,
    }),
  );
  const batch = ok(
    await c.post('/batches', { programId: prog.id, admissionYear: 2023, graduationYear: 2027 }),
  );
  const a = ok(await c.post('/sections', { batchId: batch.id, code: 'A' }));
  const b = ok(await c.post('/sections', { batchId: batch.id, code: 'B' }));
  return { dept, prog, batch, a, b };
}

async function student(s: Awaited<ReturnType<typeof structure>>, sectionId = s.a.id) {
  const m = await addMember(owner, A.tenantId, `${uniq('stu')}@pf-a2.test`);
  const profile = ok(
    await patch(admin, `/members/${m.userId}/profile`, {
      profileType: 'student',
      registerNumber: uniq('REG'),
      batchId: s.batch.id,
      sectionId,
    }),
  );
  return { ...m, profile };
}

describe('creating and reading profiles', () => {
  it('a student profile carries register number, batch and section; the department follows the batch', async () => {
    const s = await structure();
    const m = await addMember(owner, A.tenantId, `${uniq('s')}@pf-a2.test`);
    const res = await patch(admin, `/members/${m.userId}/profile`, {
      profileType: 'student',
      registerNumber: ' 23CS001 ',
      phone: '+91 98765 43210',
      batchId: s.batch.id,
      sectionId: s.a.id,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      userId: m.userId,
      profileType: 'student',
      registerNumber: '23CS001',
      phone: '+91 98765 43210',
      employeeId: null,
      departmentId: s.dept.id,
      departmentCode: s.dept.code,
      programCode: s.prog.code,
      batchId: s.batch.id,
      batchLabel: '2023-2027',
      sectionId: s.a.id,
      sectionCode: 'A',
    });
    expect(ok(await admin.get(`/members/${m.userId}/profile`))).toMatchObject({
      registerNumber: '23CS001',
    });
  });

  it('a member reads their OWN profile; nobody else can read it without profile.manage', async () => {
    const s = await structure();
    const st = await student(s);
    const c = new TestClient(t, A.host);
    expect((await c.login(st.email, TEST_PASSWORD)).statusCode).toBe(200);
    expect(ok(await c.get('/me/profile'))).toMatchObject({ userId: st.userId, sectionCode: 'A' });
    expect((await c.get(`/members/${A.memberUserId}/profile`)).statusCode).toBe(403);
    // a member with no profile yet
    const none = new TestClient(t, A.host);
    await none.login(A.memberEmail, TEST_PASSWORD);
    expect(code(await none.get('/me/profile'))).toBe('profile_not_found');
    expect(code(await admin.get(`/members/${A.memberUserId}/profile`))).toBe('profile_not_found');
    expect(code(await admin.get('/members/00000000-0000-7000-8000-000000000000/profile'))).toBe(
      'member_not_found',
    );
  });

  it('a faculty profile carries employee id and department; creating needs profileType', async () => {
    const s = await structure();
    const m = await addMember(owner, A.tenantId, `${uniq('f')}@pf-a2.test`);
    const missing = await patch(admin, `/members/${m.userId}/profile`, { phone: '98765 43210' });
    expect(missing.statusCode).toBe(400);
    expect(code(missing)).toBe('profile_type_required');
    const res = ok(
      await patch(admin, `/members/${m.userId}/profile`, {
        profileType: 'faculty',
        employeeId: uniq('EMP'),
        departmentId: s.dept.id,
        designation: '  Associate   Professor ',
      }),
    );
    expect(res).toMatchObject({
      profileType: 'faculty',
      departmentCode: s.dept.code,
      designation: 'Associate Professor',
      registerNumber: null,
      batchId: null,
    });
  });

  it('refuses fields that do not belong to the type, bad phones and empty bodies', async () => {
    const s = await structure();
    const m = await addMember(owner, A.tenantId, `${uniq('x')}@pf-a2.test`);
    const url = `/members/${m.userId}/profile`;
    const bad = await patch(admin, url, {
      profileType: 'faculty',
      registerNumber: 'R1',
      batchId: s.batch.id,
    });
    expect(bad.statusCode).toBe(400);
    expect(
      bad
        .json()
        .error.details.map((d: { path: string }) => d.path)
        .sort(),
    ).toEqual(['batchId', 'registerNumber']);
    expect((await patch(admin, url, { profileType: 'student', employeeId: 'E1' })).statusCode).toBe(
      400,
    );
    const phone = await patch(admin, url, { profileType: 'staff', phone: 'call me' });
    expect(phone.json().error.details[0].path).toBe('phone');
    expect(code(await patch(admin, url, {}))).toBe('nothing_to_update');
    expect((await patch(admin, url, { profileType: 'teacher' })).statusCode).toBe(400);
  });

  it('switching type needs the old fields cleared (the database enforces it); null clears a field', async () => {
    const s = await structure();
    const st = await student(s);
    const url = `/members/${st.userId}/profile`;
    expect(code(await patch(admin, url, { profileType: 'faculty', employeeId: uniq('E') }))).toBe(
      'profile_fields_mismatch',
    );
    const swapped = ok(
      await patch(admin, url, {
        profileType: 'staff',
        registerNumber: null,
        batchId: null,
        sectionId: null,
        employeeId: uniq('E'),
      }),
    );
    expect(swapped).toMatchObject({
      profileType: 'staff',
      registerNumber: null,
      sectionId: null,
      batchId: null,
    });
    ok(await patch(admin, url, { phone: null }));
  });
});

describe('uniqueness and references', () => {
  it('register numbers and employee ids are unique per college (not across colleges)', async () => {
    const s = await structure();
    const reg = uniq('REG');
    const a = await addMember(owner, A.tenantId, `${uniq('u')}@pf-a2.test`);
    const b = await addMember(owner, A.tenantId, `${uniq('u')}@pf-a2.test`);
    ok(
      await patch(admin, `/members/${a.userId}/profile`, {
        profileType: 'student',
        registerNumber: reg,
        batchId: s.batch.id,
      }),
    );
    const dup = await patch(admin, `/members/${b.userId}/profile`, {
      profileType: 'student',
      registerNumber: reg,
    });
    expect(dup.statusCode).toBe(409);
    expect(code(dup)).toBe('duplicate_register_number');
    const emp = uniq('EMP');
    ok(
      await patch(admin, `/members/${b.userId}/profile`, {
        profileType: 'faculty',
        employeeId: emp,
      }),
    );
    const c = await addMember(owner, A.tenantId, `${uniq('u')}@pf-a2.test`);
    expect(
      code(
        await patch(admin, `/members/${c.userId}/profile`, {
          profileType: 'staff',
          employeeId: emp,
        }),
      ),
    ).toBe('duplicate_employee_id');
    // the same number in another college is fine
    const other = await addMember(owner, B.tenantId, `${uniq('u')}@pf-b2.test`);
    ok(
      await patch(adminB, `/members/${other.userId}/profile`, {
        profileType: 'student',
        registerNumber: reg,
      }),
    );
  });

  it("a section must belong to the student's batch; unknown or foreign ids are invalid_reference", async () => {
    const s1 = await structure();
    const s2 = await structure();
    const m = await addMember(owner, A.tenantId, `${uniq('u')}@pf-a2.test`);
    const wrongSection = await patch(admin, `/members/${m.userId}/profile`, {
      profileType: 'student',
      batchId: s1.batch.id,
      sectionId: s2.a.id,
    });
    expect(wrongSection.statusCode).toBe(400);
    expect(code(wrongSection)).toBe('invalid_reference');
    expect(
      code(
        await patch(admin, `/members/${m.userId}/profile`, {
          profileType: 'student',
          sectionId: s1.a.id,
        }),
      ),
    ).toBe('invalid_value');
    const sB = await structure(adminB);
    expect(
      code(
        await patch(admin, `/members/${m.userId}/profile`, {
          profileType: 'student',
          batchId: sB.batch.id,
        }),
      ),
    ).toBe('invalid_reference');
    expect(
      code(
        await patch(admin, `/members/${m.userId}/profile`, {
          profileType: 'faculty',
          departmentId: sB.dept.id,
        }),
      ),
    ).toBe('invalid_reference');
  });

  it('nobody can be put into an archived batch or section', async () => {
    const s = await structure();
    const m = await addMember(owner, A.tenantId, `${uniq('u')}@pf-a2.test`);
    ok(await admin.post(`/sections/${s.b.id}/archive`));
    expect(
      code(
        await patch(admin, `/members/${m.userId}/profile`, {
          profileType: 'student',
          batchId: s.batch.id,
          sectionId: s.b.id,
        }),
      ),
    ).toBe('parent_archived');
  });

  it('profiles keep their structure alive: a referenced batch / section / department cannot be deleted', async () => {
    const s = await structure();
    await student(s);
    expect(code(await admin.delete(`/sections/${s.a.id}`))).toBe('in_use');
    expect(code(await admin.delete(`/batches/${s.batch.id}`))).toBe('in_use');
    // archiving is refused while the section is in use? no: it is allowed, history stays readable
    ok(await admin.post(`/sections/${s.a.id}/archive`));
  });

  it('removing a member removes their profile; the membership id is what the profile hangs on', async () => {
    const s = await structure();
    const st = await student(s);
    ok(await admin.delete(`/members/${st.userId}`));
    const left = await owner.query('SELECT 1 FROM lms.member_profiles WHERE membership_id = $1', [
      st.membershipId,
    ]);
    expect(left.rowCount).toBe(0);
  });
});

describe('profile_type is a LABEL: it grants no permissions', () => {
  it('a member whose profile says "faculty" can do exactly what a member without a profile can do', async () => {
    const s = await structure();
    const facultyUser = await addMember(owner, A.tenantId, `${uniq('fac')}@pf-a2.test`);
    ok(
      await patch(admin, `/members/${facultyUser.userId}/profile`, {
        profileType: 'faculty',
        employeeId: uniq('E'),
        departmentId: s.dept.id,
      }),
    );
    const faculty = new TestClient(t, A.host);
    await faculty.login(facultyUser.email, TEST_PASSWORD);
    const plain = new TestClient(t, A.host);
    await plain.login(A.memberEmail, TEST_PASSWORD);

    const target = A.memberUserId;
    const calls: [string, string, unknown?][] = [
      ['GET', '/members'],
      ['GET', `/members/${target}`],
      ['PATCH', `/members/${target}/role`, { role: 'institution_admin' }],
      ['POST', `/members/${target}/suspend`],
      ['DELETE', `/members/${target}`],
      ['GET', `/members/${target}/profile`],
      ['PATCH', `/members/${target}/profile`, { phone: '98765 43210' }],
      ['POST', '/sections/move', { userIds: [target], sectionId: s.a.id }],
      ['GET', '/audit'],
      ['POST', '/auth/invites', { email: 'x@y.test', role: 'member' }],
      ['POST', '/departments', { code: 'NOPE', name: 'x' }],
      ['POST', `/departments/${s.dept.id}/archive`],
      ['GET', '/departments'],
      ['GET', '/me/profile'],
      ['GET', '/platform/tenants'],
    ];
    const run = async (c: TestClient) => {
      const out: number[] = [];
      for (const [method, url, body] of calls) {
        out.push((await c.request(method, url, body === undefined ? {} : { body })).statusCode);
      }
      return out;
    };
    const asFaculty = await run(faculty);
    const asPlain = await run(plain);
    // identical, call for call: the label changed nothing
    expect(asFaculty.map((c, i) => (calls[i]?.[1] === '/me/profile' ? 0 : c))).toEqual(
      asPlain.map((c, i) => (calls[i]?.[1] === '/me/profile' ? 0 : c)),
    );
    // and concretely: everything that manages anything is 403, the two member-level reads are allowed
    const byUrl = Object.fromEntries(calls.map((c, i) => [`${c[0]} ${c[1]}`, asFaculty[i]]));
    expect(byUrl['GET /departments']).toBe(200);
    expect(byUrl['GET /members']).toBe(403);
    expect(byUrl[`PATCH /members/${target}/role`]).toBe(403);
    expect(byUrl['POST /departments']).toBe(403);
    expect(byUrl['GET /audit']).toBe(403);
    expect(byUrl['POST /sections/move']).toBe(403);
    expect(byUrl['GET /platform/tenants']).toBe(403);
  });

  it('and the other way round: an institution admin whose profile says "student" is still an admin', async () => {
    const s = await structure();
    ok(
      await patch(admin, `/members/${A.adminUserId}/profile`, {
        profileType: 'student',
        registerNumber: uniq('ADM'),
        batchId: s.batch.id,
      }),
    );
    expect((await admin.get('/members')).statusCode).toBe(200);
    expect(
      (await admin.post('/departments', { code: uniq('D'), name: 'still allowed' })).statusCode,
    ).toBe(201);
    // a student label also does not stop them changing their own profile away again
    ok(
      await patch(admin, `/members/${A.adminUserId}/profile`, {
        profileType: 'staff',
        registerNumber: null,
        batchId: null,
        sectionId: null,
        employeeId: uniq('E'),
      }),
    );
  });
});

describe('moving students between sections', () => {
  it('moves one student to another section of the same batch, audited with before and after', async () => {
    const s = await structure();
    const st = await student(s, s.a.id);
    const res = ok(
      await admin.post(`/members/${st.userId}/profile/section`, { sectionId: s.b.id }),
    );
    expect(res).toEqual({ moved: 1, unchanged: 0, skipped: [] });
    expect(ok(await admin.get(`/members/${st.userId}/profile`)).sectionCode).toBe('B');
    expect(
      ok(await admin.post(`/members/${st.userId}/profile/section`, { sectionId: s.b.id })),
    ).toEqual({ moved: 0, unchanged: 1, skipped: [] });

    const log = ok(
      await admin.get('/audit', { query: 'action=profile.section_moved&limit=100' }),
    ).items;
    const entry = log.find(
      (e: { metadata: { userId: string } }) => e.metadata.userId === st.userId,
    );
    expect(entry.metadata).toMatchObject({
      before: { sectionId: s.a.id },
      after: { sectionId: s.b.id },
    });
    expect(entry.actorUserId).toBe(A.adminUserId);
  });

  it('bulk: moves many, reports unchanged, and skips anyone who is not a student of that batch', async () => {
    const s = await structure();
    const other = await structure();
    const stA1 = await student(s, s.a.id);
    const stA2 = await student(s, s.a.id);
    const stB = await student(s, s.b.id);
    const otherBatch = await student(other, other.a.id);
    const faculty = await addMember(owner, A.tenantId, `${uniq('f')}@pf-a2.test`);
    ok(
      await patch(admin, `/members/${faculty.userId}/profile`, {
        profileType: 'faculty',
        employeeId: uniq('E'),
      }),
    );
    const noProfile = await addMember(owner, A.tenantId, `${uniq('n')}@pf-a2.test`);
    const stranger = await addMember(owner, B.tenantId, `${uniq('o')}@pf-b2.test`);

    const before = ok(
      await admin.get('/audit', { query: 'action=profile.section_moved&limit=100' }),
    ).items.length;
    const userIds = [stA1, stA2, stB, otherBatch, faculty, noProfile, stranger].map(
      (x) => x.userId,
    );
    const res = ok(await admin.post('/sections/move', { userIds, sectionId: s.b.id }));
    expect(res.moved).toBe(2);
    expect(res.unchanged).toBe(1);
    expect(res.skipped.sort()).toEqual(
      [otherBatch.userId, faculty.userId, noProfile.userId, stranger.userId].sort(),
    );
    const after = ok(await admin.get('/audit', { query: 'action=profile.section_moved&limit=100' }))
      .items.length;
    expect(after - before).toBe(2); // one entry per student actually moved
    expect(ok(await admin.get(`/members/${stA1.userId}/profile`)).sectionCode).toBe('B');
    expect(ok(await admin.get(`/members/${otherBatch.userId}/profile`)).sectionId).toBe(other.a.id);
    expect(
      await admin
        .post('/sections/move', { userIds: [], sectionId: s.b.id })
        .then((r) => r.statusCode),
    ).toBe(400);
    expect(
      await admin
        .post('/sections/move', { userIds: Array(501).fill(stA1.userId), sectionId: s.b.id })
        .then((r) => r.statusCode),
    ).toBe(400);
  });

  it('an archived or unknown target section is refused', async () => {
    const s = await structure();
    const st = await student(s);
    ok(await admin.post(`/sections/${s.b.id}/archive`));
    expect(
      code(await admin.post(`/members/${st.userId}/profile/section`, { sectionId: s.b.id })),
    ).toBe('section_not_found');
    expect(
      code(
        await admin.post('/sections/move', {
          userIds: [st.userId],
          sectionId: '00000000-0000-7000-8000-000000000000',
        }),
      ),
    ).toBe('section_not_found');
  });
});

describe('GET /members filters', () => {
  it('filters by profile type, department, batch and section, shows profile fields, and paginates', async () => {
    const s = await structure();
    const other = await structure();
    const stA = [await student(s, s.a.id), await student(s, s.a.id), await student(s, s.a.id)];
    const stB = await student(s, s.b.id);
    const stOther = await student(other, other.a.id);
    const fac = await addMember(owner, A.tenantId, `${uniq('f')}@pf-a2.test`);
    ok(
      await patch(admin, `/members/${fac.userId}/profile`, {
        profileType: 'faculty',
        employeeId: uniq('E'),
        departmentId: s.dept.id,
      }),
    );

    const ids = async (query: string) => {
      const out: string[] = [];
      let after: string | null = null;
      do {
        const page: Json = ok(
          await admin.get('/members', {
            query: `${query}&limit=2${after ? `&after=${after}` : ''}`,
          }),
        );
        out.push(...page.items.map((m: { userId: string }) => m.userId));
        after = page.nextCursor;
      } while (after);
      return out;
    };
    expect(await ids(`sectionId=${s.a.id}`)).toEqual(stA.map((x) => x.userId));
    expect(await ids(`sectionId=${s.b.id}`)).toEqual([stB.userId]);
    expect((await ids(`batchId=${s.batch.id}`)).sort()).toEqual(
      [...stA, stB].map((x) => x.userId).sort(),
    );
    expect((await ids(`departmentId=${s.dept.id}`)).sort()).toEqual(
      [...stA, stB, fac].map((x) => x.userId).sort(),
    );
    expect(await ids(`departmentId=${other.dept.id}`)).toEqual([stOther.userId]);
    expect(await ids(`profileType=faculty&departmentId=${s.dept.id}`)).toEqual([fac.userId]);
    expect((await ids('profileType=student')).length).toBeGreaterThanOrEqual(5);
    expect(await ids(`sectionId=${s.a.id}&role=institution_admin`)).toEqual([]);

    const row = ok(await admin.get('/members', { query: `sectionId=${s.a.id}&limit=1` })).items[0];
    expect(row).toMatchObject({
      profileType: 'student',
      sectionId: s.a.id,
      batchId: s.batch.id,
      departmentId: s.dept.id,
    });
    expect(row.registerNumber).toEqual(expect.any(String));
    // members without a profile still list, with null profile fields
    const plain = ok(await admin.get(`/members/${A.memberUserId}`));
    expect(plain.profileType).toBeNull();
    expect((await admin.get('/members', { query: 'profileType=alien' })).statusCode).toBe(400);
    expect((await admin.get('/members', { query: 'sectionId=nope' })).statusCode).toBe(400);
  });
});

describe('tenant isolation and audit', () => {
  it("another college's admin can neither read nor change a member's profile", async () => {
    const s = await structure();
    const st = await student(s);
    expect(code(await adminB.get(`/members/${st.userId}/profile`))).toBe('member_not_found');
    expect(
      code(await patch(adminB, `/members/${st.userId}/profile`, { phone: '98765 43210' })),
    ).toBe('member_not_found');
    const sB = await structure(adminB);
    // B's admin moving A's student into B's own section: A's student is invisible there, so skipped
    const r = ok(await adminB.post('/sections/move', { userIds: [st.userId], sectionId: sB.a.id }));
    expect(r).toEqual({ moved: 0, unchanged: 0, skipped: [st.userId] });
  });

  it('profile changes are audited with before and after', async () => {
    const m = await addMember(owner, A.tenantId, `${uniq('au')}@pf-a2.test`);
    ok(
      await patch(admin, `/members/${m.userId}/profile`, {
        profileType: 'staff',
        employeeId: uniq('E'),
        phone: '98765 43210',
      }),
    );
    ok(await patch(admin, `/members/${m.userId}/profile`, { phone: '98765 00000' }));
    const find = async (action: string) =>
      ok(await admin.get('/audit', { query: `action=${action}&limit=100` })).items.find(
        (e: { metadata: { userId: string } }) => e.metadata.userId === m.userId,
      );
    expect((await find('profile.created')).metadata.after).toMatchObject({ profile_type: 'staff' });
    const upd = await find('profile.updated');
    expect(upd.metadata.before.phone).toBe('98765 43210');
    expect(upd.metadata.after.phone).toBe('98765 00000');
  });
});

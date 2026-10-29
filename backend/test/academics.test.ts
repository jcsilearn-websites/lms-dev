import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import { type AuthFixture, createAuthFixture, TEST_PASSWORD, testOwnerPool } from './support';

// Academic structure: CRUD, archive rules, DB-enforced invariants, tenant isolation, audit.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
let admin: TestClient;
let adminB: TestClient;
let member: TestClient;
let n = 0;
const uniq = (p: string) => `${p}${++n}`;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp();
  A = await createAuthFixture(owner, 'ac-a');
  B = await createAuthFixture(owner, 'ac-b');
  await t.app.ready();
  const login = async (host: string, email: string) => {
    const c = new TestClient(t, host);
    expect((await c.login(email, TEST_PASSWORD)).statusCode).toBe(200);
    return c;
  };
  admin = await login(A.host, A.adminEmail);
  member = await login(A.host, A.memberEmail);
  adminB = await login(B.host, B.adminEmail);
});

afterAll(async () => {
  await t.close();
  await owner.end();
});

const patch = (c: TestClient, url: string, body: unknown) => c.request('PATCH', url, { body });
// biome-ignore lint/suspicious/noExplicitAny: a test helper that returns whatever JSON the API sent
type Json = any;
const ok = (res: { statusCode: number; body: string; json(): Json }): Json => {
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json();
};
const code = (res: { json(): { error: { code: string } } }) => res.json().error.code;

async function department(c = admin, codeValue = uniq('D')) {
  return ok(await c.post('/departments', { code: codeValue, name: `Department ${codeValue}` })) as {
    id: string;
    code: string;
  };
}
async function program(departmentId: string, codeValue = uniq('P')) {
  return ok(
    await admin.post('/programs', {
      departmentId,
      code: codeValue,
      name: 'A Program',
      durationYears: 4,
    }),
  ) as { id: string };
}
async function batch(programId: string, admissionYear = 2023) {
  return ok(
    await admin.post('/batches', { programId, admissionYear, graduationYear: admissionYear + 4 }),
  ) as { id: string; label: string };
}
async function section(batchId: string, codeValue = 'A') {
  return ok(await admin.post('/sections', { batchId, code: codeValue })) as { id: string };
}
async function year(label = uniq('Y'), startDate = '2026-06-01', endDate = '2027-05-31') {
  return ok(await admin.post('/academic-years', { label, startDate, endDate })) as {
    id: string;
    isCurrent: boolean;
  };
}

describe('departments: validation, normalization, codes', () => {
  it('trims names, uppercases codes, and refuses duplicate codes (case-insensitively)', async () => {
    const c = uniq('cse');
    const d = ok(
      await admin.post('/departments', { code: ` ${c} `, name: '  Computer   Science  ' }),
    );
    expect(d).toMatchObject({ code: c.toUpperCase(), name: 'Computer Science', archivedAt: null });
    const dup = await admin.post('/departments', { code: c.toUpperCase(), name: 'Other' });
    expect(dup.statusCode).toBe(409);
    expect(code(dup)).toBe('duplicate_code');
    // the same code in another college is fine
    ok(await adminB.post('/departments', { code: c, name: 'Same code, other college' }));
  });

  it('rejects malformed codes and empty names with per-field details', async () => {
    const res = await admin.post('/departments', { code: 'bad code!', name: '   ' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_value');
    expect(
      res
        .json()
        .error.details.map((x: { path: string }) => x.path)
        .sort(),
    ).toEqual(['code', 'name']);
  });

  it('updates the name and code; an empty update is refused; a parent cannot be changed', async () => {
    const d = await department();
    const p = await program(d.id);
    const other = await department();
    const upd = ok(
      await patch(admin, `/programs/${p.id}`, { name: '  New  Name ', departmentId: other.id }),
    );
    expect(upd).toMatchObject({ name: 'New Name', departmentId: d.id }); // departmentId ignored
    expect((await patch(admin, `/programs/${p.id}`, {})).json().error.code).toBe(
      'nothing_to_update',
    );
    expect((await patch(admin, `/programs/${p.id}`, { name: '' })).statusCode).toBe(400);
    // and the database itself refuses it (immutable parent)
    await expect(
      owner.query('UPDATE lms.programs SET department_id = $1 WHERE id = $2', [other.id, p.id]),
    ).rejects.toThrow(/cannot be changed/);
  });
});

describe('the hierarchy', () => {
  it('department -> program -> batch -> section, with filters by parent', async () => {
    const d = await department();
    const p1 = await program(d.id);
    const p2 = await program(d.id);
    const b = await batch(p1.id, 2023);
    expect(b.label).toBe('2023-2027');
    const s1 = await section(b.id, 'a');
    const s2 = await section(b.id, 'B');
    expect(ok(await admin.get(`/sections/${s1.id}`))).toMatchObject({ code: 'A', batchId: b.id });

    const progs = ok(await admin.get('/programs', { query: `departmentId=${d.id}` })).items;
    expect(progs.map((x: { id: string }) => x.id)).toEqual([p1.id, p2.id]);
    const secs = ok(await admin.get('/sections', { query: `batchId=${b.id}` })).items;
    expect(secs.map((x: { code: string }) => x.code)).toEqual(['A', 'B']);
    expect(ok(await admin.get('/batches', { query: `programId=${p2.id}` })).items).toEqual([]);
    expect(
      ok(await admin.get('/batches', { query: `programId=${p1.id}&admissionYear=2023` })).items,
    ).toHaveLength(1);
    expect(s2.id).toBeTruthy();
  });

  it('refuses duplicate sections and batches, and bad year pairs', async () => {
    const d = await department();
    const p = await program(d.id);
    const b = await batch(p.id, 2022);
    await section(b.id, 'A');
    expect(code(await admin.post('/sections', { batchId: b.id, code: 'a' }))).toBe(
      'duplicate_code',
    );
    const dup = await admin.post('/batches', {
      programId: p.id,
      admissionYear: 2022,
      graduationYear: 2026,
    });
    expect(code(dup)).toBe('duplicate_batch');
    const bad = await admin.post('/batches', {
      programId: p.id,
      admissionYear: 2024,
      graduationYear: 2024,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details[0].path).toBe('graduationYear');
    expect((await patch(admin, `/batches/${b.id}`, { graduationYear: 2021 })).statusCode).toBe(400);
    ok(await patch(admin, `/batches/${b.id}`, { graduationYear: 2027 })); // a 5-year course
  });

  it('a parent that does not exist (or belongs to another college) is a 400 invalid_reference', async () => {
    const dOfB = await department(adminB);
    for (const body of [
      { departmentId: dOfB.id, code: uniq('X'), name: 'x', durationYears: 3 },
      {
        departmentId: '00000000-0000-7000-8000-000000000000',
        code: uniq('X'),
        name: 'x',
        durationYears: 3,
      },
    ]) {
      const res = await admin.post('/programs', body);
      expect(res.statusCode).toBe(400);
      expect(code(res)).toBe('invalid_reference');
    }
  });

  it('paginates with keyset pages: no duplicates, no gaps', async () => {
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push((await department()).id);
    const seen: string[] = [];
    let after: string | null = null;
    do {
      const page = ok(
        await admin.get('/departments', {
          query: `limit=2${after ? `&after=${after}` : ''}`,
        }),
      );
      seen.push(...page.items.map((x: { id: string }) => x.id));
      after = page.nextCursor;
    } while (after);
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of made) expect(seen).toContain(id);
    expect(code(await admin.get('/departments', { query: 'after=nope' }))).toBe('invalid_cursor');
  });
});

describe('archive and delete', () => {
  it('archiving is refused while active children exist; unarchiving while the parent is archived', async () => {
    const d = await department();
    const p = await program(d.id);
    const b = await batch(p.id);
    const s = await section(b.id);

    for (const url of [`/departments/${d.id}`, `/programs/${p.id}`, `/batches/${b.id}`]) {
      const res = await admin.post(`${url}/archive`);
      expect(res.statusCode, url).toBe(409);
      expect(code(res)).toBe('has_active_children');
    }
    // leaf first
    expect(ok(await admin.post(`/sections/${s.id}/archive`)).archivedAt).not.toBeNull();
    ok(await admin.post(`/batches/${b.id}/archive`));
    ok(await admin.post(`/programs/${p.id}/archive`));
    ok(await admin.post(`/departments/${d.id}/archive`));

    // a child cannot come back (or be created) under an archived parent
    expect(code(await admin.post(`/programs/${p.id}/unarchive`))).toBe('parent_archived');
    expect(
      code(
        await admin.post('/programs', {
          departmentId: d.id,
          code: uniq('Z'),
          name: 'x',
          durationYears: 2,
        }),
      ),
    ).toBe('parent_archived');
    ok(await admin.post(`/departments/${d.id}/unarchive`));
    ok(await admin.post(`/programs/${p.id}/unarchive`));
    expect(code(await admin.post(`/programs/${p.id}/unarchive`))).toBe('not_archived');
    expect(code(await admin.post(`/departments/${d.id}/archive`))).toBe('has_active_children');
  });

  it('archived rows leave the default list but stay readable and listable with archived=true|all', async () => {
    const d = await department();
    ok(await admin.post(`/departments/${d.id}/archive`));
    const active = (await admin.get('/departments', { query: 'limit=100' })).json().items;
    const archived = (await admin.get('/departments', { query: 'archived=true&limit=100' })).json()
      .items;
    const all = (await admin.get('/departments', { query: 'archived=all&limit=100' })).json().items;
    expect(active.some((x: { id: string }) => x.id === d.id)).toBe(false);
    expect(archived.some((x: { id: string }) => x.id === d.id)).toBe(true);
    expect(all.some((x: { id: string }) => x.id === d.id)).toBe(true);
    expect(ok(await admin.get(`/departments/${d.id}`)).archivedAt).not.toBeNull();
    expect(code(await admin.post(`/departments/${d.id}/archive`))).toBe('already_archived');
  });

  it('hard delete works only when nothing references the row', async () => {
    const d = await department();
    const p = await program(d.id);
    expect(code(await admin.delete(`/departments/${d.id}`))).toBe('in_use');
    // archived does not mean unreferenced
    ok(await admin.post(`/programs/${p.id}/archive`));
    expect(code(await admin.delete(`/departments/${d.id}`))).toBe('in_use');
    expect(ok(await admin.delete(`/programs/${p.id}`)).status).toBe('deleted');
    expect(ok(await admin.delete(`/departments/${d.id}`)).status).toBe('deleted');
    expect((await admin.get(`/departments/${d.id}`)).statusCode).toBe(404);
    expect((await admin.delete(`/departments/${d.id}`)).statusCode).toBe(404);
  });
});

describe('academic years: exactly one current', () => {
  it('set-current swaps the flag in one statement; the database allows only one current year', async () => {
    const y1 = await year('2026-27', '2026-06-01', '2027-05-31');
    const y2 = await year('2027-28', '2027-06-01', '2028-05-31');
    expect(y1.isCurrent).toBe(false);
    expect(ok(await admin.post(`/academic-years/${y1.id}/set-current`)).isCurrent).toBe(true);
    expect(ok(await admin.post(`/academic-years/${y1.id}/set-current`)).isCurrent).toBe(true); // idempotent
    expect(ok(await admin.post(`/academic-years/${y2.id}/set-current`)).isCurrent).toBe(true);

    const current = ok(await admin.get('/academic-years', { query: 'current=true' })).items;
    expect(current.map((x: { id: string }) => x.id)).toEqual([y2.id]);
    expect(ok(await admin.get(`/academic-years/${y1.id}`)).isCurrent).toBe(false);

    // the invariant is the database's, not the API's
    await expect(
      owner.query('UPDATE lms.academic_years SET is_current = true WHERE id = $1', [y1.id]),
    ).rejects.toThrow(/academic_years_one_current|conflicting key/);
    // another college has its own current year
    const yb = ok(
      await adminB.post('/academic-years', {
        label: '2026-27',
        startDate: '2026-06-01',
        endDate: '2027-05-31',
      }),
    );
    expect(ok(await adminB.post(`/academic-years/${yb.id}/set-current`)).isCurrent).toBe(true);
  });

  it('the current year cannot be archived; an archived year cannot become current', async () => {
    const y = await year();
    ok(await admin.post(`/academic-years/${y.id}/set-current`));
    expect(code(await admin.post(`/academic-years/${y.id}/archive`))).toBe('current_year_archived');
    const other = await year();
    ok(await admin.post(`/academic-years/${other.id}/archive`));
    expect(code(await admin.post(`/academic-years/${other.id}/set-current`))).toBe(
      'current_year_archived',
    );
    expect(
      (await admin.post('/academic-years/00000000-0000-7000-8000-000000000000/set-current'))
        .statusCode,
    ).toBe(404);
  });

  it('labels are unique per college and start must precede end', async () => {
    const label = uniq('L');
    await year(label);
    expect(
      code(
        await admin.post('/academic-years', {
          label,
          startDate: '2030-06-01',
          endDate: '2031-05-31',
        }),
      ),
    ).toBe('duplicate_label');
    const bad = await admin.post('/academic-years', {
      label: uniq('L'),
      startDate: '2030-06-01',
      endDate: '2030-06-01',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details[0].path).toBe('endDate');
    expect(
      (
        await admin.post('/academic-years', {
          label: uniq('L'),
          startDate: '2030-02-30',
          endDate: '2031-01-01',
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('terms: no overlaps within a year, inside the year', () => {
  it('refuses overlapping terms (database exclusion constraint) but allows adjacent ones', async () => {
    const y = await year(uniq('T'), '2040-06-01', '2041-05-31');
    const mk = (name: string, startDate: string, endDate: string) =>
      admin.post('/terms', { academicYearId: y.id, name, startDate, endDate });
    ok(await mk('Odd semester', '2040-06-01', '2040-11-30'));
    const overlap = await mk('Bad', '2040-11-30', '2041-03-31'); // shares 30 Nov
    expect(overlap.statusCode).toBe(409);
    expect(code(overlap)).toBe('term_overlap');
    ok(await mk('Even semester', '2040-12-01', '2041-05-31'));
    expect(code(await mk('Odd semester', '2041-05-31', '2041-05-31'))).toMatch(
      /duplicate_name|invalid_value/,
    );

    const terms = ok(await admin.get('/terms', { query: `academicYearId=${y.id}` })).items;
    expect(terms.map((x: { name: string }) => x.name)).toEqual(['Odd semester', 'Even semester']);

    // another year may reuse the same dates range? no: it must lie inside ITS year, and years are separate
    const y2 = await year(uniq('T'), '2041-06-01', '2042-05-31');
    ok(
      await admin.post('/terms', {
        academicYearId: y2.id,
        name: 'Odd semester',
        startDate: '2041-06-01',
        endDate: '2041-11-30',
      }),
    );
  });

  it('a changed term cannot start to overlap; an archived term no longer blocks its dates', async () => {
    const y = await year(uniq('T'), '2050-06-01', '2051-05-31');
    const t1 = ok(
      await admin.post('/terms', {
        academicYearId: y.id,
        name: 'One',
        startDate: '2050-06-01',
        endDate: '2050-09-30',
      }),
    );
    const t2 = ok(
      await admin.post('/terms', {
        academicYearId: y.id,
        name: 'Two',
        startDate: '2050-10-01',
        endDate: '2051-01-31',
      }),
    );
    expect(code(await patch(admin, `/terms/${t2.id}`, { startDate: '2050-09-01' }))).toBe(
      'term_overlap',
    );
    ok(await admin.post(`/terms/${t1.id}/archive`));
    ok(await patch(admin, `/terms/${t2.id}`, { startDate: '2050-09-01' })); // t1 is archived: free
    expect(code(await admin.post(`/terms/${t1.id}/unarchive`))).toBe('term_overlap');
  });

  it('a term must lie inside its academic year, and a year cannot move away from its terms', async () => {
    const y = await year(uniq('T'), '2060-06-01', '2061-05-31');
    const outside = await admin.post('/terms', {
      academicYearId: y.id,
      name: 'Out',
      startDate: '2061-05-01',
      endDate: '2061-07-01',
    });
    expect(outside.statusCode).toBe(400);
    expect(code(outside)).toBe('term_outside_year');
    const inside = ok(
      await admin.post('/terms', {
        academicYearId: y.id,
        name: 'In',
        startDate: '2060-06-01',
        endDate: '2060-12-31',
      }),
    );
    expect(code(await patch(admin, `/academic-years/${y.id}`, { startDate: '2060-07-01' }))).toBe(
      'term_outside_year',
    );
    ok(await patch(admin, `/academic-years/${y.id}`, { endDate: '2061-08-31' }));
    expect(inside.id).toBeTruthy();
    // archiving the year while it has an active term is refused
    expect(code(await admin.post(`/academic-years/${y.id}/archive`))).toBe('has_active_children');
  });
});

describe('authorization and tenant isolation', () => {
  it('every active member can read the structure; only an institution admin can change it', async () => {
    const d = await department();
    expect((await member.get('/departments')).statusCode).toBe(200);
    expect((await member.get(`/departments/${d.id}`)).statusCode).toBe(200);
    expect((await member.post('/departments', { code: 'NOPE', name: 'x' })).statusCode).toBe(403);
    expect((await patch(member, `/departments/${d.id}`, { name: 'x' })).statusCode).toBe(403);
    expect((await member.post(`/departments/${d.id}/archive`)).statusCode).toBe(403);
    expect((await member.delete(`/departments/${d.id}`)).statusCode).toBe(403);
    expect((await new TestClient(t, A.host).get('/departments')).statusCode).toBe(401);
  });

  it("another college's rows are invisible and untouchable", async () => {
    const dB = await department(adminB);
    expect((await admin.get(`/departments/${dB.id}`)).statusCode).toBe(404);
    expect((await patch(admin, `/departments/${dB.id}`, { name: 'hijack' })).statusCode).toBe(404);
    expect((await admin.post(`/departments/${dB.id}/archive`)).statusCode).toBe(404);
    expect((await admin.delete(`/departments/${dB.id}`)).statusCode).toBe(404);
    const mine = (await admin.get('/departments', { query: 'archived=all&limit=100' })).json()
      .items;
    expect(mine.some((x: { id: string }) => x.id === dB.id)).toBe(false);
    expect(ok(await adminB.get(`/departments/${dB.id}`))).toMatchObject({ id: dB.id });
  });
});

describe('audit', () => {
  it('every change is audited with before/after values', async () => {
    const d = await department();
    ok(await patch(admin, `/departments/${d.id}`, { name: 'Renamed' }));
    ok(await admin.post(`/departments/${d.id}/archive`));
    const log = async (action: string) =>
      (await admin.get('/audit', { query: `action=${action}&limit=100` }))
        .json()
        .items.find((e: { targetId: string }) => e.targetId === d.id);
    expect((await log('academic.department.created')).metadata.after).toMatchObject({ id: d.id });
    const updated = await log('academic.department.updated');
    expect(updated.metadata.before.name).toBe(`Department ${d.code}`);
    expect(updated.metadata.after.name).toBe('Renamed');
    expect((await log('academic.department.archived')).actorUserId).toBe(A.adminUserId);
    ok(await admin.post(`/departments/${d.id}/unarchive`));
    ok(await admin.delete(`/departments/${d.id}`));
    expect((await log('academic.department.deleted')).metadata.before.id).toBe(d.id);
  });
});

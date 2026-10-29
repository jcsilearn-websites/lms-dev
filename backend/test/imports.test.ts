import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { createImportsRepository } from '../src/modules/imports';
import { makeApp, type TestApp } from './app';
import { lastTokenFor, TestClient } from './client';
import { addMember } from './fixtures';
import {
  count,
  csv,
  FACULTY_HEADER,
  STUDENT_HEADER,
  startRunner,
  upload,
  waitForImport,
} from './imports-helpers';
import { type AuthFixture, createAuthFixture, TEST_PASSWORD, testOwnerPool } from './support';

// Bulk CSV import: upload -> validate (dry run) -> review -> confirm -> background processing.

let owner: pg.Pool;
let t: TestApp;
let small: TestApp; // an app with tiny limits
let A: AuthFixture;
let B: AuthFixture;
let admin: TestClient;
let member: TestClient;
let adminB: TestClient;
let adminSmall: TestClient;
let n = 0;
const uniq = (p: string) => `${p}${++n}`;

// biome-ignore lint/suspicious/noExplicitAny: a test helper that returns whatever JSON the API sent
type Json = any;
const ok = (res: { statusCode: number; body: string; json(): Json }): Json => {
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json();
};
const code = (res: { json(): Json }) => res.json().error.code;

const S = {
  dept: '',
  deptM: '',
  prog: '',
  progM: '',
  batch: '',
  batch2: '',
  secA: '',
  secB: '',
};

const headerWithPhone = `${STUDENT_HEADER},phone`;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { IMPORT_BATCH_SIZE: '500' } });
  small = makeApp({ env: { IMPORT_MAX_ROWS: '5', IMPORT_MAX_BYTES: '2048' } });
  A = await createAuthFixture(owner, 'im-a');
  B = await createAuthFixture(owner, 'im-b');
  await t.app.ready();
  await small.app.ready();
  const login = async (app: TestApp, host: string, email: string) => {
    const c = new TestClient(app, host);
    expect((await c.login(email, TEST_PASSWORD)).statusCode).toBe(200);
    return c;
  };
  admin = await login(t, A.host, A.adminEmail);
  member = await login(t, A.host, A.memberEmail);
  adminB = await login(t, B.host, B.adminEmail);
  adminSmall = await login(small, A.host, A.adminEmail);

  const mk = async (url: string, body: unknown) => ok(await admin.post(url, body)).id as string;
  S.dept = await mk('/departments', { code: 'CSE', name: 'Computer Science' });
  S.deptM = await mk('/departments', { code: 'MECH', name: 'Mechanical' });
  S.prog = await mk('/programs', {
    departmentId: S.dept,
    code: 'BE',
    name: 'B.E. CSE',
    durationYears: 4,
  });
  S.progM = await mk('/programs', {
    departmentId: S.deptM,
    code: 'BME',
    name: 'B.E. Mech',
    durationYears: 4,
  });
  S.batch = await mk('/batches', { programId: S.prog, admissionYear: 2023, graduationYear: 2027 });
  S.batch2 = await mk('/batches', { programId: S.prog, admissionYear: 2024, graduationYear: 2028 });
  S.secA = await mk('/sections', { batchId: S.batch, code: 'A' });
  S.secB = await mk('/sections', { batchId: S.batch, code: 'B' });
});

afterAll(async () => {
  await t.close();
  await small.close();
  await owner.end();
});

const ownerCounts = async () => ({
  users: await count(owner, 'SELECT count(*)::int AS n FROM lms.users'),
  memberships: await count(owner, 'SELECT count(*)::int AS n FROM lms.tenant_memberships'),
  profiles: await count(owner, 'SELECT count(*)::int AS n FROM lms.member_profiles'),
  tokens: await count(owner, 'SELECT count(*)::int AS n FROM lms.auth_tokens'),
  importJobs: await count(
    owner,
    "SELECT count(*)::int AS n FROM lms.jobs WHERE queue IN ('imports.process', 'invites.send')",
  ),
});

describe('templates', () => {
  it('download the exact headers', async () => {
    const s = await admin.get('/imports/templates/students.csv');
    expect(s.statusCode).toBe(200);
    expect(s.headers['content-type']).toContain('text/csv');
    expect(s.body).toBe(
      'email,full_name,register_number,department_code,program_code,batch,section\r\n',
    );
    expect((await admin.get('/imports/templates/faculty.csv')).body).toBe(
      'email,full_name,employee_id,department_code\r\n',
    );
    expect((await member.get('/imports/templates/students.csv')).statusCode).toBe(403);
  });
});

describe('the dry run: every validation rule', () => {
  it('reports row number and column for each problem, and writes NOTHING to the real tables', async () => {
    // existing members of this college: a student with a register number and a faculty member
    const m1 = await addMember(owner, A.tenantId, 'm1@im-a.test', {
      displayName: 'Existing Student',
    });
    const prof = await admin.request('PATCH', `/members/${m1.userId}/profile`, {
      body: {
        profileType: 'student',
        registerNumber: 'EXIST-1',
        batchId: S.batch,
        sectionId: S.secA,
      },
    });
    expect(prof.statusCode, prof.body).toBe(200);
    const m2 = await addMember(owner, A.tenantId, 'm2@im-a.test', {
      displayName: 'Second Student',
    });
    ok(
      await admin.request('PATCH', `/members/${m2.userId}/profile`, {
        body: {
          profileType: 'student',
          registerNumber: 'EXIST-2',
          batchId: S.batch,
          sectionId: S.secA,
        },
      }),
    );

    const base = ['', '', '', 'CSE', 'BE', '2023-2027', 'A', ''];
    const row = (over: Record<number, string>) => base.map((v, i) => over[i] ?? v);
    const rows = [
      /* 2  */ row({ 0: 'ok1@im-a.test', 1: 'Ada Lovelace', 2: 'REG-OK1' }),
      /* 3  */ row({ 0: 'not-an-email', 1: 'X', 2: 'R3' }),
      /* 4  */ row({ 0: '', 1: 'X', 2: 'R4' }),
      /* 5  */ row({ 0: 'ok1@im-a.test', 1: 'Dup email', 2: 'R5' }),
      /* 6  */ row({ 0: 'dupreg@im-a.test', 1: 'Dup reg', 2: 'REG-OK1' }),
      /* 7  */ row({ 0: 'taken@im-a.test', 1: 'Taken', 2: 'EXIST-1' }),
      /* 8  */ row({ 0: 'm1@im-a.test', 1: 'Existing Student', 2: 'DIFFERENT-9' }),
      /* 9  */ row({ 0: 'r9@im-a.test', 1: 'X', 2: 'R9', 3: 'XXX' }),
      /* 10 */ row({ 0: 'r10@im-a.test', 1: 'X', 2: 'R10', 4: 'BME' }),
      /* 11 */ row({ 0: 'r11@im-a.test', 1: 'X', 2: 'R11', 4: 'NOPE' }),
      /* 12 */ row({ 0: 'r12@im-a.test', 1: 'X', 2: 'R12', 5: '2023/27' }),
      /* 13 */ row({ 0: 'r13@im-a.test', 1: 'X', 2: 'R13', 5: '2030-2034' }),
      /* 14 */ row({ 0: 'r14@im-a.test', 1: 'X', 2: 'R14', 6: 'Z' }),
      /* 15 */ row({ 0: 'r15@im-a.test', 1: '=cmd|calc', 2: 'R15' }),
      /* 16 */ row({ 0: 'r16@im-a.test', 1: '+SUM(A1)', 2: 'R16' }),
      /* 17 */ row({ 0: 'r17@im-a.test', 1: 'X', 2: '@R17' }),
      /* 18 */ row({ 0: 'r18@im-a.test', 1: '-5', 2: 'R18' }),
      /* 19 */ ['r19@im-a.test', '', '', '', '', '', '', ''],
      /* 20 */ row({
        0: 'UP@Im-A.test',
        1: 'Case Insensitive',
        2: 'R20',
        3: 'cse',
        4: 'be',
        6: 'b',
      }),
      /* 21 */ row({ 0: 'm2@im-a.test', 1: 'Second Student', 2: 'EXIST-2' }),
      /* 22 */ row({ 0: 'r22@im-a.test', 1: 'Phone ok', 2: 'R22', 7: '+91 98765 43210' }),
      /* 23 */ row({ 0: 'r23@im-a.test', 1: 'Phone formula', 2: 'R23', 7: '+SUM(A1)' }),
      /* 24 */ row({ 0: 'r24@im-a.test', 1: 'Phone junk', 2: 'R24', 7: '12ab' }),
    ];
    const before = await ownerCounts();
    const res = await upload(admin, 'students', csv(headerWithPhone, rows), {
      fileName: 'students.csv',
    });
    const imp = ok(res);
    expect(res.statusCode).toBe(201);
    expect(imp).toMatchObject({
      kind: 'students',
      fileName: 'students.csv',
      status: 'validated',
      counts: { total: 23, valid: 4, invalid: 19, processed: 0 },
    });
    // NOTHING reached the real tables (and no job was enqueued): it is a dry run
    expect(await ownerCounts()).toEqual(before);

    const all = ok(await admin.get(`/imports/${imp.id}/rows`, { query: 'limit=500' }))
      .items as Json[];
    const byRow = new Map(all.map((r) => [r.rowNumber as number, r]));
    const errs = (rn: number) =>
      ((byRow.get(rn)?.errors ?? []) as { column: string; message: string }[]).map(
        (e) => `${e.column}: ${e.message}`,
      );
    const has = (rn: number, column: string, re: RegExp) =>
      expect(
        errs(rn).some((e) => e.startsWith(`${column}:`) && re.test(e)),
        `row ${rn}: ${errs(rn)}`,
      ).toBe(true);

    expect(byRow.get(2)?.status).toBe('valid');
    has(3, 'email', /not a valid email/);
    has(4, 'email', /required/);
    has(5, 'email', /appears earlier in the file/);
    has(6, 'register_number', /appears earlier in the file/);
    has(7, 'register_number', /already used by another member/);
    has(8, 'register_number', /already a member with register number EXIST-1/);
    has(9, 'department_code', /unknown/);
    has(10, 'program_code', /unknown/);
    has(11, 'program_code', /unknown/);
    has(12, 'batch', /must look like 2023-2027/);
    has(13, 'batch', /unknown/);
    has(14, 'section', /unknown/);
    has(15, 'full_name', /must not start with "="/);
    has(16, 'full_name', /must not start with "\+"/);
    has(17, 'register_number', /must not start with "@"/);
    has(18, 'full_name', /must not start with "-"/);
    for (const c of [
      'full_name',
      'register_number',
      'department_code',
      'program_code',
      'batch',
      'section',
    ]) {
      has(19, c, /required/);
    }
    expect(byRow.get(20)?.status).toBe('valid'); // codes are case-insensitive, the email is lowercased
    expect(byRow.get(21)?.status).toBe('valid'); // an existing member with the SAME register number
    expect(byRow.get(22)?.status).toBe('valid'); // "+91 98765 43210" is a valid phone
    has(23, 'phone', /may start with \+ or - only/);
    has(24, 'phone', /not a valid phone/);

    // the review endpoint filters and pages by row number
    const invalid = ok(
      await admin.get(`/imports/${imp.id}/rows`, { query: 'status=invalid&limit=5' }),
    );
    expect(invalid.items.map((r: Json) => r.rowNumber)).toEqual([3, 4, 5, 6, 7]);
    const next = ok(
      await admin.get(`/imports/${imp.id}/rows`, {
        query: `status=invalid&limit=5&after=${invalid.nextCursor}`,
      }),
    );
    expect(next.items[0].rowNumber).toBe(8);
  });

  it('faculty rules: employee id format / duplicates / taken, existing members, unknown department', async () => {
    const f1 = await addMember(owner, A.tenantId, 'f1@im-a.test');
    ok(
      await admin.request('PATCH', `/members/${f1.userId}/profile`, {
        body: { profileType: 'faculty', employeeId: 'EMP-1', departmentId: S.dept },
      }),
    );
    const f2 = await addMember(owner, A.tenantId, 'f2@im-a.test');
    ok(
      await admin.request('PATCH', `/members/${f2.userId}/profile`, {
        body: { profileType: 'faculty', employeeId: 'EMP-22', departmentId: S.dept },
      }),
    );
    const stu = await addMember(owner, A.tenantId, 'stu-for-fac@im-a.test');
    ok(
      await admin.request('PATCH', `/members/${stu.userId}/profile`, {
        body: { profileType: 'student', registerNumber: 'R-FAC', batchId: S.batch },
      }),
    );
    const rows = [
      /* 2 */ ['fac-ok@im-a.test', 'Grace Hopper', 'EMP-100', 'CSE'],
      /* 3 */ ['fac-dup@im-a.test', 'Dup', 'EMP-100', 'CSE'],
      /* 4 */ ['fac-taken@im-a.test', 'Taken', 'EMP-1', 'CSE'],
      /* 5 */ ['f1@im-a.test', 'Existing', 'EMP-2', 'CSE'],
      /* 6 */ ['fac-bad@im-a.test', 'Bad', 'EMP 3!', 'CSE'],
      /* 7 */ ['fac-dept@im-a.test', 'Dept', 'EMP-7', 'NOPE'],
      /* 8 */ ['stu-for-fac@im-a.test', 'A student', 'EMP-8', 'CSE'],
      /* 9 */ ['f2@im-a.test', 'Existing same id', 'EMP-22', 'mech'],
    ];
    const imp = ok(
      await upload(admin, 'faculty', csv(FACULTY_HEADER, rows), { fileName: 'faculty.csv' }),
    );
    expect(imp.counts).toMatchObject({ total: 8, valid: 2, invalid: 6 });
    const all = ok(await admin.get(`/imports/${imp.id}/rows`, { query: 'limit=100' }))
      .items as Json[];
    const e = (rn: number) =>
      all.find((r) => r.rowNumber === rn)?.errors.map((x: Json) => `${x.column}: ${x.message}`);
    expect(e(3)).toEqual(['employee_id: appears earlier in the file']);
    expect(e(4)).toEqual(['employee_id: is already used by another member']);
    expect(e(5)).toEqual(['employee_id: this email is already a member with employee id EMP-1']);
    expect(e(6)?.[0]).toMatch(/^employee_id: may contain letters/);
    expect(e(7)).toEqual(['department_code: unknown or archived department_code']);
    expect(e(8)?.[0]).toMatch(/email: is already a member with a student profile/);
    expect(all.find((r) => r.rowNumber === 9)?.status).toBe('valid');
  });

  it('archived structure counts as unknown', async () => {
    const d = ok(await admin.post('/departments', { code: uniq('ARCH'), name: 'Soon archived' }));
    ok(await admin.post(`/departments/${d.id}/archive`));
    const imp = ok(
      await upload(
        admin,
        'faculty',
        csv(FACULTY_HEADER, [['arch@im-a.test', 'X', 'EMP-ARCH', d.code]]),
      ),
    );
    expect(imp.counts.invalid).toBe(1);
  });
});

describe('formula injection', () => {
  it('rejects = and @ (every column) and a leading + or - outside numeric columns; allows +91 phones', async () => {
    const rows = [
      ['a1@im-a.test', 'Fine', 'F1', 'CSE', 'BE', '2023-2027', 'A', '+91 98765 43210'],
      ['a2@im-a.test', '=HYPERLINK("http://evil")', 'F2', 'CSE', 'BE', '2023-2027', 'A', ''],
      ['a3@im-a.test', '@SUM(1+1)', 'F3', 'CSE', 'BE', '2023-2027', 'A', ''],
      ['a4@im-a.test', '+SUM(A1)', 'F4', 'CSE', 'BE', '2023-2027', 'A', ''],
      ['a5@im-a.test', '-1+1', 'F5', 'CSE', 'BE', '2023-2027', 'A', ''],
      ['=a6@im-a.test', 'Name', 'F6', 'CSE', 'BE', '2023-2027', 'A', ''],
      ['a7@im-a.test', 'Name', 'F7', '=CSE', 'BE', '2023-2027', 'A', ''],
      ['a8@im-a.test', 'Name', 'F8', 'CSE', 'BE', '2023-2027', 'A', '=1+1'],
      ['a9@im-a.test', 'Name', 'F9', 'CSE', 'BE', '2023-2027', 'A', '+91 (98765)'],
    ];
    const imp = ok(await upload(admin, 'students', csv(headerWithPhone, rows)));
    expect(imp.counts).toMatchObject({ total: 9, valid: 1, invalid: 8 });
    const all = ok(
      await admin.get(`/imports/${imp.id}/rows`, { query: 'status=invalid&limit=100' }),
    ).items as Json[];
    expect(all.map((r) => r.rowNumber)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('the error report neutralizes every cell, so opening it in a spreadsheet runs nothing', async () => {
    const rows = [
      ['ok@im-a.test', 'Fine', 'RPT-1', 'CSE', 'BE', '2023-2027', 'A'],
      ['evil@im-a.test', '=HYPERLINK("http://evil","x")', 'RPT-2', 'CSE', 'BE', '2023-2027', 'A'],
      ['+cmd@im-a.test', 'Plus email', '@RPT-3', 'CSE', 'BE', '2023-2027', 'A'],
      ['quote@im-a.test', 'Say "hi", then leave', 'RPT-4', 'NOPE', 'BE', '2023-2027', 'A'],
    ];
    const imp = ok(await upload(admin, 'students', csv(STUDENT_HEADER, rows)));
    const res = await admin.get(`/imports/${imp.id}/errors.csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('errors.csv');
    const lines = res.body.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe(
      'row,status,email,full_name,register_number,department_code,program_code,batch,section,phone,reason',
    );
    expect(lines).toHaveLength(4); // header + the 3 invalid rows; the valid row is not reported
    expect(lines[1]).toMatch(
      /^3,invalid,evil@im-a\.test,"'=HYPERLINK\(""http:\/\/evil"",""x""\)",RPT-2,/,
    );
    expect(lines[2]).toContain("'+cmd@im-a.test");
    expect(lines[2]).toContain("'@RPT-3");
    expect(lines[3]).toContain('"Say ""hi"", then leave"');
    // no cell of the file starts with a formula character: parse it back
    for (const line of lines.slice(1)) {
      const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [];
      for (const raw of cells) {
        const cell = raw.replace(/,$/, '').replace(/^"|"$/g, '');
        expect(cell, line).not.toMatch(/^[=+\-@\t\r]/);
      }
    }
    expect(code(await member.get(`/imports/${imp.id}/errors.csv`))).toBe('forbidden');
    expect(
      (await admin.get('/imports/00000000-0000-7000-8000-000000000000/errors.csv')).statusCode,
    ).toBe(404);
  });
});

describe('upload refusals leave nothing behind', () => {
  const jobCount = () => count(owner, 'SELECT count(*)::int AS n FROM lms.import_jobs');
  const goodRow = ['x@im-a.test', 'X', 'REF-1', 'CSE', 'BE', '2023-2027', 'A'];

  it('wrong file type, no file, missing / unknown / duplicate columns, empty, header only, bad CSV', async () => {
    const before = await jobCount();
    const expectRefused = async (
      res: { statusCode: number; json(): Json },
      status: number,
      errCode: string,
    ) => {
      expect(res.statusCode).toBe(status);
      expect(res.json().error.code).toBe(errCode);
    };
    await expectRefused(
      await upload(admin, 'students', 'x', { fileName: 'students.xlsx' }),
      415,
      'unsupported_file_type',
    );
    await expectRefused(
      await upload(admin, 'students', 'x', { fileName: 'a.csv', contentType: 'image/png' }),
      415,
      'unsupported_file_type',
    );
    await expectRefused(
      await upload(admin, 'robots', csv(STUDENT_HEADER, [goodRow])),
      400,
      'validation_error',
    );
    await expectRefused(
      await upload(admin, 'students', csv('email,full_name', [['a@b.test', 'A']])),
      400,
      'missing_columns',
    );
    await expectRefused(
      await upload(admin, 'students', csv(`${STUDENT_HEADER},salary`, [[...goodRow, '1']])),
      400,
      'unknown_columns',
    );
    await expectRefused(
      await upload(admin, 'students', csv(`${STUDENT_HEADER},email`, [[...goodRow, 'a@b.test']])),
      400,
      'duplicate_columns',
    );
    await expectRefused(await upload(admin, 'students', ''), 400, 'empty_file');
    await expectRefused(await upload(admin, 'students', `${STUDENT_HEADER}\r\n`), 400, 'no_rows');
    await expectRefused(
      await upload(
        admin,
        'students',
        `${STUDENT_HEADER}\r\n"unclosed,quote,x,CSE,BE,2023-2027,A\r\n`,
      ),
      400,
      'invalid_csv',
    );
    // no multipart body at all
    const none = await admin.request('POST', '/imports', { query: 'kind=students', body: {} });
    expect(none.statusCode).toBeGreaterThanOrEqual(400);
    expect(await jobCount()).toBe(before); // nothing was staged by any of them
  });

  it('accepts a BOM, CRLF or LF, quoted commas, blank lines and differently cased headers', async () => {
    const body = `﻿Email, Full Name ,REGISTER_NUMBER,Department_Code,program_code,Batch,Section\n\nbom@im-a.test,"Lovelace, Ada",BOM-1,CSE,BE,2023-2027,A\n\n`;
    const imp = ok(await upload(admin, 'students', body));
    expect(imp.counts).toMatchObject({ total: 1, valid: 1, invalid: 0 });
    const row = ok(await admin.get(`/imports/${imp.id}/rows`)).items[0];
    expect(row.cells.full_name).toBe('Lovelace, Ada');
    expect(row.rowNumber).toBe(3); // the spreadsheet row: the header is row 1, a blank line is row 2
  });

  it('enforces the row and size limits while streaming', async () => {
    const before = await jobCount();
    const rows = Array.from({ length: 6 }, (_, i) => [
      `r${i}@im-a.test`,
      'X',
      `L-${i}`,
      'CSE',
      'BE',
      '2023-2027',
      'A',
    ]);
    const tooMany = await upload(adminSmall, 'students', csv(STUDENT_HEADER, rows));
    expect(tooMany.statusCode).toBe(413);
    expect(code(tooMany)).toBe('too_many_rows');
    const big = await upload(
      adminSmall,
      'students',
      csv(STUDENT_HEADER, [goodRow]) + 'x'.repeat(5000),
    );
    expect(big.statusCode).toBe(413);
    expect(code(big)).toBe('file_too_large');
    expect(await jobCount()).toBe(before);
    const fits = await upload(adminSmall, 'students', csv(STUDENT_HEADER, rows.slice(0, 5)));
    expect(fits.statusCode).toBe(201);
  });
});

describe('listing, confirm and cancel rules', () => {
  async function validated(rows: string[][], kind = 'students', header = STUDENT_HEADER) {
    return ok(await upload(admin, kind, csv(header, rows)));
  }
  const good = (i: string) => [`${i}@im-a.test`, 'Name', `CF-${i}`, 'CSE', 'BE', '2023-2027', 'A'];

  it('lists imports newest first and shows one with its counts', async () => {
    const a = await validated([good('l1')]);
    const b = await validated([good('l2')]);
    const list = ok(await admin.get('/imports', { query: 'limit=100' })).items;
    expect(list.findIndex((x: Json) => x.id === b.id)).toBeLessThan(
      list.findIndex((x: Json) => x.id === a.id),
    );
    expect(ok(await admin.get(`/imports/${a.id}`))).toMatchObject({
      id: a.id,
      status: 'validated',
      counts: { total: 1, valid: 1 },
    });
    expect(code(await admin.get('/imports/00000000-0000-7000-8000-000000000000'))).toBe(
      'import_not_found',
    );
    expect((await adminB.get(`/imports/${a.id}`)).statusCode).toBe(404); // another college's import
  });

  it('refuses to confirm with invalid rows unless skipInvalid is set, or when nothing is valid', async () => {
    const mixed = await validated([
      good('c1'),
      ['bad', 'X', 'CF-X', 'CSE', 'BE', '2023-2027', 'A'],
    ]);
    const refused = await admin.post(`/imports/${mixed.id}/confirm`, {});
    expect(refused.statusCode).toBe(409);
    expect(code(refused)).toBe('has_invalid_rows');
    const none = await validated([['bad', 'X', 'CF-Y', 'CSE', 'BE', '2023-2027', 'A']]);
    expect(code(await admin.post(`/imports/${none.id}/confirm`, { skipInvalid: true }))).toBe(
      'nothing_to_import',
    );
    expect(
      code(await admin.post('/imports/00000000-0000-7000-8000-000000000000/confirm', {})),
    ).toBe('import_not_found');
    // cancel: a draft only, once
    expect(ok(await admin.post(`/imports/${mixed.id}/cancel`)).status).toBe('cancelled');
    expect(code(await admin.post(`/imports/${mixed.id}/cancel`))).toBe('import_not_confirmable');
    expect(code(await admin.post(`/imports/${mixed.id}/confirm`, { skipInvalid: true }))).toBe(
      'import_not_confirmable',
    );
  });

  it('only one import can be running per tenant: enforced by the database', async () => {
    const one = await validated([good('o1')]);
    const two = await validated([good('o2')]);
    ok(await admin.post(`/imports/${one.id}/confirm`, {}));
    const second = await admin.post(`/imports/${two.id}/confirm`, {});
    expect(second.statusCode).toBe(409);
    expect(code(second)).toBe('import_in_progress');
    // the database itself refuses a second queued/processing import of the tenant
    await expect(
      owner.query("UPDATE lms.import_jobs SET status = 'queued' WHERE id = $1", [two.id]),
    ).rejects.toThrow(/import_jobs_one_running/);
    // run it to the end, then the second can be confirmed
    const runner = startRunner(t, { queues: ['imports.process'] });
    await waitForImport(admin, one.id);
    expect(ok(await admin.post(`/imports/${two.id}/confirm`, {})).status).toBe('queued');
    await waitForImport(admin, two.id);
    await runner.stop();
  });
});

describe('processing', () => {
  it('creates accounts, pending memberships and profiles; invites are QUEUED, then sent by the queue', async () => {
    const rows = [
      ['p1@im-p.test', 'Pia One', 'PROC-1', 'CSE', 'BE', '2023-2027', 'A'],
      ['p2@im-p.test', 'Pia Two', 'PROC-2', 'CSE', 'BE', '2023-2027', 'B'],
      ['p3@im-p.test', 'Pia Three', 'PROC-3', 'cse', 'be', '2023-2027', 'a'],
    ];
    const imp = ok(
      await upload(admin, 'students', csv(STUDENT_HEADER, rows), { fileName: 'cohort-2023.csv' }),
    );
    const before = await ownerCounts();
    ok(await admin.post(`/imports/${imp.id}/confirm`, {}));
    expect(ok(await admin.get(`/imports/${imp.id}`)).status).toBe('queued');

    const runner = startRunner(t, { queues: ['imports.process'] });
    const done = await waitForImport(admin, imp.id);
    await runner.stop();
    expect(done).toMatchObject({
      status: 'completed',
      counts: { total: 3, valid: 3, processed: 3, skipped: 0, failed: 0, created: 3, updated: 0 },
    });
    expect(done.startedAt).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();

    // accounts, pending memberships (role member), student profiles
    const after = await ownerCounts();
    expect(after.users - before.users).toBe(3);
    expect(after.memberships - before.memberships).toBe(3);
    expect(after.profiles - before.profiles).toBe(3);
    const m = await owner.query(
      `SELECT u.email, m.role, m.status, p.profile_type, p.register_number, p.section_id, p.batch_id, p.department_id
         FROM lms.users u JOIN lms.tenant_memberships m ON m.user_id = u.id
         JOIN lms.member_profiles p ON p.membership_id = m.id
        WHERE u.email LIKE '%@im-p.test' ORDER BY u.email`,
    );
    expect(m.rows).toHaveLength(3);
    expect(
      m.rows.every(
        (r) => r.role === 'member' && r.status === 'pending' && r.profile_type === 'student',
      ),
    ).toBe(true);
    expect(m.rows[1].section_id).toBe(S.secB);
    expect(m.rows[0]).toMatchObject({
      batch_id: S.batch,
      department_id: S.dept,
      register_number: 'PROC-1',
    });

    // invites: enqueued in the processing transaction, NOT sent there
    const queued = await owner.query(
      "SELECT payload, run_at FROM lms.jobs WHERE queue = 'invites.send' AND payload ->> 'importId' = $1 ORDER BY run_at",
      [imp.id],
    );
    expect(queued.rowCount).toBe(3);
    expect(t.mailer.sent.filter((x) => x.to.endsWith('@im-p.test'))).toHaveLength(0);
    // bounded rate: staggered run_at (default 5 per second -> 0.2 s apart)
    const times = queued.rows.map((r) => new Date(r.run_at).getTime());
    expect((times[2] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(350);

    const inviter = startRunner(t, { queues: ['invites.send'] });
    await waitFor(() => t.mailer.sent.filter((x) => x.to.endsWith('@im-p.test')).length === 3);
    await inviter.stop();
    const link = t.mailer.sent.find((x) => x.to === 'p1@im-p.test');
    expect(link?.text).toContain(`http://${A.host}`);
    // and the invite works: the member sets a password and signs in
    const token = lastTokenFor(t, 'p1@im-p.test');
    const fresh = new TestClient(t, A.host);
    expect(
      (await fresh.post('/auth/invites/accept', { token, password: TEST_PASSWORD })).statusCode,
    ).toBe(200);
    expect((await fresh.login('p1@im-p.test', TEST_PASSWORD)).json().role).toBe('member');

    // audited: who, file name, counts
    const log = ok(await admin.get('/audit', { query: 'limit=100' })).items as Json[];
    const entry = (action: string) => log.find((e) => e.action === action && e.targetId === imp.id);
    expect(entry('import.uploaded')?.actorUserId).toBe(A.adminUserId);
    expect(entry('import.uploaded')?.metadata).toMatchObject({
      fileName: 'cohort-2023.csv',
      kind: 'students',
      total: 3,
      valid: 3,
      invalid: 0,
    });
    expect(entry('import.confirmed')?.metadata).toMatchObject({
      updateExisting: false,
      skipInvalid: false,
    });
    expect(entry('import.completed')?.metadata).toMatchObject({
      fileName: 'cohort-2023.csv',
      processed: 3,
      created: 3,
      failed: 0,
    });
  });

  it('an existing GLOBAL user becomes a new member of this college without a new account', async () => {
    const other = await addMember(owner, B.tenantId, 'shared-person@im-x.test', {
      displayName: 'Shared Person',
    });
    const usersBefore = await count(owner, 'SELECT count(*)::int AS n FROM lms.users');
    const imp = ok(
      await upload(
        admin,
        'students',
        csv(STUDENT_HEADER, [
          [
            'shared-person@im-x.test',
            'A Different Name',
            'GLOBAL-1',
            'CSE',
            'BE',
            '2023-2027',
            'A',
          ],
        ]),
      ),
    );
    ok(await admin.post(`/imports/${imp.id}/confirm`, {}));
    const runner = startRunner(t, { queues: ['imports.process'] });
    const done = await waitForImport(admin, imp.id);
    await runner.stop();
    expect(done.counts).toMatchObject({ processed: 1, created: 1 });
    expect(await count(owner, 'SELECT count(*)::int AS n FROM lms.users')).toBe(usersBefore); // no new account
    const rows = await owner.query(
      `SELECT m.tenant_id, m.status, u.display_name FROM lms.tenant_memberships m JOIN lms.users u ON u.id = m.user_id
        WHERE u.id = $1 ORDER BY m.created_at`,
      [other.userId],
    );
    expect(rows.rows.map((r) => r.tenant_id)).toEqual([B.tenantId, A.tenantId]);
    expect(rows.rows[1].status).toBe('pending');
    expect(rows.rows[0].display_name).toBe('Shared Person'); // imports never rename an existing user
  });

  it('existing members of this college: skipped by default, updated only when "update existing" is chosen', async () => {
    const mem = await addMember(owner, A.tenantId, 'existing-m@im-a.test', {
      displayName: 'Keep My Name',
    });
    ok(
      await admin.request('PATCH', `/members/${mem.userId}/profile`, {
        body: {
          profileType: 'student',
          registerNumber: 'KEEP-1',
          batchId: S.batch,
          sectionId: S.secA,
        },
      }),
    );
    const sus = await addMember(owner, A.tenantId, 'suspended-m@im-a.test', {
      status: 'suspended',
    });
    const rows = [
      ['existing-m@im-a.test', 'Renamed By File', 'KEEP-1', 'CSE', 'BE', '2024-2028', 'A'].map(
        (v) => v,
      ),
      ['suspended-m@im-a.test', 'Suspended', 'SUS-1', 'CSE', 'BE', '2023-2027', 'A'],
    ];
    // 2024-2028 batch has no section A yet
    ok(await admin.post('/sections', { batchId: S.batch2, code: 'A' }));

    const skip = ok(await upload(admin, 'students', csv(STUDENT_HEADER, rows)));
    ok(await admin.post(`/imports/${skip.id}/confirm`, {}));
    let runner = startRunner(t, { queues: ['imports.process'] });
    const skipped = await waitForImport(admin, skip.id);
    await runner.stop();
    expect(skipped.counts).toMatchObject({ processed: 0, skipped: 2, created: 0, updated: 0 });
    expect(skipped.status).toBe('completed');
    expect(ok(await admin.get(`/members/${mem.userId}/profile`)).batchLabel).toBe('2023-2027'); // untouched

    const upd = ok(await upload(admin, 'students', csv(STUDENT_HEADER, rows)));
    ok(await admin.post(`/imports/${upd.id}/confirm`, { updateExisting: true }));
    runner = startRunner(t, { queues: ['imports.process'] });
    const updated = await waitForImport(admin, upd.id);
    await runner.stop();
    expect(updated.counts).toMatchObject({ processed: 1, updated: 1, skipped: 1, created: 0 });
    expect(updated.updateExisting).toBe(true);
    expect(ok(await admin.get(`/members/${mem.userId}/profile`))).toMatchObject({
      batchLabel: '2024-2028',
      sectionCode: 'A',
    });
    expect(ok(await admin.get(`/members/${mem.userId}`)).displayName).toBe('Keep My Name'); // never renamed
    // a suspended member is NEVER touched, whatever was chosen
    expect(ok(await admin.get(`/members/${sus.userId}`)).status).toBe('suspended');
    const report = await admin.get(`/imports/${updated.id}/errors.csv`);
    expect(report.body).toContain('skipped_suspended');
  });

  it('running the same file twice creates no duplicates', async () => {
    const rows = [
      ['twice1@im-t.test', 'Twice One', 'TW-1', 'CSE', 'BE', '2023-2027', 'A'],
      ['twice2@im-t.test', 'Twice Two', 'TW-2', 'CSE', 'BE', '2023-2027', 'B'],
    ];
    const runOnce = async () => {
      const imp = ok(await upload(admin, 'students', csv(STUDENT_HEADER, rows)));
      expect(imp.counts.invalid).toBe(0); // existing members with the same data are valid, not errors
      ok(await admin.post(`/imports/${imp.id}/confirm`, {}));
      const runner = startRunner(t, { queues: ['imports.process'] });
      const done = await waitForImport(admin, imp.id);
      await runner.stop();
      return done;
    };
    const first = await runOnce();
    const snapshot = await ownerCounts();
    const second = await runOnce();
    expect(first.counts).toMatchObject({ created: 2, skipped: 0 });
    expect(second.counts).toMatchObject({ created: 0, skipped: 2, processed: 0 });
    const after = await ownerCounts();
    expect(after.users).toBe(snapshot.users);
    expect(after.memberships).toBe(snapshot.memberships);
    expect(after.profiles).toBe(snapshot.profiles);
    expect(
      await count(
        owner,
        "SELECT count(*)::int AS n FROM lms.jobs WHERE queue = 'invites.send' AND payload ->> 'email' = 'twice1@im-t.test'",
      ),
    ).toBe(1);
  });

  it('a batch that rolls back changes nothing, and running it again applies it exactly once', async () => {
    const rows = [
      ['rb1@im-r.test', 'Rollback One', 'RB-1', 'CSE', 'BE', '2023-2027', 'A'],
      ['rb2@im-r.test', 'Rollback Two', 'RB-2', 'CSE', 'BE', '2023-2027', 'A'],
    ];
    const imp = ok(await upload(admin, 'students', csv(STUDENT_HEADER, rows)));
    ok(await admin.post(`/imports/${imp.id}/confirm`, {}));
    const repo = createImportsRepository();
    const ids = () => Array.from({ length: 500 }, () => newId());
    await t.db.withTenant(A.tenantId, (tx) => repo.markProcessing(tx, A.tenantId, imp.id));
    const before = await ownerCounts();
    // the batch statement RUNS (accounts, memberships, profiles, invite jobs, row results), then the
    // transaction fails: everything it did is rolled back
    await expect(
      t.db.withTenant(A.tenantId, async (tx) => {
        const r = await repo.processBatch(tx, {
          tenantId: A.tenantId,
          importId: imp.id,
          kind: 'students',
          updateExisting: false,
          batchSize: 500,
          ratePerSecond: 5,
          userIds: ids(),
          membershipIds: ids(),
          profileIds: ids(),
        });
        expect(r.picked).toBe(2);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await ownerCounts()).toEqual(before);
    expect(
      await count(
        owner,
        "SELECT count(*)::int AS n FROM lms.import_rows WHERE import_id = $1 AND status = 'valid'",
        [imp.id],
      ),
    ).toBe(2);

    // retried: applied exactly once; a further call finds nothing left
    const svc = t.app.modules.imports.service;
    expect(await svc.processOneBatch(A.tenantId, imp.id)).toBe(2);
    expect(await svc.processOneBatch(A.tenantId, imp.id)).toBe(0);
    const after = await ownerCounts();
    expect(after.memberships - before.memberships).toBe(2);
    expect(after.users - before.users).toBe(2);
    expect(after.profiles - before.profiles).toBe(2);
    expect(
      await count(
        owner,
        "SELECT count(*)::int AS n FROM lms.jobs WHERE queue = 'invites.send' AND payload ->> 'importId' = $1",
        [imp.id],
      ),
    ).toBe(2);
    // close the import (it was left 'processing' by driving the batches by hand): the worker finishes it
    const runner = startRunner(t, { queues: ['imports.process'] });
    await waitForImport(admin, imp.id);
    await runner.stop();
  });
});

describe('retention of the staged rows (they hold names and emails)', () => {
  it('purges rows of finished imports after the retention period, keeping the summary and the audit trail', async () => {
    const imp = ok(
      await upload(
        admin,
        'faculty',
        csv(FACULTY_HEADER, [
          ['ret@im-a.test', 'Ret', 'EMP-RET', 'CSE'],
          ['bad', 'Bad', 'EMP-RET2', 'CSE'],
        ]),
      ),
    );
    ok(await admin.post(`/imports/${imp.id}/confirm`, { skipInvalid: true }));
    const runner = startRunner(t, { queues: ['imports.process'] });
    await waitForImport(admin, imp.id);
    await runner.stop();
    expect(
      await count(owner, 'SELECT count(*)::int AS n FROM lms.import_rows WHERE import_id = $1', [
        imp.id,
      ]),
    ).toBe(2);

    // recent: kept
    await t.app.modules.imports.service.purgeRows();
    expect(
      await count(owner, 'SELECT count(*)::int AS n FROM lms.import_rows WHERE import_id = $1', [
        imp.id,
      ]),
    ).toBe(2);
    // older than 7 days: purged
    await owner.query(
      "UPDATE lms.import_jobs SET finished_at = now() - interval '8 days' WHERE id = $1",
      [imp.id],
    );
    await t.app.modules.imports.service.purgeRows();
    expect(
      await count(owner, 'SELECT count(*)::int AS n FROM lms.import_rows WHERE import_id = $1', [
        imp.id,
      ]),
    ).toBe(0);
    const after = ok(await admin.get(`/imports/${imp.id}`));
    expect(after).toMatchObject({
      status: 'completed_with_errors',
      rowsPurged: true,
      counts: { total: 2, created: 1, invalid: 1 },
    });
    expect(code(await admin.get(`/imports/${imp.id}/errors.csv`))).toBe('rows_purged');
    expect((await admin.get(`/imports/${imp.id}/errors.csv`)).statusCode).toBe(410);
    expect((await admin.get(`/imports/${imp.id}/rows`)).statusCode).toBe(410);
    const log = ok(await admin.get('/audit', { query: 'action=import.completed&limit=100' }))
      .items as Json[];
    expect(log.some((e) => e.targetId === imp.id)).toBe(true);
  });

  it('an abandoned draft is cancelled and purged after the retention period', async () => {
    const imp = ok(
      await upload(
        admin,
        'faculty',
        csv(FACULTY_HEADER, [['draft@im-a.test', 'Draft', 'EMP-DR', 'CSE']]),
      ),
    );
    await owner.query(
      "UPDATE lms.import_jobs SET updated_at = now() - interval '8 days' WHERE id = $1",
      [imp.id],
    );
    await t.app.modules.imports.service.purgeRows();
    await t.app.modules.imports.service.purgeRows();
    const after = ok(await admin.get(`/imports/${imp.id}`));
    expect(after.status).toBe('cancelled');
    expect(after.rowsPurged).toBe(true);
    expect(code(await admin.post(`/imports/${imp.id}/confirm`, {}))).toBe('import_not_confirmable');
  });

  it('an import whose queue job died is marked failed, so it does not block the college', async () => {
    const imp = ok(
      await upload(
        admin,
        'faculty',
        csv(FACULTY_HEADER, [['dead@im-a.test', 'Dead', 'EMP-DEAD', 'CSE']]),
      ),
    );
    ok(await admin.post(`/imports/${imp.id}/confirm`, {}));
    // the job exhausts its attempts without ever running (e.g. every worker crashed): dead letter
    await owner.query(
      "UPDATE lms.jobs SET status = 'dead', finished_at = now() WHERE queue = 'imports.process' AND payload ->> 'importId' = $1",
      [imp.id],
    );
    expect(ok(await admin.get(`/imports/${imp.id}`)).status).toBe('queued'); // still blocking
    expect(await t.app.modules.imports.service.reapDead()).toBeGreaterThanOrEqual(1);
    expect(ok(await admin.get(`/imports/${imp.id}`))).toMatchObject({ status: 'failed' });
    const next = ok(
      await upload(
        admin,
        'faculty',
        csv(FACULTY_HEADER, [['alive@im-a.test', 'Alive', 'EMP-ALIVE', 'CSE']]),
      ),
    );
    expect(ok(await admin.post(`/imports/${next.id}/confirm`, {})).status).toBe('queued');
    const runner = startRunner(t, { queues: ['imports.process'] });
    await waitForImport(admin, next.id);
    await runner.stop();
  });
});

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

import { describe, expect, it } from 'vitest';
import { pgArray } from '../../../core/pg-array';
import {
  checkCell,
  csvCell,
  csvLine,
  mapHeader,
  reportHeader,
  reportLine,
  templateCsv,
  templateHeaders,
  toParsedRow,
} from '../imports.csv';

describe('templates', () => {
  it('have exactly the headers of the specification', () => {
    expect(templateCsv('students')).toBe(
      'email,full_name,register_number,department_code,program_code,batch,section\r\n',
    );
    expect(templateCsv('faculty')).toBe('email,full_name,employee_id,department_code\r\n');
    expect(templateHeaders('students')).toHaveLength(7);
  });
});

describe('formula injection: the column-aware input rule', () => {
  it('rejects = and @ and tab / carriage return at the start of a cell in EVERY column kind', () => {
    for (const kind of ['text', 'numeric'] as const) {
      for (const v of ['=1+1', '=SUM(A1)', '@SUM(A1)', '\tx', '\rx']) {
        expect(checkCell(kind, v), `${kind} ${JSON.stringify(v)}`).not.toBeNull();
      }
    }
  });

  it('rejects a leading + or - in a text column (a name): "+SUM(A1)", "-2+3", "+cmd"', () => {
    for (const v of ['+SUM(A1)', '-2+3', '+cmd|calc', '- x', '+91 98765 43210']) {
      expect(checkCell('text', v), v).toMatch(/must not start with/);
    }
  });

  it('allows a leading + or - in a numeric column only when the rest is digits, spaces and hyphens', () => {
    expect(checkCell('numeric', '+91 98765 43210')).toBeNull();
    expect(checkCell('numeric', '+91-98765-43210')).toBeNull();
    expect(checkCell('numeric', '-91 98765')).toBeNull();
    expect(checkCell('numeric', '98765 43210')).toBeNull();
    for (const v of ['+SUM(A1)', '+91 (987)', '+', '-', '+9+1', '+91 98765 4321O', '+cmd']) {
      expect(checkCell('numeric', v), v).not.toBeNull();
    }
  });

  it('accepts ordinary text, including characters that only look dangerous inside a cell', () => {
    for (const v of ['Ada Lovelace', "D'Souza", 'a=b', 'x@y.test', 'O-Neil', '2023-2027', '']) {
      expect(checkCell('text', v), v).toBeNull();
    }
  });

  it('rejects over-long cells', () => {
    expect(checkCell('text', 'x'.repeat(501))).toMatch(/too long/);
  });
});

describe('mapHeader', () => {
  it('maps headers case-insensitively, tolerating spaces, a BOM and the optional phone column', () => {
    const r = mapHeader('students', [
      '﻿Email',
      ' Full Name ',
      'REGISTER_NUMBER',
      'department_code',
      'program_code',
      'batch',
      'section',
      'phone',
    ]);
    expect(r.ok).toBe(true);
  });

  it('reports missing, unknown and duplicate columns, and an empty file', () => {
    expect(mapHeader('faculty', ['email', 'full_name'])).toEqual({
      ok: false,
      problem: { code: 'missing_columns', columns: ['employee_id', 'department_code'] },
    });
    expect(
      mapHeader('faculty', ['email', 'full_name', 'employee_id', 'department_code', 'salary']),
    ).toEqual({
      ok: false,
      problem: { code: 'unknown_columns', columns: ['salary'] },
    });
    expect(
      mapHeader('faculty', ['email', 'email', 'full_name', 'employee_id', 'department_code']),
    ).toEqual({
      ok: false,
      problem: { code: 'duplicate_columns', columns: ['email'] },
    });
    expect(mapHeader('students', [])).toMatchObject({ ok: false, problem: { code: 'empty_file' } });
  });
});

describe('toParsedRow', () => {
  const header = mapHeader('students', [
    'email',
    'full_name',
    'register_number',
    'department_code',
    'program_code',
    'batch',
    'section',
    'phone',
  ]);
  const columns = header.ok ? header.columns : [];

  it('trims, lowercases the email, normalizes the batch dash and treats empty cells as null', () => {
    const r = toParsedRow(
      columns,
      [' Ada@X.Test ', ' Ada  Lovelace', 'R1', 'cse', 'be', '2023–2027', 'a', ''],
      2,
    );
    expect(r.errors).toEqual([]);
    expect(r.staged).toMatchObject({
      email: 'ada@x.test',
      fullName: 'Ada  Lovelace',
      batchLabel: '2023-2027',
      phone: null,
    });
    expect(r.raw.email).toBe('Ada@X.Test');
  });

  it('accepts "+91 98765 43210" as a phone but rejects "+SUM(A1)" in a name column', () => {
    const ok = toParsedRow(
      columns,
      ['a@x.test', 'Ada', 'R1', 'CSE', 'BE', '2023-2027', 'A', '+91 98765 43210'],
      2,
    );
    expect(ok.errors).toEqual([]);
    expect(ok.staged.phone).toBe('+91 98765 43210');
    const bad = toParsedRow(
      columns,
      ['a@x.test', '+SUM(A1)', 'R1', 'CSE', 'BE', '2023-2027', 'A', ''],
      3,
    );
    expect(bad.errors).toEqual([expect.objectContaining({ column: 'full_name' })]);
    expect(bad.staged.fullName).toBeNull();
    const phoneBad = toParsedRow(
      columns,
      ['a@x.test', 'Ada', 'R1', 'CSE', 'BE', '2023-2027', 'A', '+SUM(A1)'],
      4,
    );
    expect(phoneBad.errors).toEqual([expect.objectContaining({ column: 'phone' })]);
  });

  it('flags a row with more cells than the header', () => {
    const r = toParsedRow(
      columns,
      ['a@x.test', 'A', 'R', 'C', 'P', '2023-2027', 'A', '', 'extra'],
      5,
    );
    expect(r.errors.some((e) => /more cells/.test(e.message))).toBe(true);
  });
});

describe('the error report is safe to open in a spreadsheet', () => {
  it('neutralizes every cell that would run as a formula, always', () => {
    for (const v of ['=1+1', '+SUM(A1)', '-2', '@x', '\tx']) {
      expect(csvCell(v).replace(/^"|"$/g, '')).toBe(`'${v}`);
    }
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('2023-2027')).toBe('2023-2027');
    expect(csvCell(12)).toBe('12');
    expect(csvCell(null)).toBe('');
  });

  it('quotes commas, quotes and newlines (and still neutralizes a quoted formula)', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('=cmd|"x",y')).toBe('"\'=cmd|""x"",y"');
    expect(csvLine(['a', '=b', 1])).toBe("a,'=b,1\r\n");
  });

  it('writes the header and one line per row with the echoed cells neutralized', () => {
    expect(reportHeader('faculty')).toBe(
      'row,status,email,full_name,employee_id,department_code,phone,reason\r\n',
    );
    const line = reportLine('faculty', {
      rowNumber: 7,
      status: 'invalid',
      raw: { email: 'a@x.test', full_name: '=HYPERLINK("http://evil")', employee_id: 'E1' },
      errors: [{ column: 'full_name', message: 'must not start with "="' }],
      result: null,
    });
    expect(line).toBe(
      `7,invalid,a@x.test,"'=HYPERLINK(""http://evil"")",E1,,,"full_name: must not start with ""="""\r\n`,
    );
    expect(
      reportLine('faculty', {
        rowNumber: 8,
        status: 'skipped',
        raw: {},
        errors: [],
        result: 'already a member',
      }),
    ).toBe('8,skipped,,,,,,already a member\r\n');
  });
});

describe('pgArray', () => {
  it('quotes and escapes every element so any text is carried as data', () => {
    expect(pgArray(['a', 'b,c', 'say "hi"', 'back\\slash', '{x}', null])).toBe(
      '{"a","b,c","say \\"hi\\"","back\\\\slash","{x}",NULL}',
    );
    expect(pgArray([])).toBe('{}');
  });
});

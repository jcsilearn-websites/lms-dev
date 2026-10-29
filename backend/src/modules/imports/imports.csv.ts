// Pure CSV rules of the bulk import: the column layouts and templates, the cell-level input checks
// (formula injection), mapping a parsed record to a staged row, and the SAFE writer of the error report.
// Nothing here touches the database or the request.

export type ImportKind = 'students' | 'faculty';
export const IMPORT_KINDS: readonly ImportKind[] = ['students', 'faculty'];

/** `numeric` columns (a phone number, any future numeric field) may start with + or - (see checkCell). */
export type CellKind = 'text' | 'numeric';

export type StagedField =
  | 'email'
  | 'fullName'
  | 'registerNumber'
  | 'employeeId'
  | 'departmentCode'
  | 'programCode'
  | 'batchLabel'
  | 'sectionCode'
  | 'phone';

export interface ColumnSpec {
  /** the CSV header */
  name: string;
  field: StagedField;
  required: boolean;
  kind: CellKind;
}

const col = (
  name: string,
  field: StagedField,
  required = true,
  kind: CellKind = 'text',
): ColumnSpec => ({ name, field, required, kind });

/**
 * The template columns, in order. `phone` is accepted as an OPTIONAL extra column (it is not in the
 * templates): it is the one numeric-kind column today.
 */
export const COLUMNS: Record<ImportKind, ColumnSpec[]> = {
  students: [
    col('email', 'email'),
    col('full_name', 'fullName'),
    col('register_number', 'registerNumber'),
    col('department_code', 'departmentCode'),
    col('program_code', 'programCode'),
    col('batch', 'batchLabel'),
    col('section', 'sectionCode'),
    col('phone', 'phone', false, 'numeric'),
  ],
  faculty: [
    col('email', 'email'),
    col('full_name', 'fullName'),
    col('employee_id', 'employeeId'),
    col('department_code', 'departmentCode'),
    col('phone', 'phone', false, 'numeric'),
  ],
};

/** The exact headers of the downloadable templates (the optional phone column is not part of them). */
export function templateHeaders(kind: ImportKind): string[] {
  return COLUMNS[kind].filter((c) => c.required).map((c) => c.name);
}

export function templateCsv(kind: ImportKind): string {
  return `${templateHeaders(kind).join(',')}\r\n`;
}

// ---------------------------------------------------------------- cell checks (input)

const MAX_CELL = 500;

/**
 * Column-aware formula-injection rule for ONE trimmed cell; returns the problem or null.
 *  - a cell starting with `=` or `@`, a tab or a carriage return is rejected in EVERY column;
 *  - a leading `+` or `-` is allowed ONLY in a numeric-kind column (phone) and only when the rest is
 *    digits, spaces and hyphens ("+91 98765 43210"); in any other column it is rejected ("+SUM(A1)").
 */
export function checkCell(kind: CellKind, value: string): string | null {
  if (value.length === 0) return null;
  if (value.length > MAX_CELL) return `is too long (at most ${MAX_CELL} characters)`;
  const first = value[0] as string;
  if (first === '=' || first === '@' || first === '\t' || first === '\r') {
    return first === '=' || first === '@'
      ? `must not start with "${first}" (it would run as a formula in a spreadsheet)`
      : 'must not start with a tab or carriage return';
  }
  if (first === '+' || first === '-') {
    if (kind === 'numeric' && /^[+-][0-9][0-9 -]*$/.test(value)) return null;
    return kind === 'numeric'
      ? 'may start with + or - only when followed by digits, spaces and hyphens'
      : `must not start with "${first}" (it would run as a formula in a spreadsheet)`;
  }
  return null;
}

/** The formula characters a spreadsheet acts on (output side). */
const FORMULA_START = /^[=+\-@\t\r]/;

// ---------------------------------------------------------------- header + record mapping

export interface HeaderProblem {
  code: 'missing_columns' | 'unknown_columns' | 'duplicate_columns' | 'empty_file';
  columns: string[];
}

const normalizeHeader = (h: string) =>
  h
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

/** Maps the header row to the kind's columns (case, spaces and BOM tolerant). */
export function mapHeader(
  kind: ImportKind,
  headerRow: readonly string[],
): { ok: true; columns: (ColumnSpec | null)[] } | { ok: false; problem: HeaderProblem } {
  if (headerRow.length === 0 || headerRow.every((h) => h.trim() === '')) {
    return { ok: false, problem: { code: 'empty_file', columns: [] } };
  }
  const specs = COLUMNS[kind];
  const byName = new Map(specs.map((s) => [s.name, s]));
  const columns: (ColumnSpec | null)[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  const duplicate: string[] = [];
  for (const raw of headerRow) {
    const spec = byName.get(normalizeHeader(raw));
    if (!spec) {
      unknown.push(raw.trim());
      columns.push(null);
    } else {
      if (seen.has(spec.name)) duplicate.push(spec.name);
      seen.add(spec.name);
      columns.push(spec);
    }
  }
  if (unknown.length > 0)
    return { ok: false, problem: { code: 'unknown_columns', columns: unknown } };
  if (duplicate.length > 0) {
    return { ok: false, problem: { code: 'duplicate_columns', columns: duplicate } };
  }
  const missing = specs.filter((s) => s.required && !seen.has(s.name)).map((s) => s.name);
  if (missing.length > 0)
    return { ok: false, problem: { code: 'missing_columns', columns: missing } };
  return { ok: true, columns };
}

export interface CellError {
  column: string;
  message: string;
}

export interface ParsedRow {
  rowNumber: number;
  /** header -> the cell as written (trimmed), for the error report */
  raw: Record<string, string>;
  staged: Partial<Record<StagedField, string | null>>;
  /** problems found while reading the row (formula characters, too many cells) */
  errors: CellError[];
}

/** One CSV record -> a staged row. Cells are trimmed; an empty cell is null; the email is lowercased. */
export function toParsedRow(
  columns: readonly (ColumnSpec | null)[],
  record: readonly string[],
  rowNumber: number,
): ParsedRow {
  const raw: Record<string, string> = {};
  const staged: ParsedRow['staged'] = {};
  const errors: CellError[] = [];
  if (record.length > columns.length) {
    errors.push({ column: '', message: 'has more cells than the header' });
  }
  columns.forEach((spec, i) => {
    if (!spec) return;
    const cell = (record[i] ?? '').trim();
    raw[spec.name] = cell.length > MAX_CELL ? cell.slice(0, MAX_CELL) : cell;
    const problem = checkCell(spec.kind, cell);
    if (problem) errors.push({ column: spec.name, message: problem });
    let value: string | null = cell.length === 0 || problem ? null : cell;
    if (value !== null && spec.field === 'email') value = value.toLowerCase();
    if (value !== null && spec.field === 'batchLabel') value = value.replace(/[–—]/g, '-');
    staged[spec.field] = value;
  });
  return { rowNumber, raw, staged, errors };
}

// ---------------------------------------------------------------- error report (output)

/**
 * A cell for a CSV that will be opened in a spreadsheet: values that would run as a formula (a leading
 * = + - @ tab or CR) get a leading apostrophe, then the usual CSV quoting. ALWAYS applied, to every
 * echoed cell and every message.
 */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: readonly (string | number | null | undefined)[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

export interface ReportRow {
  rowNumber: number;
  status: string;
  raw: Record<string, string>;
  errors: CellError[];
  result: string | null;
}

/** The header line of the error report for a kind: row, status, the file's own columns, reason. */
export function reportHeader(kind: ImportKind): string {
  return csvLine(['row', 'status', ...COLUMNS[kind].map((c) => c.name), 'reason']);
}

/** One report line: the row number, its status, the cells as written, and why it was not imported. */
export function reportLine(kind: ImportKind, r: ReportRow): string {
  const reason =
    r.errors.length > 0
      ? r.errors.map((e) => (e.column ? `${e.column}: ${e.message}` : e.message)).join('; ')
      : (r.result ?? '');
  return csvLine([r.rowNumber, r.status, ...COLUMNS[kind].map((c) => r.raw[c.name] ?? ''), reason]);
}

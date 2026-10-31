// The SAFE writer of CSV files that people open in a spreadsheet (the import's error report, the progress export).
// Output rule: a value that would run as a formula (a leading = + - @ tab or CR) gets a leading apostrophe, then the
// usual CSV quoting. ALWAYS applied, to every cell. (The input rule of the import is column-aware and lives in the
// imports module.)

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: readonly (string | number | null | undefined)[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

import type { Cell, GridRow } from '@lms/backend/contracts';

// The pure part of the spreadsheet-like grid: keyboard movement, parsing a paste from Excel, turning a pasted block into
// mark cells. No React, no DOM: unit tested (frontend/test/gridModel.test.ts).

export interface Sel {
  row: number;
  col: number;
}

export type MoveKey =
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown';

/** Where the selection goes for a navigation key, clamped to the grid. Ctrl/Cmd+Home / End jump to the corners. */
export function moveSelection(
  sel: Sel,
  key: MoveKey,
  rows: number,
  cols: number,
  opts: { ctrl?: boolean; page?: number } = {},
): Sel {
  const lastRow = Math.max(0, rows - 1);
  const lastCol = Math.max(0, cols - 1);
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  const page = opts.page ?? 10;
  switch (key) {
    case 'ArrowUp':
      return { row: clamp(sel.row - 1, lastRow), col: sel.col };
    case 'ArrowDown':
      return { row: clamp(sel.row + 1, lastRow), col: sel.col };
    case 'ArrowLeft':
      return { row: sel.row, col: clamp(sel.col - 1, lastCol) };
    case 'ArrowRight':
      return { row: sel.row, col: clamp(sel.col + 1, lastCol) };
    case 'Home':
      return opts.ctrl ? { row: 0, col: 0 } : { row: sel.row, col: 0 };
    case 'End':
      return opts.ctrl ? { row: lastRow, col: lastCol } : { row: sel.row, col: lastCol };
    case 'PageUp':
      return { row: clamp(sel.row - page, lastRow), col: sel.col };
    case 'PageDown':
      return { row: clamp(sel.row + page, lastRow), col: sel.col };
  }
}

/**
 * Parses what Excel / Sheets put on the clipboard: tab-separated columns, a line break per row. A cell with a line break, a
 * tab or a quote inside is wrapped in double quotes (a double quote is doubled). A trailing line break is not a row.
 */
export function parsePaste(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === '\t') endCell();
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else if (ch === '\n') endRow();
    else cell += ch;
    i++;
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

/** A mark: digits with at most two decimals (a comma as decimal separator is accepted: it is what Excel shows in many locales). */
export const MARK_PATTERN = /^[0-9]{1,6}([.][0-9]{1,2})?$/;
export const normalizeMark = (raw: string): string => raw.trim().replace(',', '.');
export const isMark = (raw: string): boolean => MARK_PATTERN.test(normalizeMark(raw));

export interface GridColumn {
  key: string;
  kind: 'item' | 'category' | 'final' | 'grade';
  header: string;
  itemId?: string;
  /** a manual column the signed-in user may type into */
  editable?: boolean;
  /** the maximum of the item */
  max?: number;
}

export interface PasteResult {
  cells: {
    itemId: string;
    participantId: string;
    points: string | null;
    expected?: string | null;
  }[];
  /** cells that were not applied: not a mark, outside the grid, a column that is not editable, above the maximum */
  rejected: { row: number; col: number; reason: string }[];
}

/** The value a mark cell currently holds, as the server knows it (for the stale-cell check): null when nothing is stored. */
export function expectedOf(cell: Cell | undefined): string | null | undefined {
  if (!cell) return null;
  if (cell[0] === 's') return cell[1];
  if (cell[0] === 'o') return undefined; // an override hides the stored mark: no check
  return null;
}

/** Maps a pasted block onto the grid starting at `start`. An empty pasted cell clears the mark. */
export function pasteToCells(
  block: string[][],
  start: Sel,
  rows: Pick<GridRow, 'participantId' | 'cells'>[],
  cols: GridColumn[],
): PasteResult {
  const out: PasteResult = { cells: [], rejected: [] };
  block.forEach((line, dr) => {
    line.forEach((raw, dc) => {
      const r = start.row + dr;
      const c = start.col + dc;
      const row = rows[r];
      const col = cols[c];
      if (!row || !col) {
        out.rejected.push({ row: r, col: c, reason: 'outside the grid' });
        return;
      }
      if (col.kind !== 'item' || !col.editable || !col.itemId) {
        out.rejected.push({ row: r, col: c, reason: 'this column cannot be edited' });
        return;
      }
      const text = normalizeMark(raw);
      if (text !== '' && !MARK_PATTERN.test(text)) {
        out.rejected.push({ row: r, col: c, reason: `"${raw.trim()}" is not a mark` });
        return;
      }
      if (text !== '' && col.max !== undefined && Number(text) > col.max) {
        out.rejected.push({ row: r, col: c, reason: `more than the maximum of ${col.max}` });
        return;
      }
      const expected = expectedOf(row.cells[col.itemId]);
      out.cells.push({
        itemId: col.itemId,
        participantId: row.participantId,
        points: text === '' ? null : text,
        ...(expected === undefined ? {} : { expected }),
      });
    });
  });
  return out;
}

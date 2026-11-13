import { describe, expect, it } from 'vitest';
import {
  expectedOf,
  type GridColumn,
  isMark,
  moveSelection,
  normalizeMark,
  parsePaste,
  pasteToCells,
} from '../src/features/gradebook/gridModel';

// The pure part of the gradebook grid (step 11): keyboard movement, parsing a paste from Excel, mapping it onto mark cells.

describe('moveSelection', () => {
  const rows = 5;
  const cols = 4;
  it('moves by one and stops at the edges', () => {
    expect(moveSelection({ row: 2, col: 2 }, 'ArrowDown', rows, cols)).toEqual({ row: 3, col: 2 });
    expect(moveSelection({ row: 2, col: 2 }, 'ArrowUp', rows, cols)).toEqual({ row: 1, col: 2 });
    expect(moveSelection({ row: 2, col: 2 }, 'ArrowLeft', rows, cols)).toEqual({ row: 2, col: 1 });
    expect(moveSelection({ row: 2, col: 2 }, 'ArrowRight', rows, cols)).toEqual({ row: 2, col: 3 });
    expect(moveSelection({ row: 0, col: 0 }, 'ArrowUp', rows, cols)).toEqual({ row: 0, col: 0 });
    expect(moveSelection({ row: 4, col: 3 }, 'ArrowDown', rows, cols)).toEqual({ row: 4, col: 3 });
    expect(moveSelection({ row: 4, col: 3 }, 'ArrowRight', rows, cols)).toEqual({ row: 4, col: 3 });
  });
  it('Home / End go to the row ends, with Ctrl to the corners; Page keys move by a page', () => {
    expect(moveSelection({ row: 2, col: 2 }, 'Home', rows, cols)).toEqual({ row: 2, col: 0 });
    expect(moveSelection({ row: 2, col: 2 }, 'End', rows, cols)).toEqual({ row: 2, col: 3 });
    expect(moveSelection({ row: 2, col: 2 }, 'Home', rows, cols, { ctrl: true })).toEqual({
      row: 0,
      col: 0,
    });
    expect(moveSelection({ row: 2, col: 2 }, 'End', rows, cols, { ctrl: true })).toEqual({
      row: 4,
      col: 3,
    });
    expect(moveSelection({ row: 1, col: 1 }, 'PageDown', 100, cols, { page: 20 })).toEqual({
      row: 21,
      col: 1,
    });
    expect(moveSelection({ row: 5, col: 1 }, 'PageUp', 100, cols, { page: 20 })).toEqual({
      row: 0,
      col: 1,
    });
  });
  it('an empty grid stays at 0, 0', () => {
    expect(moveSelection({ row: 0, col: 0 }, 'ArrowDown', 0, 0)).toEqual({ row: 0, col: 0 });
  });
});

describe('parsePaste (what Excel and Sheets copy)', () => {
  it('tabs separate columns, line breaks rows, a trailing line break is not a row', () => {
    expect(parsePaste('1\t2\t3\r\n4\t5\t6\r\n')).toEqual([
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
    expect(parsePaste('1\t2\n3\t4')).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });
  it('empty cells are kept (they clear a mark)', () => {
    expect(parsePaste('1\t\t3\n\t5\t')).toEqual([
      ['1', '', '3'],
      ['', '5', ''],
    ]);
  });
  it('a quoted cell may hold a tab, a line break and doubled quotes', () => {
    expect(parsePaste('"a\tb"\t"line1\nline2"\t"say ""hi"""')).toEqual([
      ['a\tb', 'line1\nline2', 'say "hi"'],
    ]);
  });
  it('one number is a one-cell block, nothing is no block', () => {
    expect(parsePaste('42')).toEqual([['42']]);
    expect(parsePaste('')).toEqual([]);
  });
});

describe('marks', () => {
  it('accepts digits with at most two decimals; a decimal comma is allowed', () => {
    for (const ok of ['0', '7', '12.5', '12,5', '100.25', ' 8 ']) expect(isMark(ok), ok).toBe(true);
    for (const bad of ['', 'abc', '-1', '1.234', '=1+1', '1e3', '12.', '.5'])
      expect(isMark(bad), bad).toBe(false);
    expect(normalizeMark(' 12,5 ')).toBe('12.5');
  });
});

const col = (itemId: string, over: Partial<GridColumn> = {}): GridColumn => ({
  key: `item:${itemId}`,
  kind: 'item',
  header: itemId,
  itemId,
  editable: true,
  max: 20,
  ...over,
});
const rows = [
  { participantId: 'p1', cells: { a: ['s', '10', 0], b: ['x', null, 0] } },
  { participantId: 'p2', cells: { a: ['o', '5', 0] } },
  { participantId: 'p3', cells: {} },
] as Parameters<typeof pasteToCells>[2];
const cols: GridColumn[] = [
  col('a'),
  col('b'),
  col('c', { editable: false }),
  { key: 'final', kind: 'final', header: 'Final' },
];

describe('pasteToCells', () => {
  it('maps the block from the selected cell; an empty cell clears; the stored value travels as "expected"', () => {
    const r = pasteToCells(
      [
        ['11', ''],
        ['12', '3'],
      ],
      { row: 0, col: 0 },
      rows,
      cols,
    );
    expect(r.rejected).toEqual([]);
    expect(r.cells).toEqual([
      { itemId: 'a', participantId: 'p1', points: '11', expected: '10' },
      { itemId: 'b', participantId: 'p1', points: null, expected: null },
      // an overridden cell hides the stored mark: no stale check
      { itemId: 'a', participantId: 'p2', points: '12' },
      { itemId: 'b', participantId: 'p2', points: '3', expected: null },
    ]);
  });
  it('rejects, cell by cell, what cannot be applied and keeps the rest', () => {
    const r = pasteToCells([['5', '=1+1', '4', '99']], { row: 2, col: 0 }, rows, cols);
    expect(r.cells).toEqual([{ itemId: 'a', participantId: 'p3', points: '5', expected: null }]);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      '"=1+1" is not a mark',
      'this column cannot be edited',
      'this column cannot be edited',
    ]);
  });
  it('a value above the maximum and cells beyond the last row are rejected', () => {
    const r = pasteToCells([['25'], ['1'], ['1']], { row: 1, col: 0 }, rows, cols);
    expect(r.cells).toEqual([{ itemId: 'a', participantId: 'p3', points: '1', expected: null }]);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      'more than the maximum of 20',
      'outside the grid',
    ]);
  });
  it('expectedOf: marked = the value, overridden = unknown, anything else = nothing stored', () => {
    expect(expectedOf(['s', '4', 0])).toBe('4');
    expect(expectedOf(['o', '4', 0])).toBeUndefined();
    expect(expectedOf(['z', '0', 0])).toBeNull();
    expect(expectedOf(['x', null, 0])).toBeNull();
    expect(expectedOf(undefined)).toBeNull();
  });
});

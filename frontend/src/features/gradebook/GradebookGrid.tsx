// biome-ignore-all lint/a11y/useSemanticElements: a grid of 30,000 cells is virtualized (absolutely positioned divs with the ARIA grid roles); a <table> cannot be virtualized in both directions
// biome-ignore-all lint/a11y/useFocusableInteractive: ARIA grid pattern: the grid is the ONE tab stop and moves aria-selected between cells (roving selection), the cells are not tab stops
import type { GradebookConfig, GridRow } from '@lms/backend/contracts';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '../../shared/utils/cn';
import type { MarkCell } from './gradebook.api';
import {
  expectedOf,
  type GridColumn,
  isMark,
  type MoveKey,
  moveSelection,
  normalizeMark,
  parsePaste,
  pasteToCells,
  type Sel,
} from './gridModel';

// The gradebook grid: learners x items with category totals and the final. Virtualized in BOTH directions (500 learners x 60
// items stay a few hundred DOM nodes), sticky header and learner column, a spreadsheet's keyboard (arrows, Home / End, Ctrl+Home /
// End, PageUp / PageDown, Enter or F2 or a digit to edit, Delete to clear, Tab) and paste from Excel. A grid is one tab stop with
// aria-selected cells (the ARIA grid pattern); the full learner name is in the first column and opens the explanation.

const ROW_H = 36;
const HEADER_H = 52;
const LEARNER_W = 200;

export interface GradebookGridProps {
  rows: GridRow[];
  config: GradebookConfig;
  /** the signed-in user may type marks into this manual item */
  canEnter: (item: GradebookConfig['items'][number]) => boolean;
  /** the gradebook cannot change now (submitted or locked) */
  locked: boolean;
  onCommit: (cells: MarkCell[]) => Promise<void>;
  onExplain: (row: GridRow) => void;
  onNotice: (message: string) => void;
  /** tests: jsdom has no layout, so the visible size is given */
  viewport?: { width: number; height: number };
}

export function buildColumns(
  config: GradebookConfig,
  canEnter: GradebookGridProps['canEnter'],
  locked: boolean,
): GridColumn[] {
  const order = new Map(config.categories.map((c, i) => [c.id, i]));
  const items = [...config.items].sort(
    (a, b) => (order.get(a.categoryId) ?? 0) - (order.get(b.categoryId) ?? 0),
  );
  return [
    ...items.map(
      (i): GridColumn => ({
        key: `item:${i.id}`,
        kind: 'item',
        header: i.title,
        itemId: i.id,
        max: i.points,
        editable: !locked && i.source === 'manual' && canEnter(i),
      }),
    ),
    ...config.categories.map(
      (c): GridColumn => ({ key: `cat:${c.id}`, kind: 'category', header: `${c.name} %` }),
    ),
    { key: 'final', kind: 'final', header: `Final / ${config.outOf}` },
    { key: 'grade', kind: 'grade', header: 'Grade' },
  ];
}

const STATE_LABEL: Record<string, string> = {
  s: '',
  o: 'adjusted',
  z: 'counted as zero',
  x: 'no mark',
  p: 'waiting to be graded',
  h: 'hidden',
};

export function GradebookGrid(props: GradebookGridProps) {
  const { rows, config, canEnter, locked, onCommit, onExplain, onNotice, viewport } = props;
  const columns = useMemo(() => buildColumns(config, canEnter, locked), [config, canEnter, locked]);
  const itemTitle = useMemo(
    () => new Map(config.items.map((i) => [i.id, i.title])),
    [config.items],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Sel>({ row: 0, col: 0 });
  type Edit = { row: number; col: number; value: string };
  const [edit, setEditState] = useState<Edit | null>(null);
  // the live value of the edit, so Enter followed by the blur it causes saves ONCE
  const editRef = useRef<Edit | null>(null);
  const setEdit = (v: Edit | null | ((s: Edit | null) => Edit | null)) => {
    const next = typeof v === 'function' ? v(editRef.current) : v;
    editRef.current = next;
    setEditState(next);
  };
  const [busy, setBusy] = useState(false);

  const widthOf = (c: GridColumn) => (c.kind === 'item' ? 112 : c.kind === 'grade' ? 72 : 104);
  const rowV = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_H,
    overscan: 8,
    ...(viewport ? { initialRect: viewport } : {}),
  });
  const colV = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => widthOf(columns[i] as GridColumn),
    overscan: 3,
    ...(viewport ? { initialRect: viewport } : {}),
  });
  const totalW = LEARNER_W + colV.getTotalSize();

  // keep the selection inside the grid when the data shrinks, and in view when it moves
  useEffect(() => {
    setSel((s) => ({
      row: Math.min(s.row, Math.max(0, rows.length - 1)),
      col: Math.min(s.col, Math.max(0, columns.length - 1)),
    }));
  }, [rows.length, columns.length]);
  // the selection is brought into view when IT moves, not on the first paint (a scroll at mount costs a second render)
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) {
      moved.current = true;
      return;
    }
    if (rows.length > 0) rowV.scrollToIndex(sel.row);
    colV.scrollToIndex(sel.col);
  }, [sel.row, sel.col, rows.length, rowV, colV]);

  const commit = async (cells: MarkCell[]) => {
    if (cells.length === 0) return;
    setBusy(true);
    try {
      await onCommit(cells);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (value: string) => {
    const col = columns[sel.col];
    if (!col?.editable || locked) return;
    setEdit({ row: sel.row, col: sel.col, value });
  };

  const finishEdit = async (move: 'down' | 'right' | 'stay', save: boolean) => {
    const e = editRef.current;
    if (!e) return;
    setEdit(null);
    scroller.current?.focus();
    if (save && e) {
      const row = rows[e.row];
      const col = columns[e.col];
      if (row && col?.itemId) {
        const text = normalizeMark(e.value);
        const cur = row.cells[col.itemId];
        const now = cur && (cur[0] === 's' || cur[0] === 'o') ? cur[1] : null;
        if (text !== '' && !isMark(text))
          onNotice(`"${e.value.trim()}" is not a mark: use digits with at most two decimals`);
        else if (text !== '' && col.max !== undefined && Number(text) > col.max)
          onNotice(`${col.header} is out of ${col.max}: ${text} is too much`);
        else if ((text === '' ? null : Number(text)) !== (now === null ? null : Number(now))) {
          const expected = expectedOf(cur);
          await commit([
            {
              itemId: col.itemId,
              participantId: row.participantId,
              points: text === '' ? null : text,
              ...(expected === undefined ? {} : { expected }),
            },
          ]);
        }
      }
    }
    if (move === 'down') setSel((s) => moveSelection(s, 'ArrowDown', rows.length, columns.length));
    if (move === 'right')
      setSel((s) => moveSelection(s, 'ArrowRight', rows.length, columns.length));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (edit || e.target !== e.currentTarget) return;
    const nav = [
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
    ];
    if (nav.includes(e.key)) {
      e.preventDefault();
      const page = Math.max(
        1,
        Math.floor(((scroller.current?.clientHeight ?? 400) - HEADER_H) / ROW_H) - 1,
      );
      setSel((s) =>
        moveSelection(s, e.key as MoveKey, rows.length, columns.length, {
          ctrl: e.ctrlKey || e.metaKey,
          page,
        }),
      );
    } else if (e.key === 'Tab') {
      // Tab moves along the row like a spreadsheet; at the edges the browser takes over (the grid is no keyboard trap)
      const next = e.shiftKey ? sel.col - 1 : sel.col + 1;
      if (next >= 0 && next < columns.length) {
        e.preventDefault();
        setSel({ row: sel.row, col: next });
      }
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      const row = rows[sel.row];
      const col = columns[sel.col];
      if (col?.editable && row && col.itemId) {
        const c = row.cells[col.itemId];
        startEdit(c && (c[0] === 's' || c[0] === 'o') && c[1] !== null ? c[1] : '');
      } else if (row) onExplain(row);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const row = rows[sel.row];
      const col = columns[sel.col];
      if (col?.editable && row && col.itemId) {
        const exp = expectedOf(row.cells[col.itemId]);
        void commit([
          {
            itemId: col.itemId,
            participantId: row.participantId,
            points: null,
            ...(exp === undefined ? {} : { expected: exp }),
          },
        ]);
      }
    } else if (/^[0-9.,]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      startEdit(e.key);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (edit) return; // pasting into the input of a single cell is the browser's own business
    e.preventDefault();
    if (locked) {
      onNotice('The gradebook is locked: marks cannot be pasted now');
      return;
    }
    const block = parsePaste(e.clipboardData.getData('text/plain'));
    if (block.length === 0) return;
    const result = pasteToCells(block, sel, rows, columns);
    if (result.rejected.length > 0) {
      const first = result.rejected[0];
      onNotice(
        `${result.rejected.length} pasted cell${result.rejected.length === 1 ? '' : 's'} not applied` +
          (first
            ? ` (first: row ${first.row + 1}, ${columns[first.col]?.header ?? 'outside the grid'}: ${first.reason})`
            : ''),
      );
    }
    void commit(result.cells);
  };

  const cellText = (
    row: GridRow,
    col: GridColumn,
  ): { text: string; label: string; muted: boolean; strike: boolean } => {
    if (col.kind === 'item' && col.itemId) {
      const c = row.cells[col.itemId];
      if (!c) return { text: '—', label: 'no mark', muted: true, strike: false };
      const dropped = c[2] === 1;
      const value = c[1];
      const hasValue = c[0] === 's' || c[0] === 'o' || c[0] === 'z';
      const text = hasValue
        ? `${value ?? '0'}${c[0] === 'o' ? ' ✎' : c[0] === 'z' ? '*' : ''}`
        : c[0] === 'p'
          ? 'wait'
          : '—';
      return {
        text,
        label: `${hasValue ? value : c[0] === 'p' ? 'pending, waiting to be graded' : STATE_LABEL[c[0]]}${dropped ? ', dropped' : ''}${c[0] === 'o' ? ', adjusted' : ''}${c[0] === 'z' ? ', counted as zero' : ''}`,
        muted: !hasValue,
        strike: dropped,
      };
    }
    if (col.kind === 'category') {
      const id = col.key.slice(4);
      const p = row.cats[id]?.p;
      return {
        text: p === null || p === undefined ? '—' : `${p}%`,
        label: p === null || p === undefined ? 'nothing counts yet' : `${p} percent`,
        muted: p === null || p === undefined,
        strike: false,
      };
    }
    if (col.kind === 'final')
      return {
        text: row.finalMarks === null ? '—' : `${row.finalMarks}${row.overridden ? ' ✎' : ''}`,
        label:
          row.finalMarks === null
            ? 'no total yet'
            : `${row.finalMarks}${row.overridden ? ', set by the instructor' : ''}`,
        muted: row.finalMarks === null,
        strike: false,
      };
    return {
      text: row.grade ?? '—',
      label: row.grade ?? 'no grade',
      muted: !row.grade,
      strike: false,
    };
  };

  const vRows = rowV.getVirtualItems();
  const vCols = colV.getVirtualItems();

  return (
    <div
      ref={scroller}
      role="grid"
      aria-label="Gradebook"
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length + 1}
      aria-busy={busy || undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      className="relative h-[70vh] min-h-72 overflow-auto rounded-md border border-border bg-surface text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
    >
      <div style={{ width: totalW, height: HEADER_H + rowV.getTotalSize(), position: 'relative' }}>
        {/* header: sticky at the top, its first cell also sticky at the left */}
        <div
          role="row"
          aria-rowindex={1}
          className="sticky top-0 z-20 border-b border-border bg-muted"
          style={{ height: HEADER_H, width: totalW }}
        >
          <div
            role="columnheader"
            aria-colindex={1}
            className="sticky left-0 z-30 flex items-center border-r border-border bg-muted px-3 font-semibold"
            style={{ width: LEARNER_W, height: HEADER_H, position: 'sticky' }}
          >
            Learner
          </div>
          {vCols.map((v) => {
            const col = columns[v.index] as GridColumn;
            const catName =
              col.kind === 'item'
                ? config.categories.find(
                    (c) => c.id === config.items.find((i) => i.id === col.itemId)?.categoryId,
                  )?.name
                : undefined;
            return (
              <div
                key={col.key}
                role="columnheader"
                aria-colindex={v.index + 2}
                title={col.header}
                className="absolute top-0 flex flex-col justify-center overflow-hidden border-r border-border px-2 leading-tight"
                style={{ left: LEARNER_W + v.start, width: v.size, height: HEADER_H }}
              >
                <span className="truncate font-semibold">{col.header}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {col.kind === 'item' ? `${catName ?? ''} · /${col.max}` : ''}
                </span>
              </div>
            );
          })}
        </div>

        {vRows.map((vr) => {
          const row = rows[vr.index] as GridRow;
          return (
            <div
              key={row.participantId}
              role="row"
              aria-rowindex={vr.index + 2}
              className={cn(
                'absolute left-0 border-b border-border',
                vr.index % 2 === 1 && 'bg-muted/40',
              )}
              style={{ top: HEADER_H + vr.start, height: vr.size, width: totalW }}
            >
              <div
                role="rowheader"
                aria-colindex={1}
                className="sticky left-0 z-10 flex items-center justify-between gap-2 border-r border-border bg-surface px-3"
                style={{ width: LEARNER_W, height: vr.size, position: 'sticky' }}
              >
                <button
                  type="button"
                  className="min-h-0 truncate text-left text-primary underline"
                  title={`${row.name}${row.registerNumber ? ` · ${row.registerNumber}` : ''}: how the final was calculated`}
                  onClick={() => onExplain(row)}
                >
                  {row.name}
                </button>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {row.registerNumber ?? ''}
                </span>
              </div>
              {vCols.map((v) => {
                const col = columns[v.index] as GridColumn;
                const selected = sel.row === vr.index && sel.col === v.index;
                const editing = edit?.row === vr.index && edit.col === v.index;
                const t = cellText(row, col);
                return (
                  <div
                    key={col.key}
                    role="gridcell"
                    aria-colindex={v.index + 2}
                    aria-selected={selected}
                    aria-readonly={!col.editable || undefined}
                    aria-label={`${row.name}, ${col.kind === 'item' ? (itemTitle.get(col.itemId ?? '') ?? col.header) : col.header}: ${t.label}`}
                    tabIndex={-1}
                    onMouseDown={() => {
                      setSel({ row: vr.index, col: v.index });
                      if (!editing) scroller.current?.focus();
                    }}
                    onDoubleClick={() => {
                      setSel({ row: vr.index, col: v.index });
                      if (col.editable) {
                        const c = col.itemId ? row.cells[col.itemId] : undefined;
                        setEdit({
                          row: vr.index,
                          col: v.index,
                          value: c && (c[0] === 's' || c[0] === 'o') && c[1] !== null ? c[1] : '',
                        });
                      }
                    }}
                    className={cn(
                      'absolute top-0 flex items-center justify-end overflow-hidden border-r border-border px-2 tabular-nums',
                      col.editable && 'bg-surface',
                      !col.editable && col.kind === 'item' && 'bg-muted/30',
                      t.muted && 'text-muted-foreground',
                      t.strike && 'line-through',
                      col.kind === 'final' && 'font-semibold',
                      selected && 'outline outline-2 -outline-offset-2 outline-primary',
                    )}
                    style={{ left: LEARNER_W + v.start, width: v.size, height: vr.size }}
                  >
                    {editing ? (
                      <input
                        // biome-ignore lint/a11y/noAutofocus: the cell was just opened for typing
                        autoFocus
                        aria-label={`Mark for ${row.name} in ${col.header}`}
                        inputMode="decimal"
                        value={edit?.value ?? ''}
                        onChange={(e) => setEdit((s) => (s ? { ...s, value: e.target.value } : s))}
                        onBlur={() => void finishEdit('stay', true)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void finishEdit(e.shiftKey ? 'stay' : 'down', true);
                          } else if (e.key === 'Tab') {
                            e.preventDefault();
                            void finishEdit('right', true);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            void finishEdit('stay', false);
                          }
                        }}
                        className="h-full w-full bg-surface text-right text-foreground outline-none"
                      />
                    ) : (
                      t.text
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

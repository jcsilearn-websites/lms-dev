import type { ReactNode } from 'react';
import { useMediaQuery } from '../utils/useMediaQuery';

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  /** The first column becomes the card title on a phone. */
  className?: string;
}

/**
 * Table on tablets and desktops, a list of cards on phones (below 768 px). Only the layout that is
 * shown is rendered (rendering both doubled the DOM and the work of every page with a list).
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  actions,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Names the table for screen readers. */
  caption: string;
  /** Per-row actions (shown as the last column / at the bottom of the card). */
  actions?: (row: T) => ReactNode;
}) {
  const wide = useMediaQuery('(min-width: 768px)');
  const [first, ...rest] = columns;
  if (wide) {
    return (
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-muted text-left">
            <tr>
              {columns.map((c) => (
                <th key={c.header} scope="col" className="px-3 py-2 font-medium">
                  {c.header}
                </th>
              ))}
              {actions && (
                <th scope="col" className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)} className="border-t border-border">
                {columns.map((c) => (
                  <td key={c.header} className={`px-3 py-2 align-middle ${c.className ?? ''}`}>
                    {c.cell(row)}
                  </td>
                ))}
                {actions && <td className="px-3 py-2 text-right">{actions(row)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <ul aria-label={caption} className="space-y-3">
      {rows.map((row) => (
        <li key={rowKey(row)} className="rounded-md border border-border bg-surface p-3">
          {first && <div className="font-medium">{first.cell(row)}</div>}
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {rest.map((c) => (
              <div key={c.header} className="contents">
                <dt className="text-muted-foreground">{c.header}</dt>
                <dd>{c.cell(row)}</dd>
              </div>
            ))}
          </dl>
          {actions && <div className="mt-3 flex flex-wrap gap-2">{actions(row)}</div>}
        </li>
      ))}
    </ul>
  );
}

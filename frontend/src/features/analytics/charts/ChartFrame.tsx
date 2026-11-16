import { type ReactNode, useId, useState } from 'react';
import { Button } from '../../../shared/ui/button';

export interface TableColumn {
  key: string;
  label: string;
}

/**
 * Every chart is wrapped in this: a heading, a TEXT SUMMARY (what the picture says, in words) and the same data as a real table. The
 * table is always in the page for assistive technology (visually hidden until "Show as table"), so nobody needs the picture.
 */
export function ChartFrame({
  title,
  summary,
  columns,
  rows,
  asOf,
  children,
}: {
  title: string;
  summary: string;
  columns: readonly TableColumn[];
  rows: readonly Record<string, string | number | null>[];
  /** "data as of" text, e.g. "4 Nov 2026, 10:15" */
  asOf?: string | null | undefined;
  children: ReactNode;
}) {
  const id = useId();
  const [table, setTable] = useState(false);
  return (
    <figure
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-s`}
      className="rounded-md border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <figcaption id={`${id}-t`} className="font-semibold">
          {title}
        </figcaption>
        <Button
          variant="ghost"
          aria-pressed={table}
          aria-controls={`${id}-table`}
          onClick={() => setTable((v) => !v)}
        >
          {table ? 'Show chart' : 'Show as table'}
        </Button>
      </div>
      <p id={`${id}-s`} className="mt-1 text-sm text-muted-foreground">
        {summary}
      </p>
      {asOf && <p className="text-xs text-muted-foreground">Data as of {asOf}</p>}
      <div className={table ? 'hidden' : 'mt-3'}>{children}</div>
      <div
        id={`${id}-table`}
        className={table ? 'mt-3 overflow-x-auto' : 'sr-only'}
        {...(table
          ? { role: 'region', 'aria-label': `${title} (scrolls sideways)`, tabIndex: 0 }
          : {})}
      >
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className="border-b border-border px-2 py-1 font-medium"
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a static, read-only table
              <tr key={i}>
                {columns.map((c, j) =>
                  j === 0 ? (
                    <th
                      key={c.key}
                      scope="row"
                      className="border-b border-border px-2 py-1 font-normal"
                    >
                      {r[c.key] ?? ''}
                    </th>
                  ) : (
                    <td key={c.key} className="border-b border-border px-2 py-1">
                      {r[c.key] ?? ''}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

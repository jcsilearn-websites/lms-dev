import type { ReportTable } from '@lms/backend/contracts';
import { formatCollegeTime } from './analytics.api';
import { ExportButtons } from './ExportButtons';
import { ScrollRegion } from './ScrollRegion';

function show(
  v: string | number | null,
  kind: ReportTable['columns'][number]['kind'],
  tz: string,
): string {
  if (v === null || v === '') return '—';
  switch (kind) {
    case 'percent':
      return `${v}%`;
    case 'datetime':
      return formatCollegeTime(String(v), tz);
    case 'number':
      return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(Number(v));
    default:
      return String(v);
  }
}

/** A report table as a real table with its sentence, "data as of" and the CSV / XLSX export. */
export function ReportTableView({
  table,
  exportPath,
}: {
  table: ReportTable;
  exportPath?: ((format: 'csv' | 'xlsx') => string) | undefined;
}) {
  return (
    <section
      aria-labelledby={`rt-${table.id}`}
      className="rounded-md border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id={`rt-${table.id}`} className="text-lg font-semibold">
          {table.title}
        </h2>
        {exportPath && (
          <ExportButtons subject={table.title} pathFor={exportPath} fileBase={table.id} />
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{table.summary}</p>
      {table.asOf && (
        <p className="text-xs text-muted-foreground">
          Data as of {formatCollegeTime(table.asOf, table.timeZone)}
        </p>
      )}
      {table.rows.length > 0 && (
        <ScrollRegion label={table.title} className="mt-3">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{table.title}</caption>
            <thead>
              <tr>
                {table.columns.map((c) => (
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
              {table.rows.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a static, read-only table
                <tr key={i}>
                  {table.columns.map((c) => (
                    <td key={c.key} className="border-b border-border px-2 py-1">
                      {show(r[c.key] ?? null, c.kind, table.timeZone)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
      {table.truncated && (
        <p className="mt-2 text-xs text-muted-foreground">
          Only the first 100,000 rows are shown and exported.
        </p>
      )}
    </section>
  );
}

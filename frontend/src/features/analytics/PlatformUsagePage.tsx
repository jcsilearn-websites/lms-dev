import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, PageHeader } from '../../shared/ui/layout';
import { Select } from '../../shared/ui/select';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { analyticsKeys, getUsage, usageExportPath } from './analytics.api';
import { ChartFrame } from './charts/ChartFrame';
import { describeSeries } from './charts/chartMath';
import { BarChart } from './charts/charts';
import { ExportButtons } from './ExportButtons';
import { ScrollRegion } from './ScrollRegion';

/** The last 12 months, newest first, as first-of-month dates. */
export function monthChoices(now = new Date(), n = 12): string[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  });
}

/** What each college used in a month, for billing: aggregates only, closed months are frozen. */
export function PlatformUsagePage() {
  const months = monthChoices();
  const [month, setMonth] = useState(months[0] as string);
  const q = useQuery({
    queryKey: analyticsKeys.usage(month),
    queryFn: ({ signal }) => getUsage(month, signal),
  });
  const d = q.data;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Usage by college"
        description="Per month: billable learners, video watched, estimated video GB, storage and offerings. Aggregates only."
        actions={
          <ExportButtons
            subject={`usage of ${month.slice(0, 7)}`}
            pathFor={(f) => usageExportPath(month, f)}
            fileBase={`usage-${month.slice(0, 7)}`}
          />
        }
      />
      <Select
        label="Month"
        value={month}
        onChange={(e) => setMonth(e.target.value)}
        className="max-w-xs"
      >
        {months.map((m) => (
          <option key={m} value={m}>
            {m.slice(0, 7)}
          </option>
        ))}
      </Select>
      {q.isLoading ? (
        <ListSkeleton rows={4} label="Loading usage" />
      ) : q.isError ? (
        <ErrorState
          title="Could not load the usage"
          error={q.error}
          onRetry={() => void q.refetch()}
        />
      ) : !d || d.rows.length === 0 ? (
        <EmptyState title="No colleges yet" />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{d.note}</p>
          <ChartFrame
            title="Billable learners by college"
            summary={describeSeries(
              d.rows.map((r) => ({ label: r.name, value: r.billableLearners })),
              'learners',
              'college',
            )}
            columns={[
              { key: 'name', label: 'College' },
              { key: 'billable', label: 'Billable learners' },
            ]}
            rows={d.rows.map((r) => ({ name: r.name, billable: r.billableLearners }))}
          >
            <BarChart
              data={d.rows.map((r) => ({ label: r.slug, value: r.billableLearners }))}
              label="Billable learners of each college"
            />
          </ChartFrame>
          <ScrollRegion
            label="Usage of every college"
            className="rounded-md border border-border bg-surface"
          >
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Usage of every college in {month.slice(0, 7)}</caption>
              <thead>
                <tr>
                  {[
                    'College',
                    'State',
                    'Billable learners',
                    'Active users',
                    'Video hours',
                    'Video GB (est.)',
                    'Storage GB',
                    'Offerings',
                    'Members',
                  ].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="border-b border-border px-3 py-2 font-medium"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.tenantId}>
                    <th scope="row" className="border-b border-border px-3 py-2 font-normal">
                      {r.name} <span className="text-muted-foreground">({r.slug})</span>
                      {r.status !== 'active' && <Badge tone="warning">{r.status}</Badge>}
                    </th>
                    <td className="border-b border-border px-3 py-2">
                      {r.provisional ? 'Open (provisional)' : `Closed, revision ${r.revision}`}
                    </td>
                    <td className="border-b border-border px-3 py-2">{r.billableLearners}</td>
                    <td className="border-b border-border px-3 py-2">{r.activeUsers}</td>
                    <td className="border-b border-border px-3 py-2">{r.videoHours}</td>
                    <td className="border-b border-border px-3 py-2">{r.videoGbEstimate}</td>
                    <td className="border-b border-border px-3 py-2">{r.storageGb}</td>
                    <td className="border-b border-border px-3 py-2">
                      {r.offerings} ({r.activeOfferings} active)
                    </td>
                    <td className="border-b border-border px-3 py-2">{r.members}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        </>
      )}
    </div>
  );
}

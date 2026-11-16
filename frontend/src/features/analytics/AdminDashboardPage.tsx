import type { ReportTable, ReportTableId } from '@lms/backend/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../../shared/api/client';
import { PageHeader } from '../../shared/ui/layout';
import { Select } from '../../shared/ui/select';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import {
  analyticsKeys,
  formatCollegeTime,
  getActiveUsers,
  getReport,
  reportExportPath,
} from './analytics.api';
import { ChartFrame } from './charts/ChartFrame';
import { describeSeries } from './charts/chartMath';
import { BarChart, LineChart } from './charts/charts';
import { ExportButtons } from './ExportButtons';
import { ReportTableView } from './ReportTableView';

type Scope = 'department' | 'program' | 'batch' | 'section';

function useReport(table: ReportTableId, opts: { scope?: Scope; days?: number } = {}) {
  return useQuery({
    queryKey: analyticsKeys.report(table, opts.scope, opts.days),
    queryFn: ({ signal }) => getReport(table, opts, signal),
    staleTime: 60_000,
  });
}

function Block({
  q,
  children,
}: {
  q: ReturnType<typeof useReport>;
  children: (t: ReportTable) => React.ReactNode;
}) {
  if (q.isLoading) return <ListSkeleton rows={3} label="Loading" />;
  // a report the college has switched off (Needs attention) is simply not part of the page
  if (q.error instanceof ApiError && q.error.code === 'report_disabled') return null;
  if (q.isError)
    return (
      <ErrorState
        title="Could not load this report"
        error={q.error}
        onRetry={() => void q.refetch()}
      />
    );
  return q.data ? children(q.data) : null;
}

function ActiveUsers() {
  const q = useQuery({
    queryKey: analyticsKeys.activeUsers,
    queryFn: ({ signal }) => getActiveUsers(signal),
    staleTime: 60_000,
  });
  if (q.isLoading) return <ListSkeleton rows={1} label="Loading active users" />;
  if (q.isError)
    return (
      <ErrorState
        title="Could not load active users"
        error={q.error}
        onRetry={() => void q.refetch()}
      />
    );
  const a = q.data;
  if (!a) return null;
  return (
    <section aria-labelledby="active" className="grid gap-3 sm:grid-cols-3">
      <h2 id="active" className="sr-only">
        Active users
      </h2>
      {[
        ['Today', a.dau],
        ['Last 7 days', a.wau],
        ['Last 30 days', a.mau],
      ].map(([label, v]) => (
        <div key={label} className="rounded-md border border-border bg-surface p-4">
          <p className="text-2xl font-semibold">{v}</p>
          <p className="text-sm text-muted-foreground">
            Active users, {String(label).toLowerCase()}
          </p>
        </div>
      ))}
      <p className="text-xs text-muted-foreground sm:col-span-3">
        A person is active on a day when they used the LMS that day in {a.timeZone}
        {a.asOf ? `; data as of ${formatCollegeTime(a.asOf, a.timeZone)}` : ''}.
      </p>
    </section>
  );
}

/** The institution administrator's view of the whole college: activity, results by group, course health, approvals, backlog. */
export function AdminDashboardPage() {
  const [scope, setScope] = useState<Scope>('department');
  const activity = useReport('activity', { days: 30 });
  const org = useReport('organisation', { scope });
  const health = useReport('course-health');
  const books = useReport('gradebooks');
  const backlog = useReport('grading-backlog');
  const risk = useReport('at-risk');
  const resources = useReport('resources');
  return (
    <div className="space-y-6">
      <PageHeader
        title="College dashboard"
        description="Rollups refresh every few minutes; every table says when its data is from and can be exported."
      />
      <ActiveUsers />
      <Block q={activity}>
        {(t) => {
          const pts = t.rows.map((r) => ({ label: String(r.day), value: Number(r.active_users) }));
          return (
            <ChartFrame
              title="Active users per day (last 30 days)"
              summary={describeSeries(pts, 'users', 'day')}
              asOf={t.asOf ? formatCollegeTime(t.asOf, t.timeZone) : null}
              columns={t.columns.map((c) => ({ key: c.key, label: c.label }))}
              rows={t.rows}
            >
              <LineChart data={pts} label="Active users on each day" />
              <div className="mt-2">
                <ExportButtons
                  subject={t.title}
                  pathFor={(f) => reportExportPath('activity', f, { days: 30 })}
                  fileBase="activity"
                />
              </div>
            </ChartFrame>
          );
        }}
      </Block>
      <Block q={org}>
        {(t) => (
          <div className="space-y-3">
            <Select
              label="Group by"
              value={scope}
              onChange={(e) => setScope(e.target.value as Scope)}
              className="max-w-xs"
            >
              <option value="department">Department</option>
              <option value="program">Programme</option>
              <option value="batch">Batch</option>
              <option value="section">Section</option>
            </Select>
            {t.rows.every((r) => r.avg_completion === null) ? (
              <EmptyState
                title={`No results by ${scope} yet`}
                description="Results appear here once learners have a profile (a department, programme, batch or section) and have started working."
              />
            ) : (
              <ChartFrame
                title={`Average completion by ${scope}`}
                summary={describeSeries(
                  t.rows
                    .filter((r) => r.avg_completion !== null)
                    .map((r) => ({ label: String(r.name), value: Number(r.avg_completion) })),
                  '%',
                  'group',
                )}
                asOf={t.asOf ? formatCollegeTime(t.asOf, t.timeZone) : null}
                columns={t.columns.map((c) => ({ key: c.key, label: c.label }))}
                rows={t.rows}
              >
                <BarChart
                  data={t.rows
                    .filter((r) => r.avg_completion !== null)
                    .map((r) => ({ label: String(r.name), value: Number(r.avg_completion) }))}
                  unit="%"
                  label={`Average completion of required items by ${scope}`}
                />
                <div className="mt-2">
                  <ExportButtons
                    subject={t.title}
                    pathFor={(f) => reportExportPath('organisation', f, { scope })}
                    fileBase={`organisation-${scope}`}
                  />
                </div>
              </ChartFrame>
            )}
          </div>
        )}
      </Block>
      {(
        [
          [risk, 'at-risk'],
          [backlog, 'grading-backlog'],
          [books, 'gradebooks'],
          [health, 'course-health'],
          [resources, 'resources'],
        ] as const
      ).map(([q, id]) => (
        <Block key={id} q={q}>
          {(t) => <ReportTableView table={t} exportPath={(f) => reportExportPath(id, f)} />}
        </Block>
      ))}
    </div>
  );
}

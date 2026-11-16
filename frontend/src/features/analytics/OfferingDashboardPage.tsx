import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { Badge, PageHeader } from '../../shared/ui/layout';
import { Select } from '../../shared/ui/select';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { courseKeys, getOutline } from '../courses/courses.api';
import {
  analyticsKeys,
  formatCollegeDay,
  formatCollegeTime,
  getOfferingDashboard,
  getVideoEngagement,
} from './analytics.api';
import { ChartFrame } from './charts/ChartFrame';
import { describeDropOff, describeFunnel, describeSeries } from './charts/chartMath';
import { FunnelChart, HeatStrip, LineChart } from './charts/charts';
import { ScrollRegion } from './ScrollRegion';

const KIND: Record<string, string> = {
  assignment_due: 'Assignment due',
  assessment_closes: 'Quiz closes',
  assessment_opens: 'Quiz opens',
};

function VideoDropOff({ offeringId }: { offeringId: string }) {
  const outline = useQuery({
    queryKey: courseKeys.outline(offeringId),
    queryFn: ({ signal }) => getOutline(offeringId, signal),
  });
  const videos = (outline.data?.modules ?? [])
    .flatMap((m) => m.items)
    .filter((i) => i.kind === 'video' && !i.locked);
  const [chosen, setChosen] = useState<string>('');
  const itemId = chosen || videos[0]?.id || '';
  const q = useQuery({
    queryKey: analyticsKeys.video(offeringId, itemId),
    queryFn: ({ signal }) => getVideoEngagement(offeringId, itemId, signal),
    enabled: itemId !== '',
  });
  if (outline.isLoading) return <ListSkeleton rows={2} label="Loading videos" />;
  if (videos.length === 0) return <EmptyState title="This offering has no videos" />;
  const v = q.data;
  const mm = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return (
    <div className="space-y-3">
      <Select
        label="Video"
        value={itemId}
        onChange={(e) => setChosen(e.target.value)}
        className="max-w-sm"
      >
        {videos.map((x) => (
          <option key={x.id} value={x.id}>
            {x.title}
          </option>
        ))}
      </Select>
      {q.isLoading ? (
        <ListSkeleton rows={2} label="Loading drop-off" />
      ) : q.isError ? (
        <ErrorState
          title="Could not load the drop-off"
          error={q.error}
          onRetry={() => void q.refetch()}
        />
      ) : v ? (
        <ChartFrame
          title={`Drop-off: ${v.title}`}
          summary={`${v.started} of ${v.learners} learners started this video. ${describeDropOff(v.segments)} Aggregate only: no learner is named.`}
          columns={[
            { key: 'at', label: 'From' },
            { key: 'percent', label: 'Learners who watched this part (%)' },
          ]}
          rows={v.segments.map((s) => ({ at: mm(s.fromSecond), percent: s.percent }))}
        >
          <HeatStrip
            cells={v.segments.map((s) => ({ label: mm(s.fromSecond), value: s.percent }))}
            max={100}
            unit="%"
            label={`Share of learners who watched each part of ${v.title}`}
          />
        </ChartFrame>
      ) : null}
    </div>
  );
}

/** One offering for its instructors, assistants and administrators: backlog, what is coming, the module funnel, quizzes, activity. */
export function OfferingDashboardPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const q = useQuery({
    queryKey: analyticsKeys.offering(id),
    queryFn: ({ signal }) => getOfferingDashboard(id, signal),
  });
  const d = q.data;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Offering dashboard"
        actions={
          <>
            <Link to={`/offerings/${id}/at-risk` as '/'} className="text-sm text-primary underline">
              Flagged learners
            </Link>
            <Link
              to={`/offerings/${id}/progress` as '/'}
              className="text-sm text-primary underline"
            >
              Class progress
            </Link>
          </>
        }
      />
      {q.isLoading ? (
        <ListSkeleton rows={5} label="Loading the dashboard" />
      ) : q.isError ? (
        <ErrorState
          title="Could not load the dashboard"
          error={q.error}
          onRetry={() => void q.refetch()}
        />
      ) : d ? (
        <>
          <section aria-labelledby="backlog" className="grid gap-3 sm:grid-cols-3">
            <h2 id="backlog" className="sr-only">
              Grading backlog
            </h2>
            {[
              ['Learners', d.learners],
              ['Hand-ins waiting for a grade', d.backlog.submissions],
              ['Quiz attempts waiting', d.backlog.attempts],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md border border-border bg-surface p-4">
                <p className="text-2xl font-semibold">{value}</p>
                <p className="text-sm text-muted-foreground">{label}</p>
              </div>
            ))}
          </section>
          <section aria-labelledby="upcoming">
            <h2 id="upcoming" className="mb-2 text-lg font-semibold">
              Coming up (14 days)
            </h2>
            {d.upcoming.length === 0 ? (
              <EmptyState title="No deadlines or quizzes in the next 14 days" />
            ) : (
              <ul className="rounded-md border border-border bg-surface px-4">
                {d.upcoming.map((u) => (
                  <li
                    key={`${u.kind}-${u.itemId}`}
                    className="flex flex-wrap justify-between gap-2 border-b border-border py-2 last:border-0"
                  >
                    <span>{u.title}</span>
                    <span className="text-sm text-muted-foreground">
                      {KIND[u.kind] ?? ''} {formatCollegeTime(u.at, d.timeZone)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="funnel" className="space-y-2">
            <h2 id="funnel" className="sr-only">
              Module completion funnel
            </h2>
            {d.funnel.length === 0 ? (
              <EmptyState title="No modules yet" />
            ) : (
              <ChartFrame
                title="Module completion funnel"
                summary={describeFunnel(
                  d.funnel.map((f) => ({ label: f.title, value: f.completed })),
                )}
                columns={[
                  { key: 'title', label: 'Module' },
                  { key: 'required', label: 'Required items' },
                  { key: 'started', label: 'Learners started' },
                  { key: 'completed', label: 'Learners completed' },
                ]}
                rows={d.funnel.map((f) => ({
                  title: f.title,
                  required: f.requiredItems,
                  started: f.started,
                  completed: f.completed,
                }))}
              >
                <FunnelChart
                  stages={d.funnel.map((f) => ({ label: f.title, value: f.completed }))}
                  label="Learners who completed every required item of each module"
                />
              </ChartFrame>
            )}
          </section>
          <section aria-labelledby="assessments">
            <h2 id="assessments" className="mb-2 text-lg font-semibold">
              Assessments
            </h2>
            {d.assessments.length === 0 ? (
              <EmptyState title="No assessments in this offering" />
            ) : (
              <ScrollRegion
                label="Assessment summaries"
                className="rounded-md border border-border bg-surface"
              >
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Assessment summaries</caption>
                  <thead>
                    <tr>
                      {['Assessment', 'Attempts', 'Learners', 'Average', 'Passed'].map((h) => (
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
                    {d.assessments.map((a) => (
                      <tr key={a.itemId}>
                        <th scope="row" className="border-b border-border px-3 py-2 font-normal">
                          {a.title}
                        </th>
                        <td className="border-b border-border px-3 py-2">{a.attempts}</td>
                        <td className="border-b border-border px-3 py-2">{a.learners}</td>
                        <td className="border-b border-border px-3 py-2">
                          {a.averagePercent === null ? '—' : `${a.averagePercent}%`}
                        </td>
                        <td className="border-b border-border px-3 py-2">
                          {a.passRatePercent === null ? '—' : `${a.passRatePercent}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollRegion>
            )}
          </section>
          <section aria-labelledby="recent" className="space-y-2">
            <h2 id="recent" className="sr-only">
              Recent activity
            </h2>
            {d.recent.length === 0 ? (
              <EmptyState
                title="No learner activity yet"
                description="Daily activity shows here once learners start."
              />
            ) : (
              <ChartFrame
                title="Active learners per day (last 30 days)"
                summary={describeSeries(
                  d.recent.map((r) => ({
                    label: formatCollegeDay(`${r.day}T12:00:00Z`, 'UTC'),
                    value: r.activeLearners,
                  })),
                  'learners',
                  'day',
                )}
                asOf={d.asOf ? formatCollegeTime(d.asOf, d.timeZone) : null}
                columns={[
                  { key: 'day', label: 'Day' },
                  { key: 'active', label: 'Active learners' },
                  { key: 'done', label: 'Items completed' },
                  { key: 'sub', label: 'Hand-ins' },
                  { key: 'att', label: 'Quiz attempts' },
                ]}
                rows={d.recent.map((r) => ({
                  day: r.day,
                  active: r.activeLearners,
                  done: r.itemsCompleted,
                  sub: r.submissions,
                  att: r.attempts,
                }))}
              >
                <LineChart
                  data={d.recent.map((r) => ({ label: r.day, value: r.activeLearners }))}
                  label="Learners active on each day"
                />
              </ChartFrame>
            )}
          </section>
          <section
            aria-labelledby="atrisk"
            className="rounded-md border border-border bg-surface p-4"
          >
            <h2 id="atrisk" className="text-lg font-semibold">
              Learners flagged{' '}
              <Badge tone={d.atRiskCount > 0 ? 'warning' : 'neutral'}>{d.atRiskCount}</Badge>
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Flagged by the college's rules, each with its evidence. Only the staff of this
              offering see the list.
            </p>
            <Link
              to={`/offerings/${id}/at-risk` as '/'}
              className="mt-2 inline-block text-sm text-primary underline"
            >
              See who and why
            </Link>
          </section>
          <section aria-labelledby="video" className="space-y-2">
            <h2 id="video" className="text-lg font-semibold">
              Video engagement
            </h2>
            <VideoDropOff offeringId={id} />
          </section>
        </>
      ) : null}
    </div>
  );
}

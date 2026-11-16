import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge, PageHeader } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { analyticsKeys, formatCollegeTime, getTeachingDashboard } from './analytics.api';

/** Across the offerings the signed-in person teaches or assists: where grading waits and who needs a look. */
export function TeachingDashboardPage() {
  const q = useQuery({
    queryKey: analyticsKeys.teaching,
    queryFn: ({ signal }) => getTeachingDashboard(signal),
  });
  return (
    <div>
      <PageHeader
        title="Teaching"
        description="Your offerings at a glance. Learner details are one click away."
      />
      {q.isLoading ? (
        <ListSkeleton rows={4} label="Loading your offerings" />
      ) : q.isError ? (
        <ErrorState
          title="Could not load the teaching dashboard"
          error={q.error}
          onRetry={() => void q.refetch()}
        />
      ) : !q.data || q.data.offerings.length === 0 ? (
        <EmptyState
          title="You do not teach or assist in a published offering"
          description="When you are added to one, it appears here."
        />
      ) : (
        <>
          {q.data.asOf && (
            <p className="mb-3 text-sm text-muted-foreground">
              Data as of {formatCollegeTime(q.data.asOf, q.data.timeZone)} ({q.data.timeZone});
              grading counts are live.
            </p>
          )}
          <ul className="grid gap-3 md:grid-cols-2">
            {q.data.offerings.map((o) => (
              <li key={o.offeringId} className="rounded-md border border-border bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <Link
                    to={`/offerings/${o.offeringId}/dashboard` as '/'}
                    className="font-semibold text-primary underline"
                  >
                    {o.title}
                  </Link>
                  <Badge>{o.participation === 'instructor' ? 'Instructor' : 'Assistant'}</Badge>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Learners</dt>
                  <dd>{o.learners}</dd>
                  <dt className="text-muted-foreground">Average progress</dt>
                  <dd>
                    {o.averageProgressPercent === null ? '—' : `${o.averageProgressPercent}%`}
                  </dd>
                  <dt className="text-muted-foreground">Waiting to be graded</dt>
                  <dd>
                    {o.backlogSubmissions} hand-ins, {o.backlogAttempts} quiz attempts
                  </dd>
                  <dt className="text-muted-foreground">Learners flagged</dt>
                  <dd>{o.atRiskCount}</dd>
                  <dt className="text-muted-foreground">Next deadline</dt>
                  <dd>
                    {o.nextDeadline
                      ? formatCollegeTime(o.nextDeadline, q.data?.timeZone ?? 'UTC')
                      : '—'}
                  </dd>
                </dl>
                <div className="mt-3 flex flex-wrap gap-3 text-sm">
                  <Link
                    to={`/offerings/${o.offeringId}/at-risk` as '/'}
                    className="text-primary underline"
                  >
                    Flagged learners
                  </Link>
                  <Link
                    to={`/offerings/${o.offeringId}/progress` as '/'}
                    className="text-primary underline"
                  >
                    Class progress
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

import type { LearnerDashboard } from '@lms/backend/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { EmptyState, ErrorState, Skeleton } from '../../shared/ui/states';
import { analyticsKeys, formatCollegeTime, getLearnerDashboard } from './analytics.api';

const KIND: Record<string, string> = {
  assignment_due: 'Due',
  assessment_closes: 'Closes',
  assessment_opens: 'Opens',
  item_available: 'Available',
};

type Entry = LearnerDashboard['upcoming'][number];

function EntryRow({ e, tz }: { e: Entry; tz: string }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-border py-2 last:border-0">
      <Link
        to={`/offerings/${e.offeringId}/items/${e.itemId}` as '/'}
        className="font-medium text-primary underline"
      >
        {e.title}
      </Link>
      <span className="text-sm text-muted-foreground">
        {e.offeringTitle} · {KIND[e.kind] ?? ''} {formatCollegeTime(e.at, tz)}
      </span>
    </li>
  );
}

const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });

/**
 * The learner's own dashboard: what is coming up (in the COLLEGE's time zone), grades just released, the week and a streak.
 * Private to the learner: the API sends nothing about anybody else. No chart code is loaded for it.
 */
export function LearnerDashboardSection() {
  const q = useQuery({
    queryKey: analyticsKeys.learner,
    queryFn: ({ signal }) => getLearnerDashboard(signal),
    staleTime: 60_000,
  });
  if (q.isLoading)
    return (
      <div role="status" aria-label="Loading your dashboard" className="space-y-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  if (q.isError)
    return (
      <ErrorState
        title="Could not load your dashboard"
        error={q.error}
        onRetry={() => void q.refetch()}
      />
    );
  const d = q.data;
  if (!d) return null;
  const active = d.week.filter((w) => w.active).length;
  return (
    <div className="space-y-6" data-testid="learner-dashboard">
      <section aria-labelledby="upcoming">
        <h2 id="upcoming" className="mb-2 text-lg font-semibold">
          Coming up in the next 14 days
        </h2>
        {d.upcoming.length === 0 ? (
          <EmptyState
            title="Nothing is due soon"
            description="Deadlines, quizzes and new lessons of your courses show up here."
          />
        ) : (
          <ul className="rounded-md border border-border bg-surface px-4">
            {d.upcoming.map((e) => (
              <EntryRow key={`${e.kind}-${e.itemId}`} e={e} tz={d.timeZone} />
            ))}
          </ul>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          Times are in the college time zone ({d.timeZone}).
        </p>
      </section>
      {d.released.length > 0 && (
        <section aria-labelledby="released">
          <h2 id="released" className="mb-2 text-lg font-semibold">
            Recently released grades
          </h2>
          <ul className="rounded-md border border-border bg-surface px-4">
            {d.released.map((e) => (
              <EntryRow key={`${e.kind}-${e.itemId}`} e={{ ...e, kind: '' }} tz={d.timeZone} />
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="week">
        <h2 id="week" className="mb-2 text-lg font-semibold">
          Your week
        </h2>
        <p className="mb-2 text-sm text-muted-foreground">
          {active === 0 ? 'No activity yet this week.' : `Active on ${active} of 7 days this week.`}
          {d.streak >= 2 ? ` A streak of ${d.streak} days in a row.` : ''} Only you can see this.
        </p>
        <ol className="grid grid-cols-7 gap-1" aria-label="Days of this week">
          {d.week.map((w) => (
            <li
              key={w.date}
              className={`rounded-md border px-1 py-2 text-center text-xs ${w.active ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground'} ${w.date === d.today ? 'font-semibold underline' : ''}`}
            >
              <span>{DAY.format(new Date(`${w.date}T12:00:00Z`))}</span>
              <span className="sr-only">{w.active ? ', active' : ', no activity'}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

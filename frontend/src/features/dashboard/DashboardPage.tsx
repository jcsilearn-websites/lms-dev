import type { MyOfferingsProgress, OfferingDto } from '@lms/backend/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge } from '../../shared/ui/layout';
import { EmptyState, ErrorState, Skeleton } from '../../shared/ui/states';
import { usePermissions } from '../auth/useMe';
import { courseKeys, listMyCourses } from '../courses/courses.api';
import { ProgressBar } from '../progress/ProgressBar';
import { getMyOfferingsProgress, progressKeys } from '../progress/progress.api';

const ROLE: Record<string, string> = {
  instructor: 'Instructor',
  assistant: 'Assistant',
  learner: 'Learner',
};

type OfferingProgress = MyOfferingsProgress['offerings'][number];

function CourseCard({ o, progress }: { o: OfferingDto; progress: OfferingProgress | undefined }) {
  return (
    <li>
      <Link
        to={`/offerings/${o.id}` as '/'}
        className="flex h-full min-h-28 flex-col gap-2 rounded-md border border-border bg-surface p-4 hover:bg-muted"
      >
        <span className="text-xs text-muted-foreground">
          {o.courseCode} · {o.termName}
          {o.label ? ` · ${o.label}` : ''}
        </span>
        <span className="font-semibold">{o.title}</span>
        <span className="mt-auto flex flex-wrap gap-2">
          {o.myParticipation && <Badge>{ROLE[o.myParticipation]}</Badge>}
          {o.status === 'draft' && <Badge tone="warning">Draft</Badge>}
        </span>
        {progress && progress.totalRequired > 0 && (
          <ProgressBar
            percent={progress.percent}
            label={`Progress in ${o.title}`}
            detail={`${progress.completedRequired} of ${progress.totalRequired}`}
          />
        )}
      </Link>
    </li>
  );
}

function formatPosition(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

/** Home: "My courses" for everyone, plus shortcuts to the tools an administrator has. */
export function DashboardPage() {
  const { me, has } = usePermissions();
  const mine = useQuery({
    queryKey: [...courseKeys.mine, 'home'],
    queryFn: ({ signal }) => listMyCourses(undefined, signal),
  });
  // progress is a small separate read: the course cards never wait for it
  const progress = useQuery({
    queryKey: progressKeys.me,
    queryFn: ({ signal }) => getMyOfferingsProgress(signal),
    staleTime: 30_000,
  });
  const progressOf = new Map(progress.data?.offerings.map((p) => [p.offeringId, p]));
  const resume = progress.data?.resume ?? null;
  const shortcuts = [
    { to: '/courses', label: 'Courses', hint: 'The catalog of the college', perm: 'course.read' },
    {
      to: '/offerings',
      label: 'Offerings',
      hint: 'Courses taught in a term: sections and instructors',
      perm: 'course.read',
    },
    {
      to: '/members',
      label: 'Members',
      hint: 'Invite, search and manage people',
      perm: 'member.read',
    },
    {
      to: '/imports',
      label: 'Bulk import',
      hint: 'Add students or faculty from a CSV file',
      perm: 'import.run',
    },
    {
      to: '/academics',
      label: 'Academic setup',
      hint: 'Years, terms, departments, batches',
      perm: 'academic.manage',
    },
  ].filter((s) => has(s.perm));

  const items = mine.data?.items ?? [];
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Welcome{me ? `, ${me.user.displayName}` : ''}</h1>
      {resume && (
        <section aria-labelledby="continue">
          <h2 id="continue" className="mb-3 text-lg font-semibold">
            Continue where you left off
          </h2>
          <Link
            to={`/offerings/${resume.offeringId}/items/${resume.itemId}` as '/'}
            className="flex min-h-11 flex-col gap-1 rounded-md border border-border bg-surface p-4 hover:bg-muted"
          >
            <span className="font-semibold text-primary">{resume.itemTitle}</span>
            <span className="text-sm text-muted-foreground">
              {resume.offeringTitle}
              {resume.kind === 'video' && resume.positionSeconds > 0
                ? ` · resumes at ${formatPosition(resume.positionSeconds)}`
                : ''}
            </span>
          </Link>
        </section>
      )}
      <section aria-labelledby="my-courses">
        <h2 id="my-courses" className="mb-3 text-lg font-semibold">
          My courses
        </h2>
        {mine.isLoading ? (
          <div
            role="status"
            aria-label="Loading your courses"
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
        ) : mine.isError ? (
          <ErrorState
            title="Could not load your courses"
            error={mine.error}
            onRetry={() => void mine.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title="You are not in any course yet"
            description="When you are added to a course, or your section is, it shows up here."
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((o) => (
              <CourseCard key={o.id} o={o} progress={progressOf.get(o.id)} />
            ))}
          </ul>
        )}
      </section>
      {shortcuts.length > 0 && (
        <section aria-labelledby="tools">
          <h2 id="tools" className="mb-3 text-lg font-semibold">
            Administration
          </h2>
          <ul className="grid gap-3 sm:grid-cols-3">
            {shortcuts.map((s) => (
              <li key={s.to}>
                <Link
                  to={s.to as '/'}
                  className="block rounded-md border border-border bg-surface p-4 hover:bg-muted"
                >
                  <span className="font-medium">{s.label}</span>
                  <span className="mt-1 block text-sm text-muted-foreground">{s.hint}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

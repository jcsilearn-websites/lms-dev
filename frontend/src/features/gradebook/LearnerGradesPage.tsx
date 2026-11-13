import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { ErrorState, ListSkeleton } from '../../shared/ui/states';
import { ExplanationView } from './ExplanationView';
import { getMyGrades, gradebookKeys } from './gradebook.api';

/**
 * A learner's grades in one course: the items released to them, the totals of the categories and a running final that is
 * labelled PROVISIONAL (in words) until the instructor's gradebook is approved. Unreleased work is not part of any number
 * and is not mentioned (the API leaves it out; the sentinel test checks it).
 */
export function LearnerGradesPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const q = useQuery({
    queryKey: gradebookKeys.mine(id),
    queryFn: ({ signal }) => getMyGrades(id, signal),
  });
  return (
    <div className="space-y-5">
      <Link to={`/offerings/${id}` as '/'} className="text-sm text-primary underline">
        ← Back to the course
      </Link>
      <PageHeader title="My grades" />
      {q.isLoading && <ListSkeleton rows={5} label="Loading your grades" />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && (
        <>
          {q.data.provisional ? (
            <p role="status" className="rounded-md border border-warning p-3 text-sm">
              <Badge tone="warning">Provisional</Badge>{' '}
              {q.data.underRevision
                ? 'The final grade of this course is being revised. These figures use the results released so far and may still change.'
                : 'These figures use only the results released to you so far. They are not final until your instructor’s gradebook is approved.'}
            </p>
          ) : (
            <p role="status" className="rounded-md border border-success p-3 text-sm">
              <Badge tone="success">Final</Badge> This is the approved record (version{' '}
              {q.data.versionNo}).
            </p>
          )}
          <Card>
            <p className="text-sm text-muted-foreground">
              {q.data.provisional ? 'Running total' : 'Final total'}
            </p>
            <p className="text-3xl font-semibold tabular-nums" data-testid="final-marks">
              {q.data.final.marks === null ? '—' : q.data.final.marks}
              <span className="text-lg font-normal text-muted-foreground">
                {' '}
                / {q.data.explanation.outOf}
              </span>
            </p>
            {q.data.final.grade && (
              <p className="mt-1 text-lg" data-testid="final-grade">
                Grade {q.data.final.grade}
                {q.data.final.isPass === false ? ' (not passed)' : ''}
              </p>
            )}
          </Card>
          <Card title="How this was calculated">
            <ExplanationView explanation={q.data.explanation} provisional={q.data.provisional} />
          </Card>
        </>
      )}
    </div>
  );
}

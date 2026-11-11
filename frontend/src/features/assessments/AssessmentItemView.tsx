import type { AssessmentMe } from '@lms/backend/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ApiError } from '../../shared/api/client';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Badge, Card } from '../../shared/ui/layout';
import { ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { assessmentKeys, getMe, startAttempt } from './assessments.api';

// What the item page shows for a quiz or exam: the rules, the learner's attempts, the button to start or continue.
// A person who is not a learner of the offering (an instructor, an assistant) gets the links to the tools instead.

const BLOCKED: Record<string, string> = {
  empty: 'This assessment has no questions yet.',
  not_open: 'This assessment is not open yet.',
  closed: 'This assessment is closed.',
  no_attempts_left: 'You have used all your attempts.',
};
const SCORING = {
  highest: 'your highest attempt',
  latest: 'your latest attempt',
  average: 'the average of your attempts',
};
const stamp = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);

export function AssessmentItemView({ offeringId, itemId }: { offeringId: string; itemId: string }) {
  const me = useQuery({
    queryKey: assessmentKeys.me(offeringId, itemId),
    queryFn: ({ signal }) => getMe(offeringId, itemId, signal),
    retry: (n, err) => !(err instanceof ApiError && [403, 404].includes(err.status)) && n < 1,
  });
  if (me.isLoading) return <ListSkeleton rows={3} label="Loading the assessment" />;
  if (me.error instanceof ApiError && me.error.status === 403) {
    return <StaffLinks offeringId={offeringId} itemId={itemId} />;
  }
  if (me.isError || !me.data) {
    return (
      <ErrorState
        title="Could not load the assessment"
        error={me.error}
        onRetry={() => void me.refetch()}
      />
    );
  }
  return <LearnerView offeringId={offeringId} itemId={itemId} me={me.data} />;
}

function StaffLinks({ offeringId, itemId }: { offeringId: string; itemId: string }) {
  return (
    <Card title="Assessment">
      <p className="text-sm text-muted-foreground">
        You are not a learner here, so you do not take this assessment.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          to={`/offerings/${offeringId}/items/${itemId}/assessment` as '/'}
          className="inline-flex min-h-11 items-center rounded-md border border-input px-4 text-sm font-medium hover:bg-muted sm:min-h-9"
        >
          Settings and questions
        </Link>
        <Link
          to={`/offerings/${offeringId}/items/${itemId}/grading` as '/'}
          className="inline-flex min-h-11 items-center rounded-md border border-input px-4 text-sm font-medium hover:bg-muted sm:min-h-9"
        >
          Grading and results
        </Link>
      </div>
    </Card>
  );
}

function LearnerView({
  offeringId,
  itemId,
  me,
}: {
  offeringId: string;
  itemId: string;
  me: AssessmentMe;
}) {
  const navigate = useNavigate();
  const a = me.assessment;
  const start = useMutation({
    mutationFn: () => startAttempt(offeringId, itemId),
    onSuccess: (r) =>
      void navigate({ to: `/offerings/${offeringId}/attempts/${r.attemptId}/take` as '/' }),
    onError: (err) => toast.error(describeError(err)),
  });
  const minutes = a.timeLimitMinutes ? a.timeLimitMinutes + a.extraMinutes : null;
  return (
    <div className="space-y-4">
      <Card title={a.kind === 'exam' ? 'Exam' : 'Practice quiz'}>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Questions</dt>
            <dd>{a.questionCount}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Time limit</dt>
            <dd>
              {minutes ? `${minutes} minutes` : 'No limit of its own'}
              {a.extraMinutes > 0 && ` (including ${a.extraMinutes} extra minutes you were given)`}
            </dd>
          </div>
          {a.opensAt && (
            <div>
              <dt className="text-muted-foreground">Opens</dt>
              <dd>{stamp(a.opensAt)}</dd>
            </div>
          )}
          {a.closesAt && (
            <div>
              <dt className="text-muted-foreground">Closes</dt>
              <dd>{stamp(a.closesAt)}</dd>
            </div>
          )}
          <div>
            <dt className="text-muted-foreground">Attempts</dt>
            <dd>
              {me.attemptsUsed} of {a.attemptsAllowed} used
            </dd>
          </div>
          {a.attemptsAllowed > 1 && (
            <div>
              <dt className="text-muted-foreground">Your score is</dt>
              <dd>{SCORING[a.scoring]}</dd>
            </div>
          )}
          {a.passingScore != null && (
            <div>
              <dt className="text-muted-foreground">Pass mark</dt>
              <dd>{a.passingScore}%</dd>
            </div>
          )}
        </dl>
        {me.counted && (
          <p className="mt-4 text-lg font-semibold" data-testid="counted-score">
            Your score: {me.counted.score} / {me.counted.maxScore} ({me.counted.percent}%)
          </p>
        )}
        <div className="mt-4">
          {me.activeAttemptId ? (
            <Link
              to={`/offerings/${offeringId}/attempts/${me.activeAttemptId}/take` as '/'}
              className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground sm:min-h-9"
            >
              Continue your attempt
            </Link>
          ) : me.canStart ? (
            <Button loading={start.isPending} onClick={() => start.mutate()}>
              {me.attemptsUsed === 0 ? 'Start' : 'Start another attempt'}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">{BLOCKED[me.blockedReason ?? ''] ?? ''}</p>
          )}
          {minutes && !me.activeAttemptId && me.canStart && (
            <p className="mt-2 text-xs text-muted-foreground">
              The clock starts when you press the button and keeps running if you leave the page.
            </p>
          )}
        </div>
      </Card>
      {me.attempts.length > 0 && (
        <Card title="Your attempts">
          <ul className="divide-y divide-border">
            {me.attempts.map((x) => (
              <li
                key={x.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <span>
                  Attempt {x.attemptNo}
                  {x.submittedAt ? ` · handed in ${stamp(x.submittedAt)}` : ' · in progress'}
                </span>
                <span className="flex items-center gap-3">
                  {x.status === 'in_progress' && <Badge tone="warning">In progress</Badge>}
                  {x.pendingGrading && <Badge>Being graded</Badge>}
                  {x.score != null && x.maxScore != null && (
                    <span className="tabular-nums">
                      {x.score} / {x.maxScore}
                    </span>
                  )}
                  {x.status !== 'in_progress' && (
                    <Link
                      to={`/offerings/${offeringId}/attempts/${x.id}/result` as '/'}
                      className="text-primary underline"
                    >
                      {x.resultsVisible ? 'See the result' : 'Details'}
                    </Link>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

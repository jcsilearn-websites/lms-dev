import type { ResultDto } from '@lms/backend/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { RichTextView } from '../../shared/richtext/RichTextView';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { ErrorState, ListSkeleton } from '../../shared/ui/states';
import { cn } from '../../shared/utils/cn';
import { assessmentKeys, attemptImage, getResult } from './assessments.api';
import { queueKey } from './exam/answerQueue';
import { clearPaper } from './exam/examCache';

// The result of an attempt, as far as the assessment lets the learner see it: nothing until released (a plain
// message), then the score, then the marks and feedback per question, then (only if the settings allow it) the correct
// answers and explanations. There is no field for the key in the data unless the server decided to send it.

type ResultQuestion = ResultDto['questions'][number];
type Key = {
  correct?: string[];
  value?: number;
  tolerance?: number;
  mode?: string;
  accepted?: string[];
  explanation?: unknown;
};

export function ResultPage() {
  const { id, attemptId } = useParams({ strict: false }) as { id: string; attemptId: string };
  const result = useQuery({
    queryKey: assessmentKeys.result(id, attemptId),
    queryFn: ({ signal }) => getResult(id, attemptId, signal),
    // graded by a person later / released later: look again when the learner comes back to the tab
    refetchOnWindowFocus: true,
  });
  // the attempt is over: whatever this device kept for it has no use (and must not linger on a shared computer)
  useEffect(() => {
    try {
      localStorage.removeItem(queueKey(attemptId));
    } catch {
      // storage blocked: nothing to remove
    }
    clearPaper(attemptId);
  }, [attemptId]);

  if (result.isLoading) return <ListSkeleton rows={4} label="Loading your result" />;
  if (result.isError || !result.data) {
    return (
      <ErrorState
        title="Could not load the result"
        error={result.error}
        onRetry={() => void result.refetch()}
      />
    );
  }
  const r = result.data;
  const back = (
    <Link
      to={
        (r.attempt.itemId
          ? `/offerings/${id}/items/${r.attempt.itemId}`
          : `/offerings/${id}`) as '/'
      }
      className="text-sm text-primary underline"
    >
      ← Back to the assessment
    </Link>
  );
  if (r.result === 'not_released') {
    return (
      <div className="space-y-4">
        {back}
        <PageHeader title={`Attempt ${r.attempt.attemptNo}`} />
        <Card>
          <p className="font-medium">Your answers are in.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {r.attempt.status === 'submitted' ? 'Some answers are still being graded. ' : ''}
            Your instructor has not released the results yet. You will see them here when they do.
          </p>
          {r.attempt.submittedAt && (
            <p className="mt-2 text-xs text-muted-foreground">
              Handed in {new Date(r.attempt.submittedAt).toLocaleString()}
            </p>
          )}
        </Card>
      </div>
    );
  }
  const a = r.attempt;
  return (
    <div className="space-y-6">
      {back}
      <PageHeader title={`Attempt ${a.attemptNo}: result`} />
      <Card>
        {a.pendingGrading ? (
          <p>
            <strong>Not graded completely yet.</strong> Some of your answers wait for your
            instructor; the score appears when they are done.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-4">
            <p className="text-3xl font-semibold tabular-nums" data-testid="score">
              {a.score} / {a.maxScore}
            </p>
            {a.percent != null && <p className="text-lg tabular-nums">{a.percent}%</p>}
            {a.passed != null && (
              <Badge tone={a.passed ? 'success' : 'danger'}>
                {a.passed ? 'Passed' : 'Not passed'}
              </Badge>
            )}
          </div>
        )}
        {a.feedback && (
          <div className="mt-4 rounded-md border border-border p-3">
            <p className="text-sm font-medium">Feedback from your instructor</p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{a.feedback}</p>
          </div>
        )}
        {!a.answersShown && (
          <p className="mt-3 text-xs text-muted-foreground">
            The correct answers are not shown for this assessment.
          </p>
        )}
      </Card>
      <ol className="space-y-4">
        {r.questions.map((q) => (
          <li key={q.position}>
            <QuestionResult offeringId={id} attemptId={attemptId} q={q} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function QuestionResult({
  offeringId,
  attemptId,
  q,
}: {
  offeringId: string;
  attemptId: string;
  q: ResultQuestion;
}) {
  const key = q.key as Key | undefined;
  const mine = new Set(q.answer?.o ?? []);
  const correct = new Set(key?.correct ?? []);
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Question {q.position}</h2>
        <p className="text-sm tabular-nums">
          {q.dropped ? (
            <Badge>Does not count</Badge>
          ) : q.pendingGrading ? (
            <Badge tone="warning">Waiting for a grade</Badge>
          ) : q.score != null ? (
            <span>
              {q.score} / {q.points}
            </span>
          ) : null}
        </p>
      </div>
      <RichTextView doc={q.stem} />
      {q.images.map((img) => (
        <ResultImage
          key={img.fileId}
          offeringId={offeringId}
          attemptId={attemptId}
          fileId={img.fileId}
          alt={img.alt}
        />
      ))}
      {q.options.length > 0 && (
        <ul className="mt-3 space-y-2">
          {q.options.map((o) => {
            const picked = mine.has(o.id);
            const right = key ? correct.has(o.id) : null;
            return (
              <li
                key={o.id}
                className={cn(
                  'flex items-start gap-2 rounded-md border p-2 text-sm',
                  right === true
                    ? 'border-success'
                    : picked && right === false
                      ? 'border-danger'
                      : 'border-border',
                )}
              >
                <span className="min-w-24 shrink-0 text-xs font-medium">
                  {picked ? 'Your answer' : ''}
                  {right === true
                    ? picked
                      ? ' · correct'
                      : 'Correct answer'
                    : right === false && picked
                      ? ' · wrong'
                      : ''}
                </span>
                <span className="min-w-0">
                  <RichTextView doc={o.text} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {q.answer && (q.answer.t !== undefined || q.answer.n !== undefined) && (
        <p className="mt-3 whitespace-pre-wrap rounded-md border border-border p-2 text-sm">
          <span className="block text-xs font-medium text-muted-foreground">Your answer</span>
          {q.answer.t ?? q.answer.n}
        </p>
      )}
      {!q.answer && (
        <p className="mt-3 text-sm text-muted-foreground">You did not answer this question.</p>
      )}
      {key && key.value !== undefined && (
        <p className="mt-2 text-sm">
          Correct answer: <strong>{key.value}</strong>
          {key.tolerance ? ` (± ${key.tolerance}${key.mode === 'percent' ? '%' : ''})` : ''}
        </p>
      )}
      {key?.accepted && key.accepted.length > 0 && (
        <p className="mt-2 text-sm">
          Accepted answers: <strong>{key.accepted.join(', ')}</strong>
        </p>
      )}
      {key?.explanation != null && (
        <div className="mt-3 rounded-md border border-border p-3 text-sm">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Explanation</p>
          <RichTextView doc={key.explanation} />
        </div>
      )}
      {q.feedback && (
        <p className="mt-3 whitespace-pre-wrap rounded-md border border-border p-3 text-sm">
          <span className="block text-xs font-medium text-muted-foreground">Feedback</span>
          {q.feedback}
        </p>
      )}
    </Card>
  );
}

function ResultImage({
  offeringId,
  attemptId,
  fileId,
  alt,
}: {
  offeringId: string;
  attemptId: string;
  fileId: string;
  alt: string;
}) {
  const target = useQuery({
    queryKey: ['attempt-image', attemptId, fileId],
    queryFn: () => attemptImage(offeringId, attemptId, fileId),
    staleTime: 4 * 60_000,
  });
  if (!target.data) return null;
  return (
    <img
      src={target.data.url}
      alt={alt}
      loading="lazy"
      className="mt-3 max-h-80 max-w-full rounded-md border border-border"
    />
  );
}

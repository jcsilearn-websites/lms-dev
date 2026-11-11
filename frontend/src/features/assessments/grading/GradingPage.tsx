import type { RegradeResponse } from '@lms/backend/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../shared/api/client';
import { describeError } from '../../../shared/api/errors';
import { plainText, RichTextView } from '../../../shared/richtext/RichTextView';
import { Button } from '../../../shared/ui/button';
import { ConfirmDialog, Dialog } from '../../../shared/ui/dialog';
import { Badge, Card, PageHeader } from '../../../shared/ui/layout';
import { Select } from '../../../shared/ui/select';
import { EmptyState, ErrorState, ListSkeleton } from '../../../shared/ui/states';
import { toast } from '../../../shared/ui/toast';
import {
  type AttemptRow,
  assessmentKeys,
  getAnalysis,
  getConfig,
  getScript,
  gradeAnswer,
  gradingAnswers,
  gradingSummary,
  listAttempts,
  listRegrades,
  listVersions,
  regrade,
  releaseResults,
  type Script,
  setAttemptFeedback,
} from '../assessments.api';
import { TYPE_LABEL } from '../labels';

// Grading and results (instructors; assistants grade, only instructors regrade, release and see the analysis).
// Tabs: the attempts, grading by question (fast, keyboard friendly), regrade, item analysis.

type Tab = 'attempts' | 'grade' | 'regrade' | 'analysis';
const TABS: [Tab, string][] = [
  ['attempts', 'Attempts'],
  ['grade', 'Grade by question'],
  ['regrade', 'Regrade'],
  ['analysis', 'Item analysis'],
];

export function GradingPage() {
  const { id, itemId } = useParams({ strict: false }) as { id: string; itemId: string };
  const [tab, setTab] = useState<Tab>('attempts');
  return (
    <div className="space-y-4">
      <Link
        to={`/offerings/${id}/items/${itemId}` as '/'}
        className="text-sm text-primary underline"
      >
        ← Back to the assessment
      </Link>
      <PageHeader title="Grading and results" />
      <div
        role="tablist"
        aria-label="Grading"
        className="flex flex-wrap gap-2 border-b border-border pb-2"
      >
        {TABS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`tab-${k}`}
            aria-selected={tab === k}
            aria-controls={`panel-${k}`}
            onClick={() => setTab(k)}
            className="min-h-11 rounded-md border border-input px-3 text-sm font-medium aria-selected:bg-primary aria-selected:text-primary-foreground sm:min-h-9"
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'attempts' && <AttemptsTab offeringId={id} itemId={itemId} />}
        {tab === 'grade' && <GradeTab offeringId={id} itemId={itemId} />}
        {tab === 'regrade' && <RegradeTab offeringId={id} itemId={itemId} />}
        {tab === 'analysis' && <AnalysisTab offeringId={id} itemId={itemId} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ attempts, release, one script
const STATUS: Record<
  AttemptRow['status'],
  { text: string; tone: 'neutral' | 'warning' | 'success' }
> = {
  in_progress: { text: 'In progress', tone: 'warning' },
  submitted: { text: 'Waiting for grading', tone: 'warning' },
  graded: { text: 'Graded', tone: 'success' },
};

function AttemptsTab({ offeringId, itemId }: { offeringId: string; itemId: string }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<AttemptRow | null>(null);
  const [releasing, setReleasing] = useState(false);
  const list = useInfiniteQuery({
    queryKey: assessmentKeys.attempts(offeringId, itemId, status),
    queryFn: ({ pageParam, signal }) =>
      listAttempts(offeringId, itemId, status || undefined, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const release = useMutation({
    mutationFn: () => releaseResults(offeringId, itemId),
    onSuccess: (r) => {
      setReleasing(false);
      void qc.invalidateQueries({ queryKey: ['assessment', offeringId, itemId, 'attempts'] });
      toast.success(
        `${r.released} ${r.released === 1 ? 'attempt' : 'attempts'} released.${r.stillPending > 0 ? ` ${r.stillPending} still wait for grading and were not released.` : ''}`,
      );
    },
    onError: (err) => toast.error(describeError(err)),
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Select label="Show" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All attempts</option>
          <option value="submitted">Waiting for grading</option>
          <option value="graded">Graded</option>
          <option value="in_progress">In progress</option>
        </Select>
        <Button variant="secondary" onClick={() => setReleasing(true)}>
          Release results…
        </Button>
      </div>
      {list.isLoading ? (
        <ListSkeleton rows={5} label="Loading attempts" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No attempts yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Attempts</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="p-2">
                  Learner
                </th>
                <th scope="col" className="p-2">
                  Attempt
                </th>
                <th scope="col" className="p-2">
                  Status
                </th>
                <th scope="col" className="p-2">
                  Score
                </th>
                <th scope="col" className="p-2">
                  Page events
                </th>
                <th scope="col" className="p-2">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.attemptId} className="border-b border-border">
                  <th scope="row" className="p-2 font-medium">
                    {r.learnerName}
                  </th>
                  <td className="p-2">{r.attemptNo}</td>
                  <td className="p-2">
                    <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].text}</Badge>
                    {r.pendingManual > 0 && (
                      <span className="ml-1 text-xs">{r.pendingManual} to grade</span>
                    )}
                    {r.released && <span className="ml-1 text-xs">· released</span>}
                    {r.submitKind === 'deadline' && (
                      <span className="ml-1 text-xs">· closed at the deadline</span>
                    )}
                  </td>
                  <td className="p-2 tabular-nums">
                    {r.score != null ? `${r.score} / ${r.maxScore}` : '—'}
                  </td>
                  <td className="p-2 tabular-nums">{r.eventCount}</td>
                  <td className="p-2 text-right">
                    <Button
                      variant="secondary"
                      onClick={() => setOpen(r)}
                      aria-label={`Open the attempt of ${r.learnerName}`}
                    >
                      Open
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            loading={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      )}
      {open && (
        <ScriptDialog
          offeringId={offeringId}
          itemId={itemId}
          attempt={open}
          onClose={() => setOpen(null)}
        />
      )}
      <ConfirmDialog
        open={releasing}
        onClose={() => setReleasing(false)}
        onConfirm={() => release.mutate()}
        pending={release.isPending}
        title="Release the results?"
        description="Every fully graded attempt becomes visible to its learner as the assessment's settings allow (the score, and the correct answers if you chose that). Attempts that still wait for grading are not released."
        confirmLabel="Release graded results"
      />
    </div>
  );
}

const EVENT_TEXT: Record<string, string> = {
  hidden: 'tab hidden',
  visible: 'tab visible again',
  blur: 'window lost focus',
  focus: 'window focused again',
  offline: 'connection lost',
  online: 'connection back',
  resume: 'page opened / reloaded',
};

function ScriptDialog({
  offeringId,
  itemId,
  attempt,
  onClose,
}: {
  offeringId: string;
  itemId: string;
  attempt: AttemptRow;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const script = useQuery({
    queryKey: assessmentKeys.script(offeringId, attempt.attemptId),
    queryFn: ({ signal }) => getScript(offeringId, attempt.attemptId, signal),
  });
  const [feedback, setFeedback] = useState<string | null>(null);
  const saveFeedback = useMutation({
    mutationFn: () =>
      setAttemptFeedback(offeringId, attempt.attemptId, feedback ?? script.data?.feedback ?? null),
    onSuccess: () => toast.success('Feedback saved.'),
    onError: (err) => toast.error(describeError(err)),
  });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['assessment', offeringId, itemId] });
    void qc.invalidateQueries({ queryKey: assessmentKeys.script(offeringId, attempt.attemptId) });
  };
  const counts: Record<string, number> = {};
  for (const e of script.data?.events ?? []) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return (
    <Dialog open onClose={onClose} title={`${attempt.learnerName}: attempt ${attempt.attemptNo}`}>
      <div className="max-h-[75vh] space-y-4 overflow-y-auto text-sm">
        {script.isLoading && <ListSkeleton rows={3} label="Loading the attempt" />}
        {script.isError && (
          <ErrorState error={script.error} onRetry={() => void script.refetch()} />
        )}
        {script.data && (
          <>
            <p className="font-medium">
              Score {script.data.attempt.score ?? '—'} / {script.data.attempt.maxScore ?? '—'}
              {script.data.attempt.pendingManual > 0
                ? ` · ${script.data.attempt.pendingManual} answers to grade`
                : ''}
            </p>
            <details className="rounded-md border border-border p-2">
              <summary className="cursor-pointer text-sm font-medium">
                Page events ({script.data.events.length})
              </summary>
              <p className="mt-2 text-xs text-muted-foreground">
                What the browser reported while the learner took the exam: tab hidden, window out of
                focus, connection lost. It is information, not proof. It cannot tell whether the
                learner used another device, had help, or used notes, and a hidden tab can be a
                phone call or a notification.
              </p>
              {Object.keys(counts).length > 0 && (
                <ul className="mt-2 text-xs">
                  {Object.entries(counts).map(([k, n]) => (
                    <li key={k}>
                      {EVENT_TEXT[k] ?? k}: {n}
                    </li>
                  ))}
                </ul>
              )}
            </details>
            <ol className="space-y-3">
              {script.data.questions.map((q) => (
                <li key={q.position}>
                  <ScriptQuestion
                    offeringId={offeringId}
                    attemptId={attempt.attemptId}
                    q={q}
                    onGraded={done}
                  />
                </li>
              ))}
            </ol>
            <label className="block space-y-1 font-medium">
              Feedback for the whole attempt
              <textarea
                rows={3}
                defaultValue={script.data.feedback ?? ''}
                onChange={(e) => setFeedback(e.target.value)}
                className="block w-full rounded-md border border-input bg-surface p-2 text-base font-normal sm:text-sm"
              />
            </label>
            <div className="flex justify-end">
              <Button
                variant="secondary"
                loading={saveFeedback.isPending}
                onClick={() => saveFeedback.mutate()}
              >
                Save feedback
              </Button>
            </div>
          </>
        )}
      </div>
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

function answerText(a: Script['questions'][number]['answer']): string {
  if (!a) return '(no answer)';
  if (a.t !== undefined) return a.t;
  if (a.n !== undefined) return String(a.n);
  return (a.o ?? []).join(', ');
}

function ScriptQuestion({
  offeringId,
  attemptId,
  q,
  onGraded,
}: {
  offeringId: string;
  attemptId: string;
  q: Script['questions'][number];
  onGraded: () => void;
}) {
  const [score, setScore] = useState(q.score?.toString() ?? '');
  const [fb, setFb] = useState(q.feedback ?? '');
  const grade = useMutation({
    mutationFn: () =>
      gradeAnswer(offeringId, attemptId, q.position, {
        score: Number(score),
        feedback: fb.trim() || null,
      }),
    onSuccess: () => {
      toast.success(`Question ${q.position} graded.`);
      onGraded();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const correct = new Set((q.key.correct as string[] | undefined) ?? []);
  const picked = new Set(q.answer?.o ?? []);
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-xs font-semibold text-muted-foreground">
        Question {q.position} · {q.points} points · {TYPE_LABEL[q.type] ?? q.type}
        {q.dropped ? ' · does not count' : ''} · {q.spentSeconds}s
      </p>
      <RichTextView doc={q.stem} />
      {q.options.length > 0 ? (
        <ul className="space-y-1">
          {q.options.map((o) => (
            <li key={o.id} className="flex gap-2">
              <span className="w-28 shrink-0 text-xs">
                {picked.has(o.id) ? 'chosen' : ''}
                {correct.has(o.id) ? ' · correct' : ''}
              </span>
              <span>{plainText(o.text)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="whitespace-pre-wrap rounded-md border border-border p-2">
          {answerText(q.answer)}
        </p>
      )}
      {q.type === 'numeric' && <p className="text-xs">Correct: {String(q.key.value)}</p>}
      {q.type === 'short_answer' && Array.isArray(q.key.accepted) && (
        <p className="text-xs">Accepted: {(q.key.accepted as string[]).join(', ')}</p>
      )}
      {q.state === 'na' ? (
        <p className="text-sm">
          Scored automatically: {q.score ?? 0} / {q.points}
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
          <label className="block space-y-1 text-sm font-medium">
            Points (0–{q.points})
            <input
              inputMode="decimal"
              value={score}
              onChange={(e) => setScore(e.target.value)}
              className="block min-h-11 w-full rounded-md border border-input bg-surface px-3 text-base sm:min-h-9 sm:text-sm"
            />
          </label>
          <label className="block space-y-1 text-sm font-medium">
            Feedback
            <input
              value={fb}
              maxLength={5000}
              onChange={(e) => setFb(e.target.value)}
              className="block min-h-11 w-full rounded-md border border-input bg-surface px-3 text-base sm:min-h-9 sm:text-sm"
            />
          </label>
          <Button
            loading={grade.isPending}
            disabled={score.trim() === '' || Number.isNaN(Number(score))}
            onClick={() => grade.mutate()}
          >
            {q.state === 'graded' ? 'Update grade' : 'Save grade'}
          </Button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ grading by question: one answer at a time
function GradeTab({ offeringId, itemId }: { offeringId: string; itemId: string }) {
  const summary = useQuery({
    queryKey: assessmentKeys.grading(offeringId, itemId),
    queryFn: ({ signal }) => gradingSummary(offeringId, itemId, signal),
  });
  const [questionId, setQuestionId] = useState<string | null>(null);
  if (summary.isLoading) return <ListSkeleton rows={3} label="Loading the grading queue" />;
  if (summary.isError || !summary.data)
    return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;
  const qs = summary.data.questions;
  if (qs.length === 0) {
    return (
      <EmptyState
        title="Nothing to grade"
        description="Questions that need a person (essays, short answers marked by hand) appear here once learners hand in."
      />
    );
  }
  const picked = qs.find((q) => q.questionId === questionId);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {summary.data.attemptsToGrade} attempts wait for grading.
      </p>
      <ul className="space-y-2">
        {qs.map((q) => (
          <li key={q.questionId}>
            <button
              type="button"
              aria-pressed={q.questionId === questionId}
              onClick={() => setQuestionId(q.questionId)}
              className="flex min-h-11 w-full flex-wrap items-center justify-between gap-2 rounded-md border border-input p-3 text-left text-sm aria-pressed:border-primary"
            >
              <span className="min-w-0 break-words">
                <Badge>{TYPE_LABEL[q.type] ?? q.type}</Badge> {plainText(q.stem).slice(0, 100)}
              </span>
              <span className="tabular-nums">
                {q.pending} to grade · {q.graded} graded
              </span>
            </button>
          </li>
        ))}
      </ul>
      {picked && (
        <GradeQueue
          key={picked.questionId}
          offeringId={offeringId}
          itemId={itemId}
          questionId={picked.questionId}
          points={picked.points}
        />
      )}
    </div>
  );
}

function GradeQueue({
  offeringId,
  itemId,
  questionId,
  points,
}: {
  offeringId: string;
  itemId: string;
  questionId: string;
  points: number;
}) {
  const qc = useQueryClient();
  const [state, setState] = useState<'pending' | 'graded'>('pending');
  const [done, setDone] = useState<Set<string>>(new Set());
  const list = useInfiniteQuery({
    queryKey: assessmentKeys.answers(offeringId, itemId, questionId, state),
    queryFn: ({ pageParam, signal }) =>
      gradingAnswers(offeringId, itemId, { questionId, state }, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const header = list.data?.pages[0]?.question;
  const items = (list.data?.pages.flatMap((p) => p.items) ?? []).filter(
    (x) => state === 'graded' || !done.has(x.attemptId),
  );
  const current = items[0];
  const [score, setScore] = useState('');
  const [fb, setFb] = useState('');
  const scoreRef = useRef<HTMLInputElement>(null);
  // a new answer is on screen: start from its stored grade (if any) and put the cursor in the points box
  const currentId = current?.attemptId;
  const currentScore = current?.score;
  const currentFeedback = current?.feedback;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the id marks "another answer"; the rest is what it starts from
  useEffect(() => {
    setScore(currentScore?.toString() ?? '');
    setFb(currentFeedback ?? '');
    scoreRef.current?.focus();
  }, [currentId, currentScore, currentFeedback]);
  // the queue runs low: fetch the next page before the grader reaches the end
  useEffect(() => {
    if (state === 'pending' && items.length <= 3 && list.hasNextPage && !list.isFetchingNextPage)
      void list.fetchNextPage();
  }, [items.length, list, state]);
  const grade = useMutation({
    mutationFn: () => {
      if (!current) throw new Error('nothing to grade');
      return gradeAnswer(offeringId, current.attemptId, current.position, {
        score: Number(score),
        feedback: fb.trim() || null,
      });
    },
    onSuccess: () => {
      if (current) setDone((d) => new Set(d).add(current.attemptId));
      void qc.invalidateQueries({ queryKey: assessmentKeys.grading(offeringId, itemId) });
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const valid =
    score.trim() !== '' &&
    !Number.isNaN(Number(score)) &&
    Number(score) >= 0 &&
    Number(score) <= points;
  const submit = () => {
    if (valid && !grade.isPending) grade.mutate();
  };
  return (
    <Card title="Grade">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Select
          label="Answers"
          value={state}
          onChange={(e) => setState(e.target.value as 'pending' | 'graded')}
        >
          <option value="pending">Waiting for a grade</option>
          <option value="graded">Already graded (to correct)</option>
        </Select>
        <p className="text-xs text-muted-foreground">
          Type the points and press Ctrl+Enter to save and go to the next answer.
        </p>
      </div>
      {list.isLoading ? (
        <ListSkeleton rows={2} label="Loading answers" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : !current ? (
        <EmptyState
          title={
            state === 'pending'
              ? 'All answers to this question are graded'
              : 'No graded answers yet'
          }
        />
      ) : (
        <div className="space-y-3">
          {header && <RichTextView doc={header.stem} />}
          {header?.type === 'short_answer' && (
            <p className="text-xs">
              Model answers:{' '}
              {((header.key.accepted as string[] | undefined) ?? []).join(', ') || '—'}
            </p>
          )}
          <div className="rounded-md border border-border p-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">{current.learnerName}</p>
            <p className="whitespace-pre-wrap text-sm" data-testid="answer-text">
              {answerText(current.answer)}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
            <label className="block space-y-1 text-sm font-medium">
              Points (0–{points})
              <input
                ref={scoreRef}
                inputMode="decimal"
                value={score}
                onChange={(e) => setScore(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    submit();
                  }
                }}
                className="block min-h-11 w-full rounded-md border border-input bg-surface px-3 text-base sm:min-h-9 sm:text-sm"
              />
            </label>
            <label className="block space-y-1 text-sm font-medium">
              Feedback (optional)
              <input
                value={fb}
                maxLength={5000}
                onChange={(e) => setFb(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    submit();
                  }
                }}
                className="block min-h-11 w-full rounded-md border border-input bg-surface px-3 text-base sm:min-h-9 sm:text-sm"
              />
            </label>
            <Button loading={grade.isPending} disabled={!valid} onClick={submit}>
              {state === 'pending' ? 'Save and next' : 'Update grade'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {items.length}
            {list.hasNextPage ? '+' : ''} {state === 'pending' ? 'left in this queue' : 'shown'}
          </p>
        </div>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ regrade
function RegradeTab({ offeringId, itemId }: { offeringId: string; itemId: string }) {
  const qc = useQueryClient();
  const analysis = useQuery({
    queryKey: assessmentKeys.analysis(offeringId, itemId),
    queryFn: ({ signal }) => getAnalysis(offeringId, itemId, signal),
  });
  const history = useQuery({
    queryKey: assessmentKeys.regrades(offeringId, itemId),
    queryFn: ({ signal }) => listRegrades(offeringId, itemId, signal),
  });
  const [questionId, setQuestionId] = useState('');
  const [action, setAction] = useState<'rekey' | 'drop' | 'credit'>('rekey');
  const [versionId, setVersionId] = useState('');
  const [result, setResult] = useState<RegradeResponse | null>(null);
  const [confirming, setConfirming] = useState(false);
  const q = analysis.data?.questions.find((x) => x.questionId === questionId);
  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      regrade(offeringId, itemId, {
        questionId,
        action,
        ...(action === 'rekey' && versionId ? { toVersionId: versionId } : {}),
        dryRun,
      }),
    onSuccess: (r, dryRun) => {
      setResult(r);
      if (!dryRun) {
        setConfirming(false);
        void qc.invalidateQueries({ queryKey: ['assessment', offeringId, itemId] });
        toast.success(
          r.applied ? `Regraded ${r.affectedAttempts} attempts.` : 'Nothing needed to change.',
        );
      }
    },
    onError: (err) => {
      setConfirming(false);
      toast.error(describeError(err));
    },
  });
  if (analysis.isError && analysis.error instanceof ApiError && analysis.error.status === 403) {
    return <EmptyState title="Only instructors can regrade" />;
  }
  if (analysis.isLoading) return <ListSkeleton rows={3} label="Loading questions" />;
  if (analysis.isError || !analysis.data)
    return <ErrorState error={analysis.error} onRetry={() => void analysis.refetch()} />;
  return (
    <div className="space-y-4">
      <Card title="Re-score finished attempts">
        <p className="mb-3 text-sm text-muted-foreground">
          Fixed a wrong answer key, or want to drop a bad question? Choose it, see what would
          change, then apply. Scores of every attempt that showed the question are recalculated; the
          old and new scores are kept and the change is audited.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Question"
            value={questionId}
            onChange={(e) => {
              setQuestionId(e.target.value);
              setResult(null);
            }}
          >
            <option value="">Choose a question</option>
            {analysis.data.questions.map((x) => (
              <option key={x.questionId} value={x.questionId}>
                {plainText(x.stem).slice(0, 70)}
              </option>
            ))}
          </Select>
          <Select
            label="What to do"
            value={action}
            onChange={(e) => {
              setAction(e.target.value as typeof action);
              setResult(null);
            }}
          >
            <option value="rekey">Score again with a corrected version (same options)</option>
            <option value="drop">Drop the question (it stops counting)</option>
            <option value="credit">Give everybody the points</option>
          </Select>
        </div>
        {action === 'rekey' && questionId && (
          <VersionPicker
            questionId={questionId}
            offeringId={offeringId}
            itemId={itemId}
            value={versionId}
            onChange={(v) => {
              setVersionId(v);
              setResult(null);
            }}
          />
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            loading={run.isPending && run.variables === true}
            disabled={!questionId || (action === 'rekey' && !versionId)}
            onClick={() => run.mutate(true)}
          >
            Show what would change
          </Button>
          <Button
            disabled={!result || result.changedScores === 0}
            onClick={() => setConfirming(true)}
          >
            Apply to {result?.affectedAttempts ?? 0} attempts
          </Button>
        </div>
        {result && (
          <div className="mt-4 space-y-2 text-sm" role="status">
            <p className="font-medium">
              {result.affectedAttempts} attempts show this question; {result.changedScores} would
              change.
              {result.averageBefore != null &&
                ` Average ${result.averageBefore} → ${result.averageAfter}.`}
            </p>
            {result.changes.length > 0 && (
              <table className="w-full text-left">
                <caption className="sr-only">Changes</caption>
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col" className="p-1">
                      Learner
                    </th>
                    <th scope="col" className="p-1">
                      Before
                    </th>
                    <th scope="col" className="p-1">
                      After
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result.changes.map((c) => (
                    <tr key={c.attemptId} className="border-b border-border">
                      <th scope="row" className="p-1 font-normal">
                        {c.learnerName}
                      </th>
                      <td className="p-1 tabular-nums">
                        {c.before} / {c.maxBefore}
                      </td>
                      <td className="p-1 tabular-nums">
                        {c.after} / {c.maxAfter}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        <ConfirmDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          onConfirm={() => run.mutate(false)}
          pending={run.isPending && run.variables === false}
          title={`Regrade “${plainText(q?.stem).slice(0, 50)}”?`}
          description={`${result?.changedScores ?? 0} scores change. Learners who already saw their result will see the new score.`}
          confirmLabel="Apply the regrade"
        />
      </Card>
      <Card title="Regrades so far">
        {history.data && history.data.items.length > 0 ? (
          <ul className="divide-y divide-border text-sm">
            {history.data.items.map((h) => (
              <li key={h.id} className="py-2">
                {new Date(h.createdAt).toLocaleString()} · {h.action} · {h.affectedAttempts}{' '}
                attempts{h.createdByName ? ` · ${h.createdByName}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">None.</p>
        )}
      </Card>
    </div>
  );
}

/** The versions of the chosen question (the bank route needs the course: read it from the assessment configuration). */
function VersionPicker({
  questionId,
  offeringId,
  itemId,
  value,
  onChange,
}: {
  questionId: string;
  offeringId: string;
  itemId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const config = useQuery({
    queryKey: assessmentKeys.config(offeringId, itemId),
    queryFn: ({ signal }) => getConfig(offeringId, itemId, signal),
  });
  const courseId = config.data?.courseId;
  const versions = useQuery({
    queryKey: assessmentKeys.versions(courseId ?? '', questionId),
    queryFn: ({ signal }) => listVersions(courseId as string, questionId, signal),
    enabled: !!courseId,
  });
  return (
    <div className="mt-3">
      <Select label="Score with version" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a version</option>
        {versions.data?.items.map((v) => (
          <option key={v.versionId} value={v.versionId}>
            Version {v.version}
            {v.current ? ' (current)' : ''} · {new Date(v.createdAt).toLocaleDateString()}
          </option>
        ))}
      </Select>
      <p className="mt-1 text-xs text-muted-foreground">
        Edit the question in the bank first (fix the correct option, keep the options), then pick
        the new version here. A version with different options is refused: drop the question or give
        credit instead.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ item analysis
function AnalysisTab({ offeringId, itemId }: { offeringId: string; itemId: string }) {
  const analysis = useQuery({
    queryKey: assessmentKeys.analysis(offeringId, itemId),
    queryFn: ({ signal }) => getAnalysis(offeringId, itemId, signal),
  });
  if (analysis.isError && analysis.error instanceof ApiError && analysis.error.status === 403) {
    return <EmptyState title="Only instructors see the item analysis" />;
  }
  if (analysis.isLoading) return <ListSkeleton rows={4} label="Analysing the attempts" />;
  if (analysis.isError || !analysis.data)
    return <ErrorState error={analysis.error} onRetry={() => void analysis.refetch()} />;
  const a = analysis.data;
  if (a.attempts === 0) return <EmptyState title="No finished attempts yet" />;
  return (
    <div className="space-y-4">
      <Card>
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Finished attempts</dt>
            <dd className="text-xl font-semibold tabular-nums">{a.attempts}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Average score</dt>
            <dd className="text-xl font-semibold tabular-nums">{a.averagePercent ?? '—'}%</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Average time</dt>
            <dd className="text-xl font-semibold tabular-nums">{a.averageMinutes ?? '—'} min</dd>
          </div>
        </dl>
      </Card>
      <ol className="space-y-3">
        {a.questions.map((q, i) => (
          <li key={q.questionId}>
            <Card>
              <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
                <span className="font-semibold">{i + 1}.</span>
                <Badge>{TYPE_LABEL[q.type] ?? q.type}</Badge>
                <span className="tabular-nums">Correct: {q.correctPercent ?? '—'}%</span>
                <span className="tabular-nums">Average: {q.averagePercent ?? '—'}%</span>
                <span className="tabular-nums">
                  Answered: {q.answered} / {q.total}
                </span>
                <span className="tabular-nums">Time: {q.averageSeconds ?? '—'} s</span>
              </div>
              <RichTextView doc={q.stem} />
              {q.options.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm">
                  {q.options.map((o) => (
                    <li key={o.id} className="flex items-center gap-2">
                      <span className="w-24 shrink-0 text-xs tabular-nums">
                        {o.picked} {o.picked === 1 ? 'pick' : 'picks'}
                      </span>
                      <span
                        aria-hidden="true"
                        className="h-2 rounded bg-primary"
                        style={{
                          width: `${q.total > 0 ? Math.max(2, (o.picked / q.total) * 100) : 2}%`,
                          maxWidth: '40%',
                        }}
                      />
                      <span className="min-w-0">
                        {plainText(o.text)}
                        {o.correct ? ' ✓ correct' : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </li>
        ))}
      </ol>
    </div>
  );
}

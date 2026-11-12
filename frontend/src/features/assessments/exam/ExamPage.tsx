import type { AttemptDto } from '@lms/backend/contracts';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../../shared/api/client';
import { describeError } from '../../../shared/api/errors';
import { RichTextView } from '../../../shared/richtext/RichTextView';
import { Button } from '../../../shared/ui/button';
import { Dialog } from '../../../shared/ui/dialog';
import { ErrorState, ListSkeleton } from '../../../shared/ui/states';
import { cn } from '../../../shared/utils/cn';
import {
  assessmentKeys,
  attemptImage,
  readAttempt,
  saveAnswers,
  submitAttempt,
} from '../assessments.api';
import { AnswerQueue, type QuestionState, type SaveStatus } from './answerQueue';
import { clearPaper, loadPaper, savePaper, updateAnswers } from './examCache';
import {
  dueWarning,
  ExamClock,
  formatRemaining,
  spokenRemaining,
  type WarningMinutes,
} from './examClock';
import {
  flaggedPositions,
  navItems,
  type PaperQuestion,
  parseNumber,
  unansweredPositions,
  wordCount,
} from './examState';

// The learner's exam screen (step 9). Light on purpose (students on cheap phones on mobile data): no editor, no
// validators, no charts. The deadline is the server's; the answers go through a durable queue (answerQueue.ts).

type Question = AttemptDto['questions'][number];

const SAVE_TEXT: Record<SaveStatus, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  busy: 'Server busy — retrying',
  offline: 'Offline — answers will sync',
  stopped: 'Not saved — sign in again',
};

export function ExamPage() {
  const { id, attemptId } = useParams({ strict: false }) as { id: string; attemptId: string };
  const navigate = useNavigate();
  const attempt = useQuery({
    queryKey: assessmentKeys.attempt(id, attemptId),
    queryFn: async ({ signal }) => {
      try {
        const data = await readAttempt(id, attemptId, signal);
        if (data.attempt.status === 'in_progress') savePaper(attemptId, data);
        else clearPaper(attemptId);
        return data;
      } catch (err) {
        // the API cannot be reached (a reload on a bad connection): open the paper this browser kept, answers and all
        const kept = err instanceof ApiError && err.status === 0 ? loadPaper(attemptId) : null;
        if (kept) return kept;
        throw err;
      }
    },
    // the paper is read once per visit: the queue owns the answers from then on
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const over = attempt.data && attempt.data.attempt.status !== 'in_progress';
  useEffect(() => {
    if (over)
      void navigate({ to: `/offerings/${id}/attempts/${attemptId}/result` as '/', replace: true });
  }, [over, navigate, id, attemptId]);
  if (attempt.isLoading) return <ListSkeleton rows={5} label="Loading your exam" />;
  if (attempt.isError || !attempt.data) {
    return (
      <ErrorState
        title="Could not open the exam"
        error={attempt.error}
        onRetry={() => void attempt.refetch()}
      />
    );
  }
  if (over) return <ListSkeleton rows={2} label="Opening your result" />;
  return <Exam offeringId={id} attemptId={attemptId} data={attempt.data} />;
}

function Exam({
  offeringId,
  attemptId,
  data,
}: {
  offeringId: string;
  attemptId: string;
  data: AttemptDto;
}) {
  const navigate = useNavigate();
  const questions = data.questions;
  const clock = useMemo(() => {
    const c = new ExamClock();
    c.sync(data.attempt.serverNow, data.attempt.deadlineAt);
    return c;
  }, [data.attempt.serverNow, data.attempt.deadlineAt]);
  const queueRef = useRef<AnswerQueue | null>(null);
  const [state, setState] = useState<Record<number, QuestionState>>(() =>
    Object.fromEntries(
      questions.map((q) => [
        q.position,
        { position: q.position, answer: q.answer, flagged: q.flagged, rev: q.rev },
      ]),
    ),
  );
  const [status, setStatus] = useState<SaveStatus>('saving');
  const [current, setCurrent] = useState(questions[0]?.position ?? 1);
  const [remaining, setRemaining] = useState(() => clock.remainingMs());
  const [warning, setWarning] = useState<WarningMinutes | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitBusy, setSubmitBusy] = useState<{ attempt: number; delayMs: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const enteredAt = useRef(performance.now());
  const shown = useRef(new Set<WarningMinutes>());
  const finished = useRef(false);

  const toResult = useCallback(() => {
    void navigate({
      to: `/offerings/${offeringId}/attempts/${attemptId}/result` as '/',
      replace: true,
    });
  }, [navigate, offeringId, attemptId]);

  // ---- the queue, and what the browser tells us about the page
  useEffect(() => {
    const queue = new AnswerQueue({
      attemptId,
      send: (body, o) => saveAnswers(offeringId, attemptId, body, o),
      onStatus: (s) => {
        setStatus(s);
        // everything is on the server: keep that state for a reload while the server cannot be reached
        if (s === 'saved') updateAnswers(attemptId, queue.snapshot());
      },
      onStale: () => setState(toMap(queue.snapshot())),
      onClosed: () => {
        finished.current = true;
        toResult();
      },
      onClock: (now, deadline) => clock.sync(now, deadline),
    });
    queueRef.current = queue;
    // what this device kept from before a reload is merged with the server's state and sent before "Saved" shows
    setState(
      toMap(
        queue.load(
          questions.map((q) => ({
            position: q.position,
            answer: q.answer,
            flagged: q.flagged,
            rev: q.rev,
          })),
        ),
      ),
    );
    queue.event('resume');
    const onVisibility = () => {
      queue.event(document.hidden ? 'hidden' : 'visible');
      if (document.hidden) void queue.flushNow({ keepalive: true });
    };
    const onHide = () => void queue.flushNow({ keepalive: true });
    const onOnline = () => {
      queue.event('online');
      queue.retryNow();
    };
    const onOffline = () => queue.event('offline');
    const onBlur = () => queue.event('blur');
    const onFocus = () => queue.event('focus');
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      queue.dispose();
    };
  }, [attemptId, offeringId, questions, clock, toResult]);

  // ---- the countdown (the deadline is the server's) and the warnings at 10 / 5 / 1 minute
  const finish = useCallback(
    async (timeIsUp: boolean) => {
      const queue = queueRef.current;
      if (!queue || finished.current) return;
      setSubmitting(true);
      setProblem(null);
      try {
        await queue.flushNow();
        const r = await submitAttempt(offeringId, attemptId, { onBusy: setSubmitBusy });
        finished.current = true;
        queue.discard();
        clearPaper(attemptId);
        void r;
        toResult();
      } catch (err) {
        setProblem(
          timeIsUp
            ? 'Time is up. Your answers are saved up to the last sync, and the exam is closed for you on the server within a minute. You can leave this page.'
            : `${describeError(err)} Your answers are safe: try again.`,
        );
        setSubmitting(false);
      }
    },
    [offeringId, attemptId, toResult],
  );
  useEffect(() => {
    const tick = window.setInterval(() => {
      const left = clock.remainingMs();
      setRemaining(left);
      const w = dueWarning(left, shown.current);
      if (w) setWarning(w);
      if (left <= 0 && !finished.current) void finish(true);
    }, 1000);
    return () => window.clearInterval(tick);
  }, [clock, finish]);

  // ---- navigation: leaving a question saves at once and counts the time spent on it
  const goTo = (position: number) => {
    const queue = queueRef.current;
    if (queue) {
      queue.addSpent(current, performance.now() - enteredAt.current);
      void queue.flushNow();
    }
    enteredAt.current = performance.now();
    setCurrent(position);
    document.getElementById('question-heading')?.focus();
  };
  const change = (
    position: number,
    patch: { answer?: QuestionState['answer']; flagged?: boolean },
  ) => {
    queueRef.current?.set(position, patch);
    setState(toMap(queueRef.current?.snapshot() ?? []));
  };

  const paper: PaperQuestion[] = questions.map((q) => ({
    position: q.position,
    type: q.type,
    answer: state[q.position]?.answer ?? null,
    flagged: state[q.position]?.flagged ?? false,
  }));
  const index = Math.max(
    0,
    questions.findIndex((q) => q.position === current),
  );
  const q = questions[index] as Question;
  const st = state[q.position];
  const unanswered = unansweredPositions(paper);
  const flagged = flaggedPositions(paper);

  return (
    <div className="space-y-4 pb-24">
      <header className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background px-4 py-2">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{data.attempt.title}</h1>
          <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
            {SAVE_TEXT[status]}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div
            role="timer"
            aria-label={spokenRemaining(remaining)}
            className={cn(
              'rounded-md border px-3 py-1 text-lg font-semibold tabular-nums',
              remaining <= 60_000 ? 'border-danger text-danger' : 'border-border',
            )}
          >
            {formatRemaining(remaining)}
          </div>
          <Button onClick={() => setConfirming(true)} disabled={submitting}>
            Submit
          </Button>
        </div>
      </header>

      {warning && (
        <p role="alert" className="rounded-md border border-warning p-3 text-sm font-medium">
          {warning} {warning === 1 ? 'minute' : 'minutes'} left. Your answers are saved as you go;
          submit when you are done.
        </p>
      )}
      {(status === 'busy' || submitBusy) && (
        <p
          role="status"
          className="rounded-md border border-warning p-3 text-sm"
          data-testid="busy"
        >
          Server busy — retrying, your submission time is protected. Keep this page open: the
          answers you had already given count from the moment they reached the server, not from the
          moment they were finally accepted. An answer you change or add while this message is shown
          is sent afterwards and counts from the moment it is sent.
        </p>
      )}
      {status === 'offline' && (
        <p role="alert" className="rounded-md border border-warning p-3 text-sm">
          You are offline. Keep answering: your answers are kept on this device and are sent when
          the connection returns.
        </p>
      )}
      {problem && (
        <p role="alert" className="rounded-md border border-danger p-3 text-sm">
          {problem}
        </p>
      )}

      <nav aria-label="Questions" className="flex gap-2 overflow-x-auto pb-1">
        {navItems(paper, current).map((n) => (
          <button
            key={n.position}
            type="button"
            aria-label={n.label}
            aria-current={n.current ? 'step' : undefined}
            onClick={() => goTo(n.position)}
            className={cn(
              'relative inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md border text-sm font-medium sm:min-h-9 sm:min-w-9',
              n.current ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
              n.status === 'answered' && !n.current && 'bg-muted',
            )}
          >
            {n.position}
            {n.flagged && (
              <span aria-hidden="true" className="absolute -right-1 -top-1 text-xs">
                ⚑
              </span>
            )}
          </button>
        ))}
      </nav>

      <section
        aria-labelledby="question-heading"
        className="space-y-4 rounded-md border border-border bg-surface p-4"
      >
        <h2
          id="question-heading"
          tabIndex={-1}
          className="text-sm font-semibold text-muted-foreground"
        >
          Question {q.position} of {questions.length} · {q.points}{' '}
          {q.points === 1 ? 'point' : 'points'}
        </h2>
        <RichTextView doc={q.stem} />
        {q.images.map((img) => (
          <QuestionImage
            key={img.fileId}
            offeringId={offeringId}
            attemptId={attemptId}
            fileId={img.fileId}
            alt={img.alt}
          />
        ))}
        <AnswerInput
          key={q.position}
          question={q}
          answer={st?.answer ?? null}
          onChange={(answer) => change(q.position, { answer })}
        />
        <div className="flex items-center justify-between gap-3">
          <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-9">
            <input
              type="checkbox"
              checked={st?.flagged ?? false}
              onChange={(e) => change(q.position, { flagged: e.target.checked })}
              className="size-5"
            />
            Flag for review
          </label>
          {st?.answer && (
            <Button variant="ghost" onClick={() => change(q.position, { answer: null })}>
              Clear answer
            </Button>
          )}
        </div>
      </section>

      <div className="fixed inset-x-0 bottom-0 z-10 flex justify-between gap-2 border-t border-border bg-background p-3">
        <Button
          variant="secondary"
          disabled={index === 0}
          onClick={() => goTo((questions[index - 1] as Question).position)}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          disabled={index === questions.length - 1}
          onClick={() => goTo((questions[index + 1] as Question).position)}
        >
          Next
        </Button>
      </div>

      <Dialog open={confirming} onClose={() => setConfirming(false)} title="Submit your answers?">
        <div className="space-y-3 text-sm">
          {unanswered.length === 0 ? (
            <p>You answered every question.</p>
          ) : (
            <div>
              <p className="font-medium">
                {unanswered.length} {unanswered.length === 1 ? 'question is' : 'questions are'} not
                answered:
              </p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {unanswered.map((p) => (
                  <li key={p}>
                    <button
                      type="button"
                      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-input px-2 underline sm:min-h-9"
                      onClick={() => {
                        setConfirming(false);
                        goTo(p);
                      }}
                    >
                      Question {p}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {flagged.length > 0 && (
            <p>Flagged for review: {flagged.map((p) => `Question ${p}`).join(', ')}.</p>
          )}
          <p className="text-muted-foreground">After you submit you cannot change your answers.</p>
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            Keep working
          </Button>
          <Button
            loading={submitting}
            onClick={() => {
              setConfirming(false);
              void finish(false);
            }}
          >
            Submit now
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

const toMap = (states: QuestionState[]): Record<number, QuestionState> =>
  Object.fromEntries(states.map((s) => [s.position, s]));

function AnswerInput({
  question: q,
  answer,
  onChange,
}: {
  question: Question;
  answer: QuestionState['answer'];
  onChange: (a: QuestionState['answer']) => void;
}) {
  const chosen = new Set(answer?.o ?? []);
  if (q.type === 'single_choice' || q.type === 'true_false' || q.type === 'multiple_choice') {
    const multi = q.type === 'multiple_choice';
    return (
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">
          {multi ? 'Choose all that apply' : 'Choose one'}
        </legend>
        {q.options.map((o) => (
          <label
            key={o.id}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-input p-3 has-[:checked]:border-primary has-[:checked]:bg-muted"
          >
            <input
              type={multi ? 'checkbox' : 'radio'}
              name={`q-${q.position}`}
              checked={chosen.has(o.id)}
              onChange={(e) => {
                const next = multi ? new Set(chosen) : new Set<string>();
                if (e.target.checked) next.add(o.id);
                else next.delete(o.id);
                onChange(next.size === 0 ? null : { o: [...next] });
              }}
              className="mt-1 size-5"
            />
            <span className="min-w-0">
              <RichTextView doc={o.text} />
            </span>
          </label>
        ))}
      </fieldset>
    );
  }
  if (q.type === 'numeric') return <NumericInput answer={answer} onChange={onChange} />;
  if (q.type === 'short_answer') {
    return (
      <label className="block space-y-1 text-sm font-medium">
        Your answer
        <input
          type="text"
          defaultValue={answer?.t ?? ''}
          maxLength={500}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value.trim() === '' ? null : { t: e.target.value })}
          className="block min-h-11 w-full rounded-md border border-input bg-surface px-3 text-base sm:min-h-9 sm:text-sm"
        />
      </label>
    );
  }
  return <EssayInput maxWords={q.maxWords} answer={answer} onChange={onChange} />;
}

function NumericInput({
  answer,
  onChange,
}: {
  answer: QuestionState['answer'];
  onChange: (a: QuestionState['answer']) => void;
}) {
  const [text, setText] = useState(answer?.n !== undefined ? String(answer.n) : '');
  const bad = text.trim() !== '' && parseNumber(text) === null;
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium" htmlFor="numeric-answer">
        Your answer (a number)
      </label>
      <input
        id="numeric-answer"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={text}
        aria-invalid={bad || undefined}
        aria-describedby={bad ? 'numeric-error' : undefined}
        onChange={(e) => {
          setText(e.target.value);
          const n = parseNumber(e.target.value);
          if (e.target.value.trim() === '') onChange(null);
          else if (n !== null) onChange({ n });
        }}
        className="block min-h-11 w-full max-w-xs rounded-md border border-input bg-surface px-3 text-base aria-[invalid=true]:border-danger sm:min-h-9 sm:text-sm"
      />
      {bad && (
        <p id="numeric-error" role="alert" className="text-xs text-danger">
          Enter a number such as 12 or 3.5.
        </p>
      )}
    </div>
  );
}

function EssayInput({
  maxWords,
  answer,
  onChange,
}: {
  maxWords: number | null;
  answer: QuestionState['answer'];
  onChange: (a: QuestionState['answer']) => void;
}) {
  const [text, setText] = useState(answer?.t ?? '');
  const words = wordCount(text);
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium" htmlFor="essay-answer">
        Your answer
      </label>
      <textarea
        id="essay-answer"
        rows={10}
        maxLength={20000}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value.trim() === '' ? null : { t: e.target.value });
        }}
        className="block w-full rounded-md border border-input bg-surface p-3 text-base sm:text-sm"
      />
      <p className="text-xs text-muted-foreground">
        {words} {words === 1 ? 'word' : 'words'}
        {maxWords ? ` · about ${maxWords} expected` : ''}
      </p>
    </div>
  );
}

function QuestionImage({
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
  if (target.isError)
    return <p className="text-sm text-muted-foreground">Image unavailable: {alt}</p>;
  if (!target.data)
    return (
      <div className="h-32 w-full max-w-md animate-pulse rounded-md bg-muted" aria-hidden="true" />
    );
  return (
    <img
      src={target.data.url}
      alt={alt}
      loading="lazy"
      className="max-h-96 max-w-full rounded-md border border-border"
    />
  );
}

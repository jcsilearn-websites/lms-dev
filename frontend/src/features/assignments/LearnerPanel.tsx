import type {
  GradeInput,
  GradeSaved,
  GradingLearner,
  GradingRow,
  RubricCriterion,
} from '@lms/backend/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { RichTextView } from '../../shared/richtext/RichTextView';
import { Button } from '../../shared/ui/button';
import { Dialog } from '../../shared/ui/dialog';
import { INPUT_CLASS } from '../../shared/ui/field';
import { Badge, Card } from '../../shared/ui/layout';
import { ErrorState, ListSkeleton, Skeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { loadEditor } from '../courses/editor/loadEditor';
import {
  assignmentKeys,
  getLearner,
  releaseGrades,
  restorePenalty,
  saveGrade,
  waivePenalty,
} from './assignments.api';
import { FilePreview } from './FilePreview';
import { duration, points, stamp } from './format';

const RichTextEditor = lazy(loadEditor);

// The right-hand side of the grading screen: one learner. Identity is shown only when the server sends it (blind grading
// sends none). Versions with their files, the rubric (or a score), the late penalty (raw, penalty, final), the feedback.

type Selection = Record<string, { levelId: string; comment?: string }>;

export function LearnerPanel({
  offeringId,
  itemId,
  rowKey,
  onGraded,
  onReleased,
}: {
  offeringId: string;
  itemId: string;
  rowKey: string;
  onGraded: (key: string, g: GradeSaved) => void;
  onReleased: (key: string) => void;
}) {
  const q = useQuery({
    queryKey: assignmentKeys.learner(offeringId, itemId, rowKey),
    queryFn: ({ signal }) => getLearner(offeringId, itemId, rowKey, signal),
  });
  if (q.isLoading) return <ListSkeleton rows={5} label="Loading the learner" />;
  if (q.isError || !q.data)
    return (
      <ErrorState
        title="Could not open this learner"
        error={q.error}
        onRetry={() => void q.refetch()}
      />
    );
  return (
    <Panel
      key={`${rowKey}-${q.data.submissions[0]?.id ?? 'none'}-${q.data.grade?.gradedAt ?? 'new'}`}
      offeringId={offeringId}
      itemId={itemId}
      rowKey={rowKey}
      data={q.data}
      onGraded={onGraded}
      onReleased={onReleased}
    />
  );
}

function Panel({
  offeringId,
  itemId,
  rowKey,
  data,
  onGraded,
  onReleased,
}: {
  offeringId: string;
  itemId: string;
  rowKey: string;
  data: GradingLearner;
  onGraded: (key: string, g: GradeSaved) => void;
  onReleased: (key: string) => void;
}) {
  const qc = useQueryClient();
  const latest = data.submissions[0];
  const [shown, setShown] = useState(latest?.id ?? '');
  const version = data.submissions.find((s) => s.id === shown) ?? latest;
  const rubric = data.rubric;
  const g = data.grade;
  const [sel, setSel] = useState<Selection>(() => (g?.rubricSelection as Selection | null) ?? {});
  const [override, setOverride] = useState(
    () => g?.rubricScore != null && g.rawScore !== g.rubricScore,
  );
  const [score, setScore] = useState(() => (g ? String(g.rawScore) : ''));
  const [reason, setReason] = useState(g?.overrideReason ?? '');
  const [feedback, setFeedback] = useState<unknown>(g?.feedback ?? null);
  const [feedbackTouched, setFeedbackTouched] = useState(false);
  const [waiving, setWaiving] = useState(false);
  const [waiveReason, setWaiveReason] = useState('');

  useEffect(() => setShown(latest?.id ?? ''), [latest?.id]);

  const rubricScore = rubric
    ? rubric.criteria.reduce((sum, c) => {
        const l = c.levels.find((x) => x.id === sel[c.id]?.levelId);
        return sum + (l?.points ?? 0);
      }, 0)
    : null;
  const complete = !rubric || rubric.criteria.every((c) => sel[c.id]?.levelId);
  const raw = rubric ? (override ? Number(score) : (rubricScore as number)) : Number(score);
  const penaltyPct = g ? g.penaltyPercent : data.penaltyPercent;
  const penaltyPts = (data.maxPoints * penaltyPct) / 100;
  const finalScore = Math.max(0, Math.round((raw - penaltyPts) * 100) / 100);
  const waived = g?.penaltyWaived === true;

  const save = useMutation({
    mutationFn: () => {
      const body: GradeInput = {
        submissionId: latest?.id as string,
        ...(rubric ? { rubricSelection: sel } : {}),
        ...(!rubric || override ? { rawScore: Number(score) } : {}),
        ...(override && reason.trim() ? { overrideReason: reason.trim() } : {}),
        ...(feedbackTouched ? { feedback: feedback as GradeInput['feedback'] } : {}),
      };
      return saveGrade(offeringId, itemId, rowKey, body);
    },
    onSuccess: (r) => {
      toast.success('Grade saved.');
      onGraded(rowKey, r);
      void qc.invalidateQueries({ queryKey: assignmentKeys.learner(offeringId, itemId, rowKey) });
      void qc.invalidateQueries({ queryKey: assignmentKeys.summary(offeringId, itemId) });
    },
    onError: (err) => {
      toast.error(describeError(err));
      void qc.invalidateQueries({ queryKey: assignmentKeys.learner(offeringId, itemId, rowKey) });
    },
  });
  const waive = useMutation({
    mutationFn: () => waivePenalty(offeringId, itemId, rowKey, waiveReason.trim()),
    onSuccess: () => {
      setWaiving(false);
      setWaiveReason('');
      toast.success('The late penalty is waived.');
      void qc.invalidateQueries({ queryKey: assignmentKeys.learner(offeringId, itemId, rowKey) });
      void qc.invalidateQueries({ queryKey: assignmentKeys.queueAll(offeringId, itemId) });
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const restore = useMutation({
    mutationFn: () => restorePenalty(offeringId, itemId, rowKey),
    onSuccess: () => {
      toast.success('The late penalty is charged again.');
      void qc.invalidateQueries({ queryKey: assignmentKeys.learner(offeringId, itemId, rowKey) });
      void qc.invalidateQueries({ queryKey: assignmentKeys.queueAll(offeringId, itemId) });
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const release = useMutation({
    mutationFn: () => releaseGrades(offeringId, itemId, [rowKey]),
    onSuccess: (r) => {
      toast.success(
        r.released > 0
          ? 'Grade released to the learner.'
          : 'Nothing to release: grade the latest version first.',
      );
      onReleased(rowKey);
      void qc.invalidateQueries({ queryKey: assignmentKeys.learner(offeringId, itemId, rowKey) });
    },
    onError: (err) => toast.error(describeError(err)),
  });

  if (!latest) {
    return (
      <Card title={data.name ?? `Learner ${data.anonCode}`}>
        <p className="text-sm text-muted-foreground">
          This learner has not handed in anything yet.
        </p>
      </Card>
    );
  }
  const outdated = g != null && g.submissionId !== latest.id;
  const scoreValid =
    Number.isFinite(raw) &&
    raw >= 0 &&
    raw <= data.maxPoints &&
    (!override || reason.trim() !== '' || rubric == null) &&
    (!rubric || override || complete);
  const canSave =
    (rubric ? complete : score !== '') && scoreValid && (!override || reason.trim() !== '');
  const heading =
    data.blind && data.name == null
      ? `Learner ${data.anonCode}`
      : (data.name ?? `Learner ${data.anonCode}`);

  return (
    <div className="space-y-4" data-testid="learner-panel">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold" data-testid="learner-heading">
              {heading}
            </h2>
            <p className="text-sm text-muted-foreground">
              {data.name != null ? (
                <>
                  {data.registerNumber ?? 'no register number'} · {data.email}
                </>
              ) : (
                <>
                  Grading is blind: name and register number are hidden until the grade is released.
                </>
              )}
            </p>
          </div>
          {g?.releasedAt ? (
            <Badge tone="success">Released</Badge>
          ) : g ? (
            <Badge>Graded, not released</Badge>
          ) : (
            <Badge>Not graded</Badge>
          )}
        </div>
        {outdated && (
          <p role="status" className="mt-3 rounded-md border border-warning p-2 text-sm">
            The learner handed in a newer version after this grade. Grade version {latest.versionNo}{' '}
            to replace it.
          </p>
        )}
      </Card>

      <Card title="Submission">
        <div className="mb-3 flex flex-wrap gap-2" role="tablist" aria-label="Versions">
          {data.submissions.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === version?.id}
              onClick={() => setShown(s.id)}
              className="min-h-11 rounded-md border border-input px-3 text-sm aria-selected:bg-primary aria-selected:text-primary-foreground sm:min-h-9"
            >
              Version {s.versionNo}
              {s.id === latest.id ? ' (latest)' : ''}
            </button>
          ))}
        </div>
        {version && (
          <div className="space-y-3 text-sm">
            <p>
              Handed in {stamp(version.submittedAt)}.{' '}
              {version.lateSeconds > 0 ? (
                <Badge tone="warning">
                  Late by {duration(version.lateSeconds)}: {version.penaltyPercent}% penalty
                </Badge>
              ) : version.onGrace ? (
                <Badge>On time (upload began before the due date)</Badge>
              ) : (
                <Badge tone="success">On time</Badge>
              )}
            </p>
            {version.text && (
              <p className="whitespace-pre-wrap rounded-md bg-muted p-3">{version.text}</p>
            )}
            {version.link && (
              <p>
                Link:{' '}
                <a
                  href={version.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  {version.link}
                </a>
              </p>
            )}
            {version.files.map((f) => (
              <FilePreview key={f.fileId} offeringId={offeringId} itemId={itemId} file={f} />
            ))}
          </div>
        )}
      </Card>

      <Card title="Grade">
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) save.mutate();
          }}
        >
          {rubric ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Rubric: {rubric.title}. Choose one level for every criterion.
              </p>
              {rubric.criteria.map((c) => (
                <CriterionPicker
                  key={c.id}
                  c={c}
                  value={sel[c.id]}
                  onChange={(v) => setSel((x) => ({ ...x, [c.id]: v }))}
                />
              ))}
              <p className="text-sm" data-testid="rubric-score">
                Rubric score: <strong>{rubricScore}</strong> / {rubric.maxPoints}
              </p>
              <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={override}
                  onChange={(e) => setOverride(e.target.checked)}
                />
                Give a different score than the rubric
              </label>
            </div>
          ) : null}
          {(!rubric || override) && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="g-score" className="block text-sm font-medium">
                  Score (0 to {data.maxPoints})
                </label>
                <input
                  id="g-score"
                  inputMode="decimal"
                  value={score}
                  onChange={(e) => setScore(e.target.value)}
                  className={INPUT_CLASS}
                />
              </div>
              {override && (
                <div>
                  <label htmlFor="g-reason" className="block text-sm font-medium">
                    Why this score (required)
                  </label>
                  <input
                    id="g-reason"
                    maxLength={500}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className={INPUT_CLASS}
                  />
                </div>
              )}
            </div>
          )}

          <dl
            className="grid gap-x-6 gap-y-1 rounded-md bg-muted p-3 text-sm sm:grid-cols-3"
            data-testid="score-breakdown"
          >
            <div>
              <dt className="text-muted-foreground">Score</dt>
              <dd className="font-medium">
                {Number.isFinite(raw) ? raw : '—'} / {data.maxPoints}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Late penalty</dt>
              <dd className="font-medium" data-testid="penalty">
                {waived
                  ? 'waived'
                  : penaltyPts > 0
                    ? `− ${points(penaltyPts)} (${penaltyPct}%)`
                    : 'none'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Final</dt>
              <dd className="font-semibold">
                {Number.isFinite(raw) ? (waived ? raw : finalScore) : '—'} / {data.maxPoints}
              </dd>
            </div>
          </dl>

          <div className="space-y-1">
            <p className="text-sm font-medium">Feedback for the learner</p>
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <RichTextEditor
                label="Feedback"
                value={g?.feedback ?? null}
                onChange={(d) => {
                  setFeedbackTouched(true);
                  setFeedback(d);
                }}
              />
            </Suspense>
            {g?.feedback && !feedbackTouched && (
              <details className="text-xs text-muted-foreground">
                <summary>Saved feedback as the learner sees it</summary>
                <RichTextView doc={g.feedback} />
              </details>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              {g && data.penaltyPercent > 0 && !waived && (
                <Button variant="secondary" onClick={() => setWaiving(true)}>
                  Waive the late penalty
                </Button>
              )}
              {waived && (
                <Button
                  variant="secondary"
                  onClick={() => restore.mutate()}
                  loading={restore.isPending}
                >
                  Charge the late penalty again
                </Button>
              )}
              {g && !g.releasedAt && !outdated && (
                <Button
                  variant="secondary"
                  onClick={() => release.mutate()}
                  loading={release.isPending}
                >
                  Release this grade
                </Button>
              )}
            </div>
            <Button type="submit" loading={save.isPending} disabled={!canSave}>
              Save grade
            </Button>
          </div>
        </form>
      </Card>

      <Dialog open={waiving} onClose={() => setWaiving(false)} title="Waive the late penalty?">
        <div className="space-y-3 text-sm">
          <p>
            The learner will not lose {points(penaltyPts)} for handing in late. The reason is kept
            in the audit log.
          </p>
          <div>
            <label htmlFor="waive-reason" className="block font-medium">
              Reason
            </label>
            <input
              id="waive-reason"
              value={waiveReason}
              maxLength={500}
              onChange={(e) => setWaiveReason(e.target.value)}
              className={INPUT_CLASS}
            />
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              onClick={() => setWaiving(false)}
              disabled={waive.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => waive.mutate()}
              loading={waive.isPending}
              disabled={waiveReason.trim().length < 3}
            >
              Waive the penalty
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function CriterionPicker({
  c,
  value,
  onChange,
}: {
  c: RubricCriterion;
  value: { levelId: string; comment?: string } | undefined;
  onChange: (v: { levelId: string; comment?: string }) => void;
}) {
  return (
    <fieldset className="space-y-2 rounded-md border border-border p-3">
      <legend className="px-1 text-sm font-semibold">{c.title}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {c.levels.map((l) => {
          const id = `${c.id}-${l.id}`;
          return (
            <label
              key={l.id}
              htmlFor={id}
              className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-input px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-muted"
            >
              <input
                id={id}
                type="radio"
                name={c.id}
                className="size-5"
                checked={value?.levelId === l.id}
                onChange={() =>
                  onChange({ levelId: l.id, ...(value?.comment ? { comment: value.comment } : {}) })
                }
              />
              <span>
                {l.title} <span className="text-muted-foreground">({l.points})</span>
              </span>
            </label>
          );
        })}
      </div>
      <input
        aria-label={`Comment on ${c.title}`}
        placeholder="Comment (optional)"
        maxLength={1000}
        value={value?.comment ?? ''}
        disabled={!value}
        onChange={(e) => value && onChange({ levelId: value.levelId, comment: e.target.value })}
        className={INPUT_CLASS}
      />
    </fieldset>
  );
}

export type { GradingRow };

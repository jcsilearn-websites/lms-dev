import type { AssessmentConfig, AssessmentSettings } from '@lms/backend/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ApiError } from '../../../shared/api/client';
import { describeError } from '../../../shared/api/errors';
import { plainText, RichTextView } from '../../../shared/richtext/RichTextView';
import { Button } from '../../../shared/ui/button';
import { ConfirmDialog, Dialog } from '../../../shared/ui/dialog';
import { Field } from '../../../shared/ui/field';
import { Badge, Card, PageHeader } from '../../../shared/ui/layout';
import { Select } from '../../../shared/ui/select';
import { EmptyState, ErrorState, ListSkeleton } from '../../../shared/ui/states';
import { toast } from '../../../shared/ui/toast';
import { toLocalInput } from '../../../shared/utils/datetime';
import { courseKeys, listParticipants } from '../../courses/courses.api';
import {
  type AccommodationRow,
  assessmentKeys,
  deleteAccommodation,
  getConfig,
  listAccommodations,
  listQuestions,
  listTags,
  previewPaper,
  putAccommodation,
  replaceSlots,
  type SlotInput,
  updateSettings,
} from '../assessments.api';
import { TYPE_LABEL } from '../labels';

// The assessment builder (instructors): settings, the questions (fixed ones and random pools), a preview of a sample
// paper as a learner gets it, and the accommodations (extra time, a later close date) of individual learners.

const fromLocal = (v: string): string | null => (v ? new Date(v).toISOString() : null);

export function AssessmentBuilderPage() {
  const { id, itemId } = useParams({ strict: false }) as { id: string; itemId: string };
  const config = useQuery({
    queryKey: assessmentKeys.config(id, itemId),
    queryFn: ({ signal }) => getConfig(id, itemId, signal),
  });
  if (config.isLoading) return <ListSkeleton rows={6} label="Loading the assessment" />;
  if (config.isError || !config.data) {
    return (
      <ErrorState
        title="Could not open the assessment"
        error={config.error}
        onRetry={() => void config.refetch()}
      />
    );
  }
  const c = config.data;
  return (
    <div className="space-y-6">
      <Link to={`/offerings/${id}/build` as '/'} className="text-sm text-primary underline">
        ← Back to the course content
      </Link>
      <PageHeader
        title={c.title}
        description={`${c.questionCount} questions · ${c.totalPoints} points · ${c.attemptsStarted} attempts so far`}
        actions={
          <>
            <Link
              to={`/offerings/${id}/items/${itemId}/grading` as '/'}
              className="inline-flex min-h-11 items-center rounded-md border border-input px-4 text-sm hover:bg-muted sm:min-h-9"
            >
              Grading and results
            </Link>
            <Link
              to={`/courses/${c.courseId}/questions` as '/'}
              className="inline-flex min-h-11 items-center rounded-md border border-input px-4 text-sm hover:bg-muted sm:min-h-9"
            >
              Question bank
            </Link>
          </>
        }
      />
      {!c.published && (
        <Badge tone="warning">Hidden from learners: publish the item in the course content</Badge>
      )}
      {c.attemptsStarted > 0 && (
        <p className="rounded-md border border-border p-3 text-sm">
          Learners have started attempts. Changes to the questions affect only attempts started from
          now on; what an attempt already showed never changes. To re-score finished attempts use
          "Regrade" under grading.
        </p>
      )}
      <SettingsCard offeringId={id} itemId={itemId} config={c} />
      <QuestionsCard offeringId={id} itemId={itemId} config={c} />
      <AccommodationsCard offeringId={id} itemId={itemId} />
    </div>
  );
}

// ------------------------------------------------------------------ settings
function SettingsCard({
  offeringId,
  itemId,
  config,
}: {
  offeringId: string;
  itemId: string;
  config: AssessmentConfig;
}) {
  const qc = useQueryClient();
  const s = config.settings;
  const [f, setF] = useState(() => ({
    kind: s.kind,
    opensAt: toLocalInput(s.opensAt),
    closesAt: toLocalInput(s.closesAt),
    timeLimit: s.timeLimitMinutes?.toString() ?? '',
    attempts: String(s.attemptsAllowed),
    scoring: s.scoring,
    shuffleQuestions: s.shuffleQuestions,
    shuffleOptions: s.shuffleOptions,
    passing: s.passingScore?.toString() ?? '',
    results: s.resultsVisibility,
    answers: s.answersVisibility,
  }));
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const body: Partial<AssessmentSettings> = {
        kind: f.kind,
        opensAt: fromLocal(f.opensAt),
        closesAt: fromLocal(f.closesAt),
        timeLimitMinutes: f.timeLimit ? Number(f.timeLimit) : null,
        attemptsAllowed: Number(f.attempts),
        scoring: f.scoring,
        shuffleQuestions: f.shuffleQuestions,
        shuffleOptions: f.shuffleOptions,
        passingScore: f.passing ? Number(f.passing) : null,
        resultsVisibility: f.results,
        answersVisibility: f.answers,
      };
      return updateSettings(offeringId, itemId, body);
    },
    onSuccess: (saved) => {
      qc.setQueryData<AssessmentConfig>(assessmentKeys.config(offeringId, itemId), (old) =>
        old ? { ...old, settings: saved } : old,
      );
      toast.success('Settings saved.');
    },
    onError: (err) => toast.error(describeError(err)),
  });
  return (
    <Card title="Settings">
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Kind"
            value={f.kind}
            onChange={(e) => set('kind', e.target.value as typeof f.kind)}
          >
            <option value="practice">Practice quiz</option>
            <option value="exam">Graded exam</option>
          </Select>
          <Field
            label="Time limit in minutes (empty: none of its own)"
            inputMode="numeric"
            value={f.timeLimit}
            onChange={(e) => set('timeLimit', e.target.value.replace(/\D/g, ''))}
          />
          <Field
            label="Opens (optional)"
            type="datetime-local"
            value={f.opensAt}
            onChange={(e) => set('opensAt', e.target.value)}
          />
          <Field
            label="Closes (optional)"
            type="datetime-local"
            value={f.closesAt}
            onChange={(e) => set('closesAt', e.target.value)}
            hint="An attempt always ends by the close time; with neither a limit nor a close date it ends after 24 hours."
          />
          <Field
            label="Attempts allowed"
            inputMode="numeric"
            value={f.attempts}
            onChange={(e) => set('attempts', e.target.value.replace(/\D/g, ''))}
          />
          <Select
            label="Which attempt counts"
            value={f.scoring}
            onChange={(e) => set('scoring', e.target.value as typeof f.scoring)}
          >
            <option value="highest">The highest</option>
            <option value="latest">The latest</option>
            <option value="average">The average</option>
          </Select>
          <Field
            label="Passing score (% of the maximum, optional)"
            inputMode="decimal"
            value={f.passing}
            onChange={(e) => set('passing', e.target.value)}
          />
          <div className="space-y-2">
            <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-9">
              <input
                type="checkbox"
                className="size-5"
                checked={f.shuffleQuestions}
                onChange={(e) => set('shuffleQuestions', e.target.checked)}
              />
              Shuffle the questions
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-9">
              <input
                type="checkbox"
                className="size-5"
                checked={f.shuffleOptions}
                onChange={(e) => set('shuffleOptions', e.target.checked)}
              />
              Shuffle the options
            </label>
          </div>
          <Select
            label="Learners see their results"
            value={f.results}
            onChange={(e) => set('results', e.target.value as typeof f.results)}
          >
            <option value="immediate">Immediately</option>
            <option value="after_close">After the assessment closes</option>
            <option value="manual">When I release them</option>
          </Select>
          <Select
            label="Learners see the correct answers"
            value={f.answers}
            onChange={(e) => set('answers', e.target.value as typeof f.answers)}
          >
            <option value="never">Never</option>
            <option value="after_close">After the assessment closes</option>
            <option value="after_release">After I release the results</option>
          </Select>
        </div>
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending}>
            Save settings
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------ questions
interface SlotDraft {
  key: string;
  kind: 'fixed' | 'pool';
  questionId?: string;
  summary?: string;
  type?: string;
  tag: string;
  difficulty: '' | 'easy' | 'medium' | 'hard';
  count: string;
  points: string;
  available: number | null;
}

const draftsOf = (c: AssessmentConfig): SlotDraft[] =>
  c.slots.map((s) => ({
    key: `${s.position}-${s.questionId ?? 'pool'}`,
    kind: s.kind,
    ...(s.questionId ? { questionId: s.questionId } : {}),
    ...(s.question
      ? { summary: plainText(s.question.stem).slice(0, 120), type: s.question.type }
      : {}),
    tag: s.tag ?? '',
    difficulty: s.difficulty ?? '',
    count: String(s.count),
    points: String(s.points),
    available: s.available,
  }));

function QuestionsCard({
  offeringId,
  itemId,
  config,
}: {
  offeringId: string;
  itemId: string;
  config: AssessmentConfig;
}) {
  const qc = useQueryClient();
  const [slots, setSlots] = useState<SlotDraft[]>(() => draftsOf(config));
  const [picker, setPicker] = useState(false);
  const [preview, setPreview] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setSlots(draftsOf(config));
  }, [config, dirty]);
  const tags = useQuery({
    queryKey: assessmentKeys.tags(config.courseId),
    queryFn: ({ signal }) => listTags(config.courseId, signal),
  });
  const change = (next: SlotDraft[]) => {
    setSlots(next);
    setDirty(true);
  };
  const save = useMutation({
    mutationFn: () => {
      const body: SlotInput[] = slots.map((s) =>
        s.kind === 'fixed'
          ? { kind: 'fixed', questionId: s.questionId as string, points: Number(s.points) }
          : {
              kind: 'pool',
              ...(s.tag ? { tag: s.tag } : {}),
              ...(s.difficulty ? { difficulty: s.difficulty } : {}),
              count: Number(s.count) || 1,
              points: Number(s.points),
            },
      );
      return replaceSlots(offeringId, itemId, body);
    },
    onSuccess: async () => {
      setDirty(false);
      // the availability of each pool is computed by the server: read the configuration again
      await qc.invalidateQueries({ queryKey: assessmentKeys.config(offeringId, itemId) });
      toast.success('Questions saved.');
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const move = (i: number, d: number) => {
    const next = [...slots];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x as SlotDraft);
    change(next);
  };
  const total = slots.reduce((n, s) => n + (s.kind === 'pool' ? Number(s.count) || 1 : 1), 0);
  const points = slots.reduce(
    (n, s) => n + (s.kind === 'pool' ? Number(s.count) || 1 : 1) * (Number(s.points) || 0),
    0,
  );

  return (
    <Card title="Questions">
      <p className="mb-3 text-sm text-muted-foreground">
        Fixed questions are shown to everybody; a random pool draws questions from the bank by tag
        and difficulty, so learners get different papers. Several pools with different difficulties
        give everybody the same mix.
      </p>
      {slots.length === 0 ? (
        <EmptyState title="No questions yet" description="Add a fixed question or a random pool." />
      ) : (
        <ol className="space-y-3">
          {slots.map((s, i) => (
            <li key={s.key} className="space-y-2 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{i + 1}.</span>
                {s.kind === 'fixed' ? (
                  <>
                    <Badge>Fixed</Badge>
                    {s.type && <Badge>{TYPE_LABEL[s.type]}</Badge>}
                    <span className="min-w-0 flex-1 break-words text-sm">
                      {s.summary ?? 'Question'}
                    </span>
                  </>
                ) : (
                  <Badge>Random pool</Badge>
                )}
                <div className="ml-auto flex gap-1">
                  <Button
                    variant="ghost"
                    aria-label={`Move slot ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`Move slot ${i + 1} down`}
                    disabled={i === slots.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`Remove slot ${i + 1}`}
                    onClick={() => change(slots.filter((_, j) => j !== i))}
                  >
                    ✕
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                {s.kind === 'pool' && (
                  <>
                    <Select
                      label="Tag"
                      value={s.tag}
                      onChange={(e) =>
                        change(slots.map((x, j) => (j === i ? { ...x, tag: e.target.value } : x)))
                      }
                    >
                      <option value="">Any tag</option>
                      {tags.data?.items.map((t) => (
                        <option key={t.tag} value={t.tag}>
                          {t.tag}
                        </option>
                      ))}
                    </Select>
                    <Select
                      label="Difficulty"
                      value={s.difficulty}
                      onChange={(e) =>
                        change(
                          slots.map((x, j) =>
                            j === i
                              ? { ...x, difficulty: e.target.value as SlotDraft['difficulty'] }
                              : x,
                          ),
                        )
                      }
                    >
                      <option value="">Any</option>
                      <option value="easy">Easy</option>
                      <option value="medium">Medium</option>
                      <option value="hard">Hard</option>
                    </Select>
                    <Field
                      label="How many"
                      inputMode="numeric"
                      value={s.count}
                      onChange={(e) =>
                        change(
                          slots.map((x, j) =>
                            j === i ? { ...x, count: e.target.value.replace(/\D/g, '') } : x,
                          ),
                        )
                      }
                    />
                  </>
                )}
                <Field
                  label={s.kind === 'pool' ? 'Points each' : 'Points'}
                  inputMode="decimal"
                  value={s.points}
                  onChange={(e) =>
                    change(slots.map((x, j) => (j === i ? { ...x, points: e.target.value } : x)))
                  }
                />
              </div>
              {s.kind === 'pool' && s.available !== null && !dirty && (
                <p
                  className={
                    s.available < (Number(s.count) || 1)
                      ? 'text-sm text-danger'
                      : 'text-xs text-muted-foreground'
                  }
                  role={s.available < (Number(s.count) || 1) ? 'alert' : undefined}
                >
                  {s.available} matching questions in the bank
                  {s.available < (Number(s.count) || 1)
                    ? `: too few for ${s.count}, learners could not start`
                    : ''}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setPicker(true)}>
          Add a fixed question
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            change([
              ...slots,
              {
                key: `new-${slots.length}-${Date.now()}`,
                kind: 'pool',
                tag: '',
                difficulty: '',
                count: '5',
                points: '1',
                available: null,
              },
            ])
          }
        >
          Add a random pool
        </Button>
        <Button
          variant="secondary"
          disabled={dirty || slots.length === 0}
          onClick={() => setPreview(true)}
        >
          Preview a sample paper
        </Button>
        <span className="ml-auto text-sm text-muted-foreground">
          {total} questions · {points} points
        </span>
        <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
          Save questions
        </Button>
      </div>
      {picker && (
        <PickerDialog
          courseId={config.courseId}
          taken={new Set(slots.map((s) => s.questionId).filter(Boolean) as string[])}
          onClose={() => setPicker(false)}
          onPick={(q) => {
            change([
              ...slots,
              {
                key: `fixed-${q.id}`,
                kind: 'fixed',
                questionId: q.id,
                summary: plainText(q.stem).slice(0, 120),
                type: q.type,
                tag: '',
                difficulty: '',
                count: '1',
                points: '1',
                available: null,
              },
            ]);
            setPicker(false);
          }}
        />
      )}
      {preview && (
        <PreviewDialog offeringId={offeringId} itemId={itemId} onClose={() => setPreview(false)} />
      )}
    </Card>
  );
}

function PickerDialog({
  courseId,
  taken,
  onClose,
  onPick,
}: {
  courseId: string;
  taken: Set<string>;
  onClose: () => void;
  onPick: (q: { id: string; stem: unknown; type: string }) => void;
}) {
  const [type, setType] = useState('');
  const [tag, setTag] = useState('');
  const filters = { type: type || undefined, tag: tag || undefined };
  const list = useInfiniteQuery({
    queryKey: assessmentKeys.questionList(courseId, filters),
    queryFn: ({ pageParam, signal }) => listQuestions(courseId, filters, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const tags = useQuery({
    queryKey: assessmentKeys.tags(courseId),
    queryFn: ({ signal }) => listTags(courseId, signal),
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Dialog open onClose={onClose} title="Pick a question">
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <Select label="Tag" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">Any tag</option>
            {tags.data?.items.map((t) => (
              <option key={t.tag} value={t.tag}>
                {t.tag}
              </option>
            ))}
          </Select>
        </div>
        {list.isLoading && <ListSkeleton rows={3} label="Loading questions" />}
        {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
        <ul className="max-h-[50vh] space-y-2 overflow-y-auto">
          {items.map((q) => (
            <li
              key={q.id}
              className="flex items-start justify-between gap-3 rounded-md border border-border p-2 text-sm"
            >
              <span className="min-w-0">
                <Badge>{TYPE_LABEL[q.type]}</Badge> {plainText(q.stem).slice(0, 140)}
              </span>
              <Button variant="secondary" disabled={taken.has(q.id)} onClick={() => onPick(q)}>
                {taken.has(q.id) ? 'Added' : 'Add'}
              </Button>
            </li>
          ))}
        </ul>
        {list.hasNextPage && (
          <Button
            variant="secondary"
            loading={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            Load more
          </Button>
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

function PreviewDialog({
  offeringId,
  itemId,
  onClose,
}: {
  offeringId: string;
  itemId: string;
  onClose: () => void;
}) {
  // a fresh draw every time the dialog opens, but ONE key for the life of the dialog (a key that changes on every render
  // would start a new request on every render and never settle)
  const [nonce] = useState(() => Date.now());
  const paper = useQuery({
    queryKey: ['assessment-preview', offeringId, itemId, nonce],
    queryFn: () => previewPaper(offeringId, itemId),
    gcTime: 0,
    staleTime: 0,
  });
  return (
    <Dialog open onClose={onClose} title="Sample paper (as a learner gets it)">
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (axe) */}
      <div className="max-h-[65vh] space-y-3 overflow-y-auto" tabIndex={0}>
        {paper.isLoading && <ListSkeleton rows={3} label="Drawing a paper" />}
        {paper.isError && <ErrorState error={paper.error} onRetry={() => void paper.refetch()} />}
        <ol className="space-y-3">
          {paper.data?.questions.map((q) => (
            <li key={q.position} className="rounded-md border border-border p-3 text-sm">
              <p className="mb-1 text-xs font-semibold text-muted-foreground">
                Question {q.position} · {q.points} points · {TYPE_LABEL[q.type] ?? q.type}
              </p>
              <RichTextView doc={q.stem} />
              {q.options.length > 0 && (
                <ul className="mt-2 list-disc pl-5">
                  {q.options.map((o) => (
                    <li key={o.id}>{plainText(o.text)}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground">
          Nothing is stored. Each learner draws a different paper.
        </p>
      </div>
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ accommodations
function AccommodationsCard({ offeringId, itemId }: { offeringId: string; itemId: string }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: assessmentKeys.accommodations(offeringId, itemId),
    queryFn: ({ signal }) => listAccommodations(offeringId, itemId, signal),
    retry: (n, err) => !(err instanceof ApiError && err.status === 403) && n < 1,
  });
  const learners = useQuery({
    queryKey: [...courseKeys.people(offeringId, 'learner'), 'accommodations'],
    queryFn: ({ signal }) =>
      listParticipants(offeringId, { participation: 'learner' }, undefined, signal),
    enabled: list.isSuccess,
  });
  const [form, setForm] = useState({ participantId: '', minutes: '15', closes: '', reason: '' });
  const [removing, setRemoving] = useState<AccommodationRow | null>(null);
  const patch = (fn: (rows: AccommodationRow[]) => AccommodationRow[]) =>
    qc.setQueryData<{ items: AccommodationRow[] }>(
      assessmentKeys.accommodations(offeringId, itemId),
      (old) => (old ? { items: fn(old.items) } : old),
    );
  const save = useMutation({
    mutationFn: () =>
      putAccommodation(offeringId, itemId, form.participantId, {
        extraMinutes: Number(form.minutes) || 0,
        extendedCloseAt: fromLocal(form.closes),
        reason: form.reason.trim() || null,
      }),
    onSuccess: (row) => {
      patch((rows) =>
        [...rows.filter((r) => r.participantId !== row.participantId), row].sort((a, b) =>
          a.learnerName.localeCompare(b.learnerName),
        ),
      );
      setForm({ participantId: '', minutes: '15', closes: '', reason: '' });
      toast.success(`Accommodation saved for ${row.learnerName}.`);
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const remove = useMutation({
    mutationFn: (r: AccommodationRow) => deleteAccommodation(offeringId, itemId, r.participantId),
    onSuccess: (_x, r) => {
      patch((rows) => rows.filter((x) => x.participantId !== r.participantId));
      setRemoving(null);
      toast.success(`Accommodation removed for ${r.learnerName}.`);
    },
    onError: (err) => toast.error(describeError(err)),
  });
  // assistants may not see accommodations (they can reveal a health condition): the card is simply absent
  if (list.error instanceof ApiError && list.error.status === 403) return null;
  return (
    <Card title="Accommodations">
      <p className="mb-3 text-sm text-muted-foreground">
        Extra time and / or a later close date for a learner who needs it. Only instructors and
        administrators of the college see this list; changes are audited (minutes and dates, never
        the reason).
      </p>
      {list.isLoading ? (
        <ListSkeleton rows={2} label="Loading accommodations" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data && list.data.items.length > 0 ? (
        <ul className="mb-4 divide-y divide-border">
          {list.data.items.map((r) => (
            <li
              key={r.participantId}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <span>
                <strong>{r.learnerName}</strong> · +{r.extraMinutes} min
                {r.extendedCloseAt
                  ? ` · closes ${new Date(r.extendedCloseAt).toLocaleString()}`
                  : ''}
                {r.reason ? (
                  <span className="block text-xs text-muted-foreground">{r.reason}</span>
                ) : null}
              </span>
              <Button variant="secondary" onClick={() => setRemoving(r)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-sm text-muted-foreground">No accommodations.</p>
      )}
      <form
        className="grid gap-3 sm:grid-cols-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Select
          label="Learner"
          value={form.participantId}
          onChange={(e) => setForm({ ...form, participantId: e.target.value })}
        >
          <option value="">Choose a learner</option>
          {learners.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </Select>
        <Field
          label="Extra minutes"
          inputMode="numeric"
          value={form.minutes}
          onChange={(e) => setForm({ ...form, minutes: e.target.value.replace(/\D/g, '') })}
        />
        <Field
          label="Later close date (optional)"
          type="datetime-local"
          value={form.closes}
          onChange={(e) => setForm({ ...form, closes: e.target.value })}
        />
        <Field
          label="Reason (optional)"
          maxLength={300}
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
          hint="Do not write medical details here. “Approved by the disability office” is enough."
        />
        <div className="sm:col-span-2 sm:text-right">
          <Button type="submit" loading={save.isPending} disabled={!form.participantId}>
            Save accommodation
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
        pending={remove.isPending}
        title={`Remove the accommodation of ${removing?.learnerName ?? ''}?`}
        description="They get the normal time limit and close date from now on. A running attempt keeps its deadline."
        confirmLabel={`Remove for ${removing?.learnerName ?? ''}`}
      />
    </Card>
  );
}

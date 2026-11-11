import type { AssignmentConfig, AssignmentSettings } from '@lms/backend/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { lazy, Suspense, useRef, useState } from 'react';
import { ApiError } from '../../shared/api/client';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { ConfirmDialog } from '../../shared/ui/dialog';
import { Field } from '../../shared/ui/field';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { Select } from '../../shared/ui/select';
import { ErrorState, ListSkeleton, Skeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { toLocalInput } from '../../shared/utils/datetime';
import { courseKeys, listParticipants } from '../courses/courses.api';
import { loadEditor } from '../courses/editor/loadEditor';
import { uploadFile } from '../courses/uploadFile';
import {
  assignmentKeys,
  attachRubric,
  getConfig,
  listExtensions,
  listRubrics,
  removeExtension,
  replaceAttachments,
  setExtension,
  updateSettings,
} from './assignments.api';
import { bytes, stamp } from './format';

const RichTextEditor = lazy(loadEditor);

// The assignment builder (instructors): settings (dates, late policy, points, what may be handed in, blind grading, release),
// the instructions (rich text), attachments, the rubric, and the due-date extensions of individual learners.

const fromLocal = (v: string): string | null => (v ? new Date(v).toISOString() : null);

const LINK =
  'inline-flex min-h-11 items-center rounded-md border border-input px-4 text-sm hover:bg-muted sm:min-h-9';

export function AssignmentBuilderPage() {
  const { id, itemId } = useParams({ strict: false }) as { id: string; itemId: string };
  const config = useQuery({
    queryKey: assignmentKeys.config(id, itemId),
    queryFn: ({ signal }) => getConfig(id, itemId, signal),
  });
  if (config.isLoading) return <ListSkeleton rows={6} label="Loading the assignment" />;
  if (config.isError || !config.data) {
    return (
      <ErrorState
        title="Could not open the assignment"
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
        description={`${c.submissionCount} learner${c.submissionCount === 1 ? '' : 's'} handed in · ${c.gradedCount} graded`}
        actions={
          <>
            <Link
              to={`/offerings/${id}/items/${itemId}/assignment/grading` as '/'}
              className={LINK}
            >
              Grading
            </Link>
            <Link to={`/courses/${c.courseId}/rubrics` as '/'} className={LINK}>
              Rubrics
            </Link>
          </>
        }
      />
      {!c.published && (
        <Badge tone="warning">Hidden from learners: publish the item in the course content</Badge>
      )}
      <SettingsCard offeringId={id} itemId={itemId} config={c} />
      <AttachmentsCard offeringId={id} itemId={itemId} config={c} />
      <RubricCard offeringId={id} itemId={itemId} config={c} />
      <ExtensionsCard offeringId={id} itemId={itemId} />
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
  config: AssignmentConfig;
}) {
  const qc = useQueryClient();
  const s = config.settings;
  const [f, setF] = useState(() => ({
    opensAt: toLocalInput(s.opensAt),
    dueAt: toLocalInput(s.dueAt),
    latePolicy: s.latePolicy,
    cutoff: toLocalInput(s.lateCutoffAt),
    penaltyKind: s.penaltyKind,
    penaltyValue: String(s.penaltyValue),
    penaltyCap: String(s.penaltyCap),
    maxPoints: String(s.maxPoints),
    passing: s.passingScore?.toString() ?? '',
    allowFile: s.allowFile,
    allowText: s.allowText,
    allowLink: s.allowLink,
    maxFiles: String(s.maxFiles),
    maxFileMb: String(s.maxFileMb),
    resubmission: s.resubmissionAllowed,
    blind: s.anonymousGrading,
    release: s.releaseMode,
  }));
  const [instructions, setInstructions] = useState<unknown>(s.instructions);
  const touched = useRef(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const body: Partial<AssignmentSettings> = {
        opensAt: fromLocal(f.opensAt),
        dueAt: fromLocal(f.dueAt),
        latePolicy: f.latePolicy,
        lateCutoffAt: f.latePolicy === 'allowed' ? fromLocal(f.cutoff) : null,
        penaltyKind: f.penaltyKind,
        penaltyValue: Number(f.penaltyValue) || 0,
        penaltyCap: Number(f.penaltyCap) || 0,
        maxPoints: Number(f.maxPoints) || 100,
        passingScore: f.passing ? Number(f.passing) : null,
        allowFile: f.allowFile,
        allowText: f.allowText,
        allowLink: f.allowLink,
        maxFiles: Number(f.maxFiles) || 1,
        maxFileMb: Number(f.maxFileMb) || 1,
        resubmissionAllowed: f.resubmission,
        anonymousGrading: f.blind,
        releaseMode: f.release,
        ...(touched.current
          ? { instructions: instructions as AssignmentSettings['instructions'] }
          : {}),
      };
      return updateSettings(offeringId, itemId, body);
    },
    onSuccess: (settings) => {
      qc.setQueryData<AssignmentConfig>(assignmentKeys.config(offeringId, itemId), (old) =>
        old ? { ...old, settings } : old,
      );
      toast.success('Settings saved.');
    },
    onError: (err) => toast.error(describeError(err)),
  });
  return (
    <Card title="Settings">
      <form
        className="space-y-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="space-y-1">
          <p className="text-sm font-medium">Instructions</p>
          <Suspense fallback={<Skeleton className="h-40 w-full" />}>
            <RichTextEditor
              label="Instructions"
              value={s.instructions}
              onChange={(d) => {
                touched.current = true;
                setInstructions(d);
              }}
            />
          </Suspense>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Opens (optional)"
            type="datetime-local"
            value={f.opensAt}
            onChange={(e) => set('opensAt', e.target.value)}
          />
          <Field
            label="Due"
            type="datetime-local"
            value={f.dueAt}
            onChange={(e) => set('dueAt', e.target.value)}
            hint="Empty: no due date, nothing is ever late."
          />
          <Select
            label="Late work"
            value={f.latePolicy}
            onChange={(e) => set('latePolicy', e.target.value as 'none' | 'allowed')}
          >
            <option value="none">Not accepted after the due date</option>
            <option value="allowed">Accepted until a hard cutoff, with a penalty</option>
          </Select>
          {f.latePolicy === 'allowed' && (
            <>
              <Field
                label="Hard cutoff"
                type="datetime-local"
                value={f.cutoff}
                onChange={(e) => set('cutoff', e.target.value)}
                hint="Nothing is accepted after this."
              />
              <Select
                label="Penalty"
                value={f.penaltyKind}
                onChange={(e) => set('penaltyKind', e.target.value as 'per_day' | 'flat')}
              >
                <option value="per_day">Per started day late</option>
                <option value="flat">Once, however late</option>
              </Select>
              <Field
                label="Penalty (% of the maximum points)"
                inputMode="decimal"
                value={f.penaltyValue}
                onChange={(e) => set('penaltyValue', e.target.value)}
              />
              <Field
                label="The penalty never exceeds (%)"
                inputMode="decimal"
                value={f.penaltyCap}
                onChange={(e) => set('penaltyCap', e.target.value)}
              />
            </>
          )}
          <Field
            label="Maximum points"
            inputMode="decimal"
            value={f.maxPoints}
            onChange={(e) => set('maxPoints', e.target.value)}
          />
          <Field
            label="Pass mark (% of the maximum, optional)"
            inputMode="decimal"
            value={f.passing}
            onChange={(e) => set('passing', e.target.value)}
          />
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">What learners may hand in</legend>
          {(
            [
              ['allowFile', 'Files'],
              ['allowText', 'Text'],
              ['allowLink', 'A link'],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
              <input
                type="checkbox"
                className="size-5"
                checked={f[k]}
                onChange={(e) => set(k, e.target.checked)}
              />
              {label}
            </label>
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="At most this many files"
              inputMode="numeric"
              value={f.maxFiles}
              onChange={(e) => set('maxFiles', e.target.value.replace(/\D/g, ''))}
            />
            <Field
              label="Largest file (MB)"
              inputMode="numeric"
              value={f.maxFileMb}
              onChange={(e) => set('maxFileMb', e.target.value.replace(/\D/g, ''))}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Programs and scripts (.exe, .js, .sh, .html ...) are never accepted, whatever you choose
            here.
          </p>
        </fieldset>
        <div className="space-y-2">
          <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
            <input
              type="checkbox"
              className="size-5"
              checked={f.resubmission}
              onChange={(e) => set('resubmission', e.target.checked)}
            />
            Learners may hand in again (every version is kept, the latest counts)
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
            <input
              type="checkbox"
              className="size-5"
              checked={f.blind}
              onChange={(e) => set('blind', e.target.checked)}
            />
            Blind grading: graders see an anonymous code instead of names and register numbers
          </label>
          <Select
            label="Learners see their grade"
            value={f.release}
            onChange={(e) => set('release', e.target.value as 'manual' | 'immediate')}
          >
            <option value="manual">After I release it</option>
            <option value="immediate">As soon as it is saved</option>
          </Select>
        </div>
        <div className="text-right">
          <Button type="submit" loading={save.isPending}>
            Save settings
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------ attachments
function AttachmentsCard({
  offeringId,
  itemId,
  config,
}: {
  offeringId: string;
  itemId: string;
  config: AssignmentConfig;
}) {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<number | null>(null);
  const patch = (attachments: AssignmentConfig['attachments']) =>
    qc.setQueryData<AssignmentConfig>(assignmentKeys.config(offeringId, itemId), (old) =>
      old ? { ...old, attachments } : old,
    );
  const save = useMutation({
    mutationFn: (ids: string[]) => replaceAttachments(offeringId, itemId, ids),
    onSuccess: (r) => patch(r.attachments),
    onError: (err) => toast.error(describeError(err)),
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      setProgress(0);
      const f = await uploadFile(offeringId, file, setProgress);
      return replaceAttachments(offeringId, itemId, [
        ...config.attachments.map((a) => a.fileId),
        f.id,
      ]);
    },
    onSuccess: (r) => {
      patch(r.attachments);
      toast.success('File added.');
    },
    onError: (err) => toast.error(describeError(err)),
    onSettled: () => setProgress(null),
  });
  return (
    <Card title="Files for learners">
      {config.attachments.length > 0 ? (
        <ul className="mb-3 divide-y divide-border text-sm">
          {config.attachments.map((a) => (
            <li key={a.fileId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                {a.name} <span className="text-muted-foreground">({bytes(a.size)})</span>
              </span>
              <Button
                variant="secondary"
                disabled={save.isPending}
                onClick={() =>
                  save.mutate(
                    config.attachments.filter((x) => x.fileId !== a.fileId).map((x) => x.fileId),
                  )
                }
              >
                Remove {a.name}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-muted-foreground">No files.</p>
      )}
      <label htmlFor="asg-attach" className="block text-sm font-medium">
        Add a file
      </label>
      <input
        id="asg-attach"
        type="file"
        disabled={upload.isPending || config.attachments.length >= 10}
        className="block min-h-11 w-full text-sm sm:min-h-9"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload.mutate(file);
          e.target.value = '';
        }}
      />
      {progress !== null && (
        <progress className="mt-2 h-2 w-48" value={progress} max={1} aria-label="Uploading" />
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ rubric
function RubricCard({
  offeringId,
  itemId,
  config,
}: {
  offeringId: string;
  itemId: string;
  config: AssignmentConfig;
}) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: assignmentKeys.rubrics(config.courseId),
    queryFn: ({ signal }) => listRubrics(config.courseId, false, signal),
  });
  const [choice, setChoice] = useState(config.rubric?.rubricId ?? '');
  const attach = useMutation({
    mutationFn: (rubricId: string | null) => attachRubric(offeringId, itemId, rubricId),
    onSuccess: () => {
      toast.success('Rubric saved.');
      // the pinned version and its title come from the server
      void qc.invalidateQueries({ queryKey: assignmentKeys.config(offeringId, itemId) });
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const r = config.rubric;
  return (
    <Card title="Rubric">
      <p className="mb-3 text-sm text-muted-foreground">
        With a rubric the grader picks a level for every criterion and the score is the sum. The
        version you attach is pinned: editing the rubric later never changes what is already graded.
      </p>
      {r && (
        <p className="mb-3 text-sm">
          Attached: <strong>{r.title}</strong> (version {r.versionNo}, {r.maxPoints} points)
          {r.newerVersionAvailable && (
            <>
              {' '}
              <Badge tone="warning">A newer version exists</Badge>{' '}
              <Button
                variant="secondary"
                onClick={() => attach.mutate(r.rubricId)}
                loading={attach.isPending}
              >
                Use the newer version
              </Button>
            </>
          )}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Select label="Rubric" value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">No rubric (the grader gives a score)</option>
          {list.data?.items.map((x) => (
            <option key={x.id} value={x.id}>
              {x.title} ({x.maxPoints} points)
            </option>
          ))}
        </Select>
        <Button onClick={() => attach.mutate(choice || null)} loading={attach.isPending}>
          Save rubric
        </Button>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ extensions
function ExtensionsCard({ offeringId, itemId }: { offeringId: string; itemId: string }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: assignmentKeys.extensions(offeringId, itemId),
    queryFn: ({ signal }) => listExtensions(offeringId, itemId, signal),
    retry: (n, err) => !(err instanceof ApiError && err.status === 403) && n < 1,
  });
  const learners = useInfiniteQuery({
    queryKey: [...courseKeys.people(offeringId, 'learner'), 'extensions'],
    queryFn: ({ pageParam, signal }) =>
      listParticipants(offeringId, { participation: 'learner' }, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: list.isSuccess,
  });
  const [form, setForm] = useState({ participantId: '', due: '', reason: '' });
  const [removing, setRemoving] = useState<{ participantId: string; learnerName: string } | null>(
    null,
  );
  const keep = (rows: NonNullable<typeof list.data>['items']) =>
    qc.setQueryData(assignmentKeys.extensions(offeringId, itemId), { items: rows });
  const save = useMutation({
    mutationFn: () =>
      setExtension(offeringId, itemId, form.participantId, {
        extendedDueAt: new Date(form.due).toISOString(),
        ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
      }),
    onSuccess: (row) => {
      keep(
        [
          ...(list.data?.items.filter((r) => r.participantId !== row.participantId) ?? []),
          row,
        ].sort((a, b) => a.learnerName.localeCompare(b.learnerName)),
      );
      setForm({ participantId: '', due: '', reason: '' });
      toast.success(`Extension saved for ${row.learnerName}.`);
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const remove = useMutation({
    mutationFn: (r: { participantId: string; learnerName: string }) =>
      removeExtension(offeringId, itemId, r.participantId),
    onSuccess: (_x, r) => {
      keep(list.data?.items.filter((x) => x.participantId !== r.participantId) ?? []);
      setRemoving(null);
      toast.success(`Extension removed for ${r.learnerName}.`);
    },
    onError: (err) => toast.error(describeError(err)),
  });
  // assistants may not see extensions (a reason can reveal a health condition): the card is simply absent
  if (list.error instanceof ApiError && list.error.status === 403) return null;
  const people = learners.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card title="Extensions">
      <p className="mb-3 text-sm text-muted-foreground">
        A later due date for one learner (the hard cutoff moves by the same amount). Only
        instructors and administrators see this list; changes are audited with the dates, never the
        reason.
      </p>
      {list.isLoading ? (
        <ListSkeleton rows={2} label="Loading extensions" />
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
                <strong>{r.learnerName}</strong> · due {stamp(r.extendedDueAt)}
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
        <p className="mb-4 text-sm text-muted-foreground">No extensions.</p>
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
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </Select>
        <Field
          label="New due date"
          type="datetime-local"
          value={form.due}
          onChange={(e) => setForm({ ...form, due: e.target.value })}
        />
        <Field
          label="Reason (optional)"
          maxLength={300}
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
          hint="Do not write medical details here."
          className="sm:col-span-2"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
          {learners.hasNextPage ? (
            <Button
              variant="secondary"
              loading={learners.isFetchingNextPage}
              onClick={() => void learners.fetchNextPage()}
            >
              More learners
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="submit"
            loading={save.isPending}
            disabled={!form.participantId || !form.due}
          >
            Save extension
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
        pending={remove.isPending}
        title={`Remove the extension of ${removing?.learnerName ?? ''}?`}
        description="They get the normal due date from now on."
        confirmLabel={`Remove for ${removing?.learnerName ?? ''}`}
      />
    </Card>
  );
}

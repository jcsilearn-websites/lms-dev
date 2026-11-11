import type { RubricDetail, RubricInput, RubricSummary } from '@lms/backend/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Dialog } from '../../shared/ui/dialog';
import { Field } from '../../shared/ui/field';
import { Badge, PageHeader } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import {
  assignmentKeys,
  createRubric,
  getRubric,
  listRubrics,
  setRubricArchived,
  updateRubric,
} from './assignments.api';

// The rubrics of a course: criteria x levels x points. An edit adds a NEW version: assignments keep the version they were
// graded with. Assistants may read; instructors manage.

interface Level {
  id?: string;
  title: string;
  description: string;
  points: string;
}
interface Criterion {
  id?: string;
  title: string;
  description: string;
  levels: Level[];
}
interface Draft {
  title: string;
  criteria: Criterion[];
}

const blankLevels = (): Level[] => [
  { title: 'Not met', description: '', points: '0' },
  { title: 'Met', description: '', points: '5' },
];
const blank = (): Draft => ({
  title: '',
  criteria: [{ title: '', description: '', levels: blankLevels() }],
});
const fromDetail = (r: RubricDetail): Draft => ({
  title: r.title,
  criteria: r.criteria.map((c) => ({
    id: c.id,
    title: c.title,
    description: c.description,
    levels: c.levels.map((l) => ({
      id: l.id,
      title: l.title,
      description: l.description,
      points: String(l.points),
    })),
  })),
});
const toInput = (d: Draft): RubricInput => ({
  title: d.title.trim(),
  criteria: d.criteria.map((c) => ({
    ...(c.id ? { id: c.id } : {}),
    title: c.title.trim(),
    ...(c.description.trim() ? { description: c.description.trim() } : {}),
    levels: c.levels.map((l) => ({
      ...(l.id ? { id: l.id } : {}),
      title: l.title.trim(),
      ...(l.description.trim() ? { description: l.description.trim() } : {}),
      points: Number(l.points) || 0,
    })),
  })),
});
/** the maximum: the best level of every criterion */
export const maxOf = (d: Draft): number =>
  d.criteria.reduce(
    (sum, c) => sum + Math.max(0, ...c.levels.map((l) => Number(l.points) || 0)),
    0,
  );

export function RubricsPage() {
  const { courseId } = useParams({ strict: false }) as { courseId: string };
  const qc = useQueryClient();
  const [archived, setArchived] = useState(false);
  const list = useQuery({
    queryKey: [...assignmentKeys.rubrics(courseId), archived],
    queryFn: ({ signal }) => listRubrics(courseId, archived, signal),
  });
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const open = useMutation({
    mutationFn: (r: RubricSummary) => getRubric(courseId, r.id),
    onSuccess: (r) => setEditing({ id: r.id, draft: fromDetail(r) }),
    onError: (err) => toast.error(describeError(err)),
  });
  const toggle = useMutation({
    mutationFn: (r: RubricSummary) => setRubricArchived(courseId, r.id, !r.archived),
    onSuccess: (r) => {
      toast.success(r.archived ? `"${r.title}" archived.` : `"${r.title}" restored.`);
      void qc.invalidateQueries({ queryKey: assignmentKeys.rubrics(courseId) });
    },
    onError: (err) => toast.error(describeError(err)),
  });
  return (
    <div className="space-y-4">
      <Link to={'/offerings' as '/'} className="text-sm text-primary underline">
        ← Offerings
      </Link>
      <PageHeader
        title="Rubrics"
        description="Criteria with levels and points, used to grade assignments. Editing adds a new version; graded work keeps the version it used."
        actions={
          <Button onClick={() => setEditing({ id: null, draft: blank() })}>New rubric</Button>
        }
      />
      <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
        <input
          type="checkbox"
          className="size-5"
          checked={archived}
          onChange={(e) => setArchived(e.target.checked)}
        />
        Show archived rubrics
      </label>
      {list.isLoading ? (
        <ListSkeleton rows={4} label="Loading the rubrics" />
      ) : list.isError ? (
        <ErrorState
          title="Could not load the rubrics"
          error={list.error}
          onRetry={() => void list.refetch()}
        />
      ) : list.data && list.data.items.length === 0 ? (
        <EmptyState
          title="No rubrics yet"
          description="Create one to grade an assignment by criteria."
        />
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-surface">
          {list.data?.items.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
            >
              <span>
                <strong>{r.title}</strong>{' '}
                <span className="text-muted-foreground">
                  version {r.versionNo} · {r.criteriaCount} criteria · {r.maxPoints} points · used
                  by {r.usedBy}
                </span>{' '}
                {r.archived && <Badge>Archived</Badge>}
              </span>
              <span className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => open.mutate(r)}
                  loading={open.isPending && open.variables?.id === r.id}
                >
                  Edit
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => toggle.mutate(r)}
                  disabled={toggle.isPending}
                >
                  {r.archived ? `Restore ${r.title}` : `Archive ${r.title}`}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <RubricDialog
          courseId={courseId}
          id={editing.id}
          initial={editing.draft}
          onClose={() => setEditing(null)}
          onSaved={(r) => {
            setEditing(null);
            toast.success(editing.id ? `Saved as version ${r.versionNo}.` : 'Rubric created.');
            void qc.invalidateQueries({ queryKey: assignmentKeys.rubrics(courseId) });
          }}
        />
      )}
    </div>
  );
}

function RubricDialog({
  courseId,
  id,
  initial,
  onClose,
  onSaved,
}: {
  courseId: string;
  id: string | null;
  initial: Draft;
  onClose: () => void;
  onSaved: (r: RubricDetail) => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const save = useMutation({
    mutationFn: () =>
      id ? updateRubric(courseId, id, toInput(d)) : createRubric(courseId, toInput(d)),
    onSuccess: onSaved,
    onError: (err) => toast.error(describeError(err)),
  });
  const setCrit = (i: number, fn: (c: Criterion) => Criterion) =>
    setD((x) => ({ ...x, criteria: x.criteria.map((c, j) => (j === i ? fn(c) : c)) }));
  const valid =
    d.title.trim() !== '' &&
    d.criteria.every(
      (c) =>
        c.title.trim() !== '' &&
        c.levels.length >= 2 &&
        c.levels.every((l) => l.title.trim() !== ''),
    ) &&
    maxOf(d) > 0;
  return (
    <Dialog open onClose={onClose} title={id ? 'Edit the rubric (adds a version)' : 'New rubric'}>
      <form
        className="max-h-[70vh] space-y-4 overflow-y-auto pr-1"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field
          label="Name"
          value={d.title}
          maxLength={200}
          onChange={(e) => setD({ ...d, title: e.target.value })}
        />
        {d.criteria.map((c, i) => (
          <fieldset
            key={c.id ?? `new-${i}`}
            className="space-y-2 rounded-md border border-border p-3"
          >
            <legend className="px-1 text-sm font-semibold">Criterion {i + 1}</legend>
            <Field
              label={`Criterion ${i + 1} name`}
              value={c.title}
              maxLength={150}
              onChange={(e) => setCrit(i, (x) => ({ ...x, title: e.target.value }))}
            />
            {c.levels.map((l, j) => (
              <div key={l.id ?? `new-${j}`} className="grid grid-cols-[1fr_6rem] items-end gap-2">
                <Field
                  label={`Criterion ${i + 1} level ${j + 1}`}
                  value={l.title}
                  maxLength={100}
                  onChange={(e) =>
                    setCrit(i, (x) => ({
                      ...x,
                      levels: x.levels.map((y, k) =>
                        k === j ? { ...y, title: e.target.value } : y,
                      ),
                    }))
                  }
                />
                <Field
                  label={`Points of criterion ${i + 1} level ${j + 1}`}
                  inputMode="decimal"
                  value={l.points}
                  onChange={(e) =>
                    setCrit(i, (x) => ({
                      ...x,
                      levels: x.levels.map((y, k) =>
                        k === j ? { ...y, points: e.target.value } : y,
                      ),
                    }))
                  }
                />
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={c.levels.length >= 8}
                onClick={() =>
                  setCrit(i, (x) => ({
                    ...x,
                    levels: [...x.levels, { title: '', description: '', points: '0' }],
                  }))
                }
              >
                Add a level to criterion {i + 1}
              </Button>
              <Button
                variant="secondary"
                disabled={c.levels.length <= 2}
                onClick={() => setCrit(i, (x) => ({ ...x, levels: x.levels.slice(0, -1) }))}
              >
                Remove the last level
              </Button>
              <Button
                variant="secondary"
                disabled={d.criteria.length <= 1}
                onClick={() =>
                  setD((x) => ({ ...x, criteria: x.criteria.filter((_, j) => j !== i) }))
                }
              >
                Remove criterion {i + 1}
              </Button>
            </div>
          </fieldset>
        ))}
        <Button
          variant="secondary"
          disabled={d.criteria.length >= 20}
          onClick={() =>
            setD((x) => ({
              ...x,
              criteria: [...x.criteria, { title: '', description: '', levels: blankLevels() }],
            }))
          }
        >
          Add a criterion
        </Button>
        <p className="text-sm" data-testid="rubric-max">
          Maximum: <strong>{maxOf(d)}</strong> points (the best level of every criterion)
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending} disabled={!valid}>
            {id ? 'Save as a new version' : 'Create rubric'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

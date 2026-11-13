import type { GradeScale, GradeScaleInput } from '@lms/backend/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Dialog } from '../../shared/ui/dialog';
import { Field } from '../../shared/ui/field';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { archiveScale, createScale, gradebookKeys, listScales, updateScale } from './gradebook.api';

interface Draft {
  id?: string;
  name: string;
  bands: { key: string; minPercent: string; label: string; gradePoints: string; isPass: boolean }[];
}

const TEMPLATE: Draft['bands'] = [
  ['0', 'RA', '0', false],
  ['50', 'C', '5', true],
  ['60', 'B', '6', true],
  ['70', 'B+', '7', true],
  ['80', 'A', '8', true],
  ['90', 'A+', '9', true],
  ['95', 'O', '10', true],
].map(([m, l, g, p], i) => ({
  key: `t${i}`,
  minPercent: m as string,
  label: l as string,
  gradePoints: g as string,
  isPass: p as boolean,
}));

/** College grade scales (templates): percentage bands, each a floor, assigned per offering. Institution admins manage them. */
export function GradeScalesPage() {
  const qc = useQueryClient();
  const [archived, setArchived] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const q = useQuery({
    queryKey: [...gradebookKeys.scales, archived],
    queryFn: ({ signal }) => listScales(archived, signal),
  });
  const after = (s: GradeScale) => {
    void qc.invalidateQueries({ queryKey: gradebookKeys.scales });
    return s;
  };
  const save = useMutation({
    mutationFn: (d: Draft) => {
      const body: GradeScaleInput = {
        name: d.name.trim(),
        bands: d.bands.map((b) => ({
          minPercent: Number(b.minPercent),
          label: b.label.trim(),
          ...(b.gradePoints.trim() === '' ? {} : { gradePoints: Number(b.gradePoints) }),
          isPass: b.isPass,
        })),
      };
      return d.id ? updateScale(d.id, body) : createScale(body);
    },
    onSuccess: (s) => {
      after(s);
      toast.success(`Saved “${s.name}”`);
      setDraft(null);
    },
    onError: (e) => toast.error(describeError(e)),
  });
  const arch = useMutation({
    mutationFn: (v: { id: string; archived: boolean }) => archiveScale(v.id, v.archived),
    onSuccess: (s) => {
      after(s);
      toast.success(s.archived ? `Archived “${s.name}”` : `Restored “${s.name}”`);
    },
    onError: (e) => toast.error(describeError(e)),
  });
  const patchBand = (i: number, p: Partial<Draft['bands'][number]>) =>
    setDraft((d) =>
      d ? { ...d, bands: d.bands.map((b, j) => (j === i ? { ...b, ...p } : b)) } : d,
    );
  const valid =
    draft !== null &&
    draft.name.trim() !== '' &&
    draft.bands.length > 0 &&
    draft.bands.every(
      (b) =>
        /^[0-9]{1,3}([.][0-9]{1,3})?$/.test(b.minPercent) &&
        Number(b.minPercent) <= 100 &&
        b.label.trim() !== '',
    ) &&
    draft.bands.some((b) => Number(b.minPercent) === 0) &&
    new Set(draft.bands.map((b) => Number(b.minPercent))).size === draft.bands.length &&
    new Set(draft.bands.map((b) => b.label.trim().toLowerCase())).size === draft.bands.length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Grade scales"
        description="A scale turns the final percentage into a grade. Each band starts at a percentage; the lowest starts at 0."
        actions={
          <Button onClick={() => setDraft({ name: '', bands: TEMPLATE.map((b) => ({ ...b })) })}>
            New scale
          </Button>
        }
      />
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
        Show archived scales
      </label>
      {q.isLoading && <ListSkeleton rows={3} label="Loading the scales" />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.isSuccess && q.data.items.length === 0 && (
        <EmptyState
          title="No grade scale yet"
          description="Create one, for example O / A+ / A / B+ / B / C / RA."
        />
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {q.data?.items.map((s) => (
          <Card key={s.id} title={s.name}>
            <p className="mb-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              Used by {s.offerings} offering{s.offerings === 1 ? '' : 's'}
              {s.archived && <Badge>Archived</Badge>}
            </p>
            <ul className="mb-3 text-sm tabular-nums">
              {s.bands.map((b) => (
                <li key={b.minPercent}>
                  from {b.minPercent} % → <strong>{b.label}</strong>
                  {b.gradePoints !== null ? ` (${b.gradePoints} points)` : ''}
                  {b.isPass ? '' : ' · not a pass'}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  setDraft({
                    id: s.id,
                    name: s.name,
                    bands: s.bands.map((b, i) => ({
                      key: `b${i}`,
                      minPercent: String(b.minPercent),
                      label: b.label,
                      gradePoints: b.gradePoints === null ? '' : String(b.gradePoints),
                      isPass: b.isPass,
                    })),
                  })
                }
              >
                Edit
              </Button>
              <Button
                variant="secondary"
                loading={arch.isPending}
                aria-label={`${s.archived ? 'Restore' : 'Archive'} ${s.name}`}
                onClick={() => arch.mutate({ id: s.id, archived: !s.archived })}
              >
                {s.archived ? 'Restore' : 'Archive'}
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <Dialog
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? 'Edit the grade scale' : 'New grade scale'}
      >
        {draft && (
          <div className="max-h-[70vh] space-y-3 overflow-y-auto">
            <Field
              label="Name"
              value={draft.name}
              maxLength={80}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Changing a scale never changes an approved gradebook: it keeps its own copy of the
              bands.
            </p>
            <ul className="space-y-2">
              {draft.bands.map((b, i) => (
                <li
                  key={b.key}
                  className="grid grid-cols-2 gap-2 rounded-md border border-border p-2 sm:grid-cols-5"
                >
                  <Field
                    label="From %"
                    inputMode="decimal"
                    value={b.minPercent}
                    onChange={(e) => patchBand(i, { minPercent: e.target.value })}
                  />
                  <Field
                    label="Grade"
                    value={b.label}
                    maxLength={12}
                    onChange={(e) => patchBand(i, { label: e.target.value })}
                  />
                  <Field
                    label="Points"
                    inputMode="decimal"
                    value={b.gradePoints}
                    onChange={(e) => patchBand(i, { gradePoints: e.target.value })}
                  />
                  <label className="flex min-h-11 items-end gap-2 pb-2 text-sm">
                    <input
                      type="checkbox"
                      checked={b.isPass}
                      onChange={(e) => patchBand(i, { isPass: e.target.checked })}
                    />
                    Pass
                  </label>
                  <div className="flex items-end">
                    <Button
                      variant="secondary"
                      disabled={draft.bands.length === 1}
                      aria-label={`Remove the band ${b.label || i + 1}`}
                      onClick={() =>
                        setDraft({ ...draft, bands: draft.bands.filter((_, j) => j !== i) })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            {!valid && (
              <p role="status" className="text-sm text-muted-foreground">
                Needs a name, a band that starts at 0, and different percentages and grades in every
                band.
              </p>
            )}
            <div className="flex flex-wrap justify-between gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  setDraft({
                    ...draft,
                    bands: [
                      ...draft.bands,
                      {
                        key: `n${draft.bands.length}-${Date.now()}`,
                        minPercent: '',
                        label: '',
                        gradePoints: '',
                        isPass: true,
                      },
                    ],
                  })
                }
              >
                Add a band
              </Button>
              <span className="flex gap-2">
                <Button variant="secondary" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button
                  disabled={!valid}
                  loading={save.isPending}
                  onClick={() => save.mutate(draft)}
                >
                  Save
                </Button>
              </span>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

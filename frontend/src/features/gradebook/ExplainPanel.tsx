import type { GradebookConfig } from '@lms/backend/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Dialog } from '../../shared/ui/dialog';
import { Field } from '../../shared/ui/field';
import { Select } from '../../shared/ui/select';
import { ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { ExplanationView } from './ExplanationView';
import { getLearner, gradebookKeys, revokeOverride, setOverride } from './gradebook.api';

/** How one learner's final was calculated, with their overrides (an instructor may add or remove one, with a reason). */
export function ExplainPanel({
  offeringId,
  participantId,
  config,
  canOverride,
  onClose,
}: {
  offeringId: string;
  participantId: string | null;
  config: GradebookConfig;
  canOverride: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const open = participantId !== null;
  const q = useQuery({
    queryKey: gradebookKeys.learner(offeringId, participantId ?? ''),
    queryFn: ({ signal }) => getLearner(offeringId, participantId as string, signal),
    enabled: open,
  });
  const [item, setItem] = useState('');
  const [points, setPoints] = useState('');
  const [reason, setReason] = useState('');
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['gradebook', offeringId, 'grid'] });
    await qc.invalidateQueries({
      queryKey: gradebookKeys.learner(offeringId, participantId ?? ''),
    });
  };
  const add = useMutation({
    mutationFn: () =>
      setOverride(offeringId, participantId as string, {
        itemId: item === '' ? null : item,
        points: points.trim().replace(',', '.'),
        reason: reason.trim(),
      }),
    onSuccess: async () => {
      toast.success('Override saved');
      setPoints('');
      setReason('');
      await refresh();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const remove = useMutation({
    mutationFn: (itemId: string | null) =>
      revokeOverride(offeringId, participantId as string, itemId),
    onSuccess: async () => {
      toast.success('Override removed');
      await refresh();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const title = (id: string | null) =>
    id === null ? 'Final marks' : (config.items.find((i) => i.id === id)?.title ?? 'An item');
  const max = item === '' ? config.outOf : (config.items.find((i) => i.id === item)?.points ?? 0);
  const valid =
    /^[0-9]{1,6}([.][0-9]{1,2})?$/.test(points.trim().replace(',', '.')) &&
    reason.trim().length >= 3;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={q.data ? `${q.data.name}: how the final was calculated` : 'Calculation'}
    >
      <div className="max-h-[70vh] space-y-4 overflow-y-auto">
        {q.isLoading && <ListSkeleton rows={4} label="Loading the calculation" />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (
          <>
            <p className="text-sm text-muted-foreground">
              {q.data.registerNumber ?? 'No register number'} · {q.data.email}
              {q.data.section ? ` · section ${q.data.section}` : ''}
            </p>
            <ExplanationView
              explanation={q.data.explanation}
              provisional={config.status !== 'locked'}
            />
            <section aria-label="Overrides" className="space-y-2">
              <h3 className="font-semibold">Overrides</h3>
              {q.data.overrides.length === 0 && (
                <p className="text-sm text-muted-foreground">None.</p>
              )}
              <ul className="space-y-2">
                {q.data.overrides.map((o) => (
                  <li
                    key={o.itemId ?? 'final'}
                    className="rounded-md border border-border p-2 text-sm"
                  >
                    <p className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <strong>{title(o.itemId)}</strong> set to {o.points}
                      </span>
                      {canOverride && (
                        <Button
                          variant="secondary"
                          loading={remove.isPending}
                          aria-label={`Remove the override of ${title(o.itemId)}`}
                          onClick={() => remove.mutate(o.itemId)}
                        >
                          Remove
                        </Button>
                      )}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      Reason: {o.reason}
                      {o.setBy ? ` (${o.setBy}, ${new Date(o.setAt).toLocaleDateString()})` : ''}
                    </p>
                  </li>
                ))}
              </ul>
              {canOverride && (
                <form
                  className="space-y-2 rounded-md border border-border p-3"
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    if (valid) add.mutate();
                  }}
                >
                  <Select label="Override" value={item} onChange={(e) => setItem(e.target.value)}>
                    <option value="">Final marks (out of {config.outOf})</option>
                    {config.items.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.title} (out of {i.points})
                      </option>
                    ))}
                  </Select>
                  <Field
                    label={`Marks (0 to ${max})`}
                    inputMode="decimal"
                    value={points}
                    onChange={(e) => setPoints(e.target.value)}
                  />
                  <Field
                    label="Reason (required, kept in the audit log)"
                    value={reason}
                    maxLength={500}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <Button type="submit" disabled={!valid} loading={add.isPending}>
                    Save override
                  </Button>
                </form>
              )}
            </section>
          </>
        )}
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

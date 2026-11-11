import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Dialog } from '../../shared/ui/dialog';
import { Field } from '../../shared/ui/field';
import { Select } from '../../shared/ui/select';
import { toast } from '../../shared/ui/toast';
import { getCopyPreview } from '../assignments/assignments.api';
import { stamp } from '../assignments/format';
import { copyContent, courseKeys, listMyCourses } from './courses.api';

/** Copy the modules and items of another offering you teach to the end of this one (as unpublished drafts). */
export function CopyDialog({ offeringId, onClose }: { offeringId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const mine = useQuery({
    queryKey: [...courseKeys.mine, 'copy-sources'],
    queryFn: ({ signal }) => listMyCourses(undefined, signal),
  });
  const sources = (mine.data?.items ?? []).filter(
    (o) => o.myParticipation === 'instructor' && o.id !== offeringId,
  );
  const [source, setSource] = useState('');
  // assessments and assignments bring their dates: the preview shows them and the shift the terms suggest
  const preview = useQuery({
    queryKey: ['copy-preview', offeringId, source],
    queryFn: ({ signal }) => getCopyPreview(offeringId, source, signal),
    enabled: source !== '',
  });
  const [shift, setShift] = useState<string | null>(null);
  const [clear, setClear] = useState(false);
  const days = shift ?? String(preview.data?.defaultShiftDays ?? 0);
  const shifted = (iso: string | null) =>
    iso === null || clear
      ? '—'
      : stamp(new Date(new Date(iso).getTime() + (Number(days) || 0) * 86_400_000).toISOString());
  const copy = useMutation({
    mutationFn: () =>
      copyContent(offeringId, source, {
        ...(shift !== null ? { shiftDays: Number(shift) || 0 } : {}),
        ...(clear ? { clearDates: true } : {}),
      }),
    onSuccess: (r) => {
      if (r.status === 'queued') {
        toast.success('This is a large course: it is being copied in the background.');
      } else {
        toast.success(
          `Copied ${r.modules} module${r.modules === 1 ? '' : 's'} and ${r.items} item${r.items === 1 ? '' : 's'}. They are drafts: review them, then show them to learners.`,
        );
      }
      // a copy adds many rows at once: the one place where the outline is fetched again
      void qc.invalidateQueries({ queryKey: courseKeys.outline(offeringId) });
      void qc.invalidateQueries({ queryKey: courseKeys.offering(offeringId) });
      onClose();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  return (
    <Dialog open onClose={onClose} title="Copy content from another course">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Modules and items are added after the ones you have. Copies are hidden from learners until
          you show them. Files are shared, not duplicated.
        </p>
        {mine.isLoading ? (
          <p role="status" className="text-sm">
            Loading your courses…
          </p>
        ) : sources.length === 0 ? (
          <p className="text-sm">You do not teach another course to copy from.</p>
        ) : (
          <Select label="Copy from" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Choose a course…</option>
            {sources.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title} ({o.termName}
                {o.label ? `, ${o.label}` : ''})
              </option>
            ))}
          </Select>
        )}
        {source !== '' && preview.isLoading && (
          <p role="status" className="text-sm">
            Checking what would be copied…
          </p>
        )}
        {preview.data && preview.data.items.length > 0 && (
          <div className="space-y-3 rounded-md border border-border p-3" data-testid="copy-preview">
            <p className="text-sm">
              {preview.data.source.termName} starts {preview.data.source.termStart};{' '}
              {preview.data.target.termName} starts {preview.data.target.termStart}. The quizzes,
              exams and assignments below come with their settings and dates moved by{' '}
              <strong>
                {preview.data.defaultShiftDays} day
                {Math.abs(preview.data.defaultShiftDays) === 1 ? '' : 's'}
              </strong>
              . Adjust it if your new term runs differently.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Move the dates by (days)"
                inputMode="numeric"
                value={days}
                disabled={clear}
                onChange={(e) => setShift(e.target.value.replace(/[^\d-]/g, ''))}
              />
              <label className="flex min-h-11 items-center gap-2 self-end text-sm sm:min-h-0">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={clear}
                  onChange={(e) => setClear(e.target.checked)}
                />
                Copy without dates (I will set them)
              </label>
            </div>
            <ul className="space-y-2 text-sm">
              {preview.data.items.map((i) => (
                <li
                  key={`${i.kind}-${i.title}-${i.moduleTitle}`}
                  className="rounded-md bg-muted p-2"
                >
                  <strong>{i.title}</strong>{' '}
                  <span className="text-muted-foreground">
                    ({i.kind === 'assessment' ? 'quiz / exam' : 'assignment'}, {i.moduleTitle})
                  </span>
                  <dl className="mt-1 grid gap-x-4 sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-muted-foreground">Opens</dt>
                      <dd>
                        {stamp(i.opensAt) || '—'} → {shifted(i.opensAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        {i.kind === 'assessment' ? 'Closes' : 'Due'}
                      </dt>
                      <dd>
                        {stamp(i.endsAt) || '—'} → {shifted(i.endsAt)}
                      </dd>
                    </div>
                    {i.lateCutoffAt && (
                      <div>
                        <dt className="text-xs text-muted-foreground">Late cutoff</dt>
                        <dd>
                          {stamp(i.lateCutoffAt)} → {shifted(i.lateCutoffAt)}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {!i.copiesQuestions && (
                    <p className="mt-1 text-xs">
                      {i.kind === 'assessment'
                        ? 'This is another course: the questions do not come along (the question bank belongs to a course). Add questions after copying.'
                        : 'This is another course: the rubric does not come along. Attach one after copying.'}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Never copied: attempts, submissions, grades, extensions and accommodations of
              learners.
            </p>
          </div>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={copy.isPending}>
            Cancel
          </Button>
          <Button disabled={!source} loading={copy.isPending} onClick={() => copy.mutate()}>
            Copy content
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

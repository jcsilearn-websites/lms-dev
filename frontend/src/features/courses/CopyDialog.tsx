import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Dialog } from '../../shared/ui/dialog';
import { Select } from '../../shared/ui/select';
import { toast } from '../../shared/ui/toast';
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
  const copy = useMutation({
    mutationFn: () => copyContent(offeringId, source),
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

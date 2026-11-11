import type { AssignmentFile } from '@lms/backend/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Skeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { openTarget } from './AssignmentItemView';
import { staffFile } from './assignments.api';
import { bytes } from './format';

// How a grader looks at a learner's file. Only formats a browser renders WITHOUT running anything are shown inline: images
// (<img>), plain text (read with fetch and drawn as text) and PDFs. Everything else is a download (always an attachment).
// The bytes are served by the storage with `nosniff` and a sandboxing CSP, from the same origin under /api/storage.

export type PreviewKind = 'image' | 'pdf' | 'text' | 'download';

export function previewKind(f: { name: string; contentType: string }): PreviewKind {
  if (f.contentType === 'image/png' || f.contentType === 'image/jpeg') return 'image';
  if (f.contentType === 'application/pdf') return 'pdf';
  if (f.contentType === 'text/plain' || f.contentType === 'text/csv') return 'text';
  return 'download';
}

const MAX_TEXT = 200_000;

export function FilePreview({
  offeringId,
  itemId,
  file,
}: {
  offeringId: string;
  itemId: string;
  file: AssignmentFile;
}) {
  const kind = previewKind(file);
  const target = useQuery({
    queryKey: ['assignment', offeringId, itemId, 'file', file.fileId],
    queryFn: () => staffFile(offeringId, itemId, file.fileId),
    // a signed URL lives a few minutes: read a fresh one when the grader comes back to the file
    staleTime: 60_000,
    enabled: kind !== 'download',
  });
  const download = useMutation({
    mutationFn: () => staffFile(offeringId, itemId, file.fileId),
    onSuccess: (t) => openTarget({ url: t.url, inline: false }),
    onError: (err) => toast.error(describeError(err)),
  });
  const text = useQuery({
    queryKey: ['assignment', offeringId, itemId, 'filetext', file.fileId, target.data?.url],
    enabled: kind === 'text' && !!target.data,
    queryFn: async ({ signal }) => {
      const r = await fetch((target.data as { url: string }).url, {
        signal,
        credentials: 'include',
      });
      if (!r.ok) throw new Error('could not read the file');
      return (await r.text()).slice(0, MAX_TEXT);
    },
  });
  return (
    <figure className="space-y-2">
      <figcaption className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{file.name}</span>
        <span className="text-muted-foreground">{bytes(file.size)}</span>
        <Button variant="secondary" onClick={() => download.mutate()} loading={download.isPending}>
          Download {file.name}
        </Button>
        {kind === 'pdf' && target.data && (
          <a
            href={target.data.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center rounded-md border border-input px-4 text-sm hover:bg-muted sm:min-h-9"
          >
            Open in the browser viewer
          </a>
        )}
      </figcaption>
      {kind !== 'download' && target.isLoading && <Skeleton className="h-48 w-full" />}
      {kind !== 'download' && target.isError && (
        <p role="alert" className="text-sm text-danger">
          Could not open the file: {describeError(target.error)}
        </p>
      )}
      {kind === 'image' && target.data && (
        <img
          src={target.data.url}
          alt={`Submitted file ${file.name}`}
          className="max-h-[32rem] max-w-full rounded-md border border-border"
        />
      )}
      {kind === 'text' &&
        (text.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : text.isError ? (
          <p role="alert" className="text-sm text-danger">
            Could not show the text: download it instead.
          </p>
        ) : (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (axe)
          <div tabIndex={0} className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-sm">
            <pre className="whitespace-pre-wrap">{text.data}</pre>
          </div>
        ))}
      {kind === 'pdf' && target.data && (
        <p className="text-xs text-muted-foreground">
          PDF files open in the browser's own viewer in a new tab.
        </p>
      )}
      {kind === 'download' && (
        <p className="text-xs text-muted-foreground">
          This type of file cannot be shown here: download it to open it.
        </p>
      )}
    </figure>
  );
}

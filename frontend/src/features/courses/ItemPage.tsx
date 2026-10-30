import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { describeError } from '../../shared/api/errors';
import { RichTextView } from '../../shared/richtext/RichTextView';
import { Button } from '../../shared/ui/button';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { VideoItemView } from '../video/VideoItemView';
import { courseKeys, getItem, itemDownload } from './courses.api';

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** One item: its text, its link, or its file (downloaded through a short-lived signed URL). */
export function ItemPage() {
  const { id, itemId } = useParams({ strict: false }) as { id: string; itemId: string };
  const item = useQuery({
    queryKey: courseKeys.item(id, itemId),
    queryFn: ({ signal }) => getItem(id, itemId, signal),
    // a video that is still being prepared: look again until it is ready
    refetchInterval: (q) => (q.state.data?.video?.status === 'processing' ? 3000 : false),
  });
  const download = useMutation({
    mutationFn: () => itemDownload(id, itemId),
    onSuccess: (t) => {
      // a PDF or image opens in a tab; everything else downloads. Either way the browser follows the signed URL.
      window.open(t.url, t.inline ? '_blank' : '_self', 'noopener');
    },
    onError: (err) => toast.error(describeError(err)),
  });

  const back = (
    <Link to={`/offerings/${id}` as '/'} className="text-sm text-primary underline">
      ← Back to the course
    </Link>
  );
  if (item.isLoading) return <ListSkeleton rows={4} label="Loading" />;
  if (item.isError || !item.data) {
    return (
      <div className="space-y-4">
        {back}
        <ErrorState
          title="Could not open this item"
          error={item.error}
          onRetry={() => void item.refetch()}
        />
      </div>
    );
  }
  const it = item.data;
  return (
    <div className="space-y-6">
      {back}
      <PageHeader title={it.title} />
      {!it.published && <Badge tone="warning">Hidden from learners</Badge>}
      {it.locked ? (
        <Card>
          <p>
            This opens on{' '}
            <strong>
              {it.availableFrom ? new Date(it.availableFrom).toLocaleString() : 'a later date'}
            </strong>
            .
          </p>
        </Card>
      ) : (
        <>
          {it.kind === 'text' && (
            <Card>{it.body ? <RichTextView doc={it.body} /> : <p>No text.</p>}</Card>
          )}
          {it.kind === 'link' && it.url && (
            <Card>
              <p className="break-all">
                <a
                  href={it.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="text-primary underline"
                >
                  {it.url}
                </a>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Opens in a new tab on another website.
              </p>
            </Card>
          )}
          {it.kind === 'video' && <VideoItemView offeringId={id} item={it} />}
          {it.kind === 'file' && it.file && (
            <Card>
              <p className="font-medium">{it.file.name}</p>
              <p className="text-sm text-muted-foreground">{formatSize(it.file.size)}</p>
              <div className="mt-3">
                <Button loading={download.isPending} onClick={() => download.mutate()}>
                  Download {it.file.name}
                </Button>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

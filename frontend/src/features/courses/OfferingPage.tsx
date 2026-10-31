import type { ItemStatus, MyProgress, OutlineItem } from '@lms/backend/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Badge, PageHeader } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { usePermissions } from '../auth/useMe';
import { ItemStatusBadge, ProgressBar } from '../progress/ProgressBar';
import { getMyProgress, progressKeys } from '../progress/progress.api';
import { courseKeys, getOffering, getOutline } from './courses.api';

const KIND: Record<string, string> = {
  text: 'Reading',
  file: 'File',
  link: 'Link',
  video: 'Video',
};
const linkBtn =
  'inline-flex min-h-11 items-center rounded-md border border-input bg-surface px-4 text-sm font-medium hover:bg-muted sm:min-h-9';

function when(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '';
}

/**
 * A course as its participants see it: the outline. A learner gets published entries only; one that is not open
 * yet shows its title and "Available from", nothing else (the server sends no content for it). Instructors see
 * everything (with flags) and an "Edit content" button.
 */
export function OfferingPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { has } = usePermissions();
  const offering = useQuery({
    queryKey: courseKeys.offering(id),
    queryFn: ({ signal }) => getOffering(id, signal),
  });
  const outline = useQuery({
    queryKey: courseKeys.outline(id),
    queryFn: ({ signal }) => getOutline(id, signal),
  });

  // a learner's progress (an instructor or an administrator has none: `participant` is false)
  const progress = useQuery({
    queryKey: progressKeys.offering(id),
    queryFn: ({ signal }) => getMyProgress(id, signal),
    staleTime: 30_000,
  });
  const mine: MyProgress | null = progress.data?.participant ? progress.data : null;
  const statusOf = new Map<string, ItemStatus>(mine?.items.map((i) => [i.itemId, i.status]));
  const moduleOf = new Map(mine?.modules.map((m) => [m.moduleId, m]));

  if (offering.isLoading || outline.isLoading)
    return <ListSkeleton rows={6} label="Loading the course" />;
  if (offering.isError || outline.isError || !offering.data || !outline.data) {
    return (
      <ErrorState
        title="Could not open this course"
        error={offering.error ?? outline.error}
        onRetry={() => {
          void offering.refetch();
          void outline.refetch();
        }}
      />
    );
  }
  const o = offering.data;
  const data = outline.data;
  const staff =
    o.myParticipation === 'instructor' ||
    o.myParticipation === 'assistant' ||
    has('participant.read');
  const total = data.modules.reduce((n, m) => n + m.items.length, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={o.title}
        description={`${o.courseCode} · ${o.termName}${o.label ? ` · ${o.label}` : ''}`}
        actions={
          <>
            {data.canEdit && (
              <Link to={`/offerings/${id}/build` as '/'} className={linkBtn}>
                Edit content
              </Link>
            )}
            {staff && (
              <Link to={`/offerings/${id}/progress` as '/'} className={linkBtn}>
                Class progress
              </Link>
            )}
            {staff && (
              <Link to={`/offerings/${id}/people` as '/'} className={linkBtn}>
                {has('offering.manage') ? 'People and sections' : 'Class list'}
              </Link>
            )}
          </>
        }
      />
      <p className="flex flex-wrap gap-2 text-sm">
        {o.status === 'draft' && (
          <Badge tone="warning">Draft: learners cannot see this course</Badge>
        )}
        {o.status === 'archived' && <Badge>Archived: read only</Badge>}
        {o.myParticipation && (
          <Badge>
            {o.myParticipation === 'learner'
              ? 'You are a learner'
              : `You are ${o.myParticipation === 'instructor' ? 'an instructor' : 'an assistant'}`}
          </Badge>
        )}
      </p>

      {mine && (
        <section
          aria-label="Your progress"
          className="rounded-md border border-border bg-surface p-4"
        >
          <ProgressBar
            percent={mine.percent}
            label={`Your progress in ${o.title}`}
            detail={
              mine.totalRequired > 0
                ? `${mine.completedRequired} of ${mine.totalRequired} required items`
                : undefined
            }
          />
        </section>
      )}

      {data.modules.length === 0 ? (
        <EmptyState
          title="Nothing here yet"
          description={
            data.canEdit
              ? 'Add modules and items with Edit content.'
              : 'Your instructor has not added content yet.'
          }
        />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {data.modules.length} module{data.modules.length === 1 ? '' : 's'}, {total} item
            {total === 1 ? '' : 's'}
          </p>
          <ol className="space-y-4">
            {data.modules.map((m) => (
              <li key={m.id} className="rounded-md border border-border bg-surface">
                <h2 className="flex flex-wrap items-center gap-2 border-b border-border p-3 text-lg font-semibold">
                  <span className="min-w-0 flex-1">{m.title}</span>
                  {!m.published && <Badge tone="warning">Hidden from learners</Badge>}
                  {m.availableFrom && <Badge>Opens {when(m.availableFrom)}</Badge>}
                  {moduleOf.get(m.id)?.percent != null && (
                    <span className="text-sm font-normal tabular-nums text-muted-foreground">
                      {moduleOf.get(m.id)?.percent}% complete
                    </span>
                  )}
                </h2>
                {m.items.length === 0 ? (
                  <p className="p-3 text-sm text-muted-foreground">No items.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {m.items.map((i) => (
                      <ItemLine key={i.id} offeringId={id} item={i} status={statusOf.get(i.id)} />
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function ItemLine({
  offeringId,
  item,
  status,
}: {
  offeringId: string;
  item: OutlineItem;
  /** the learner's own status (undefined for someone who is not a learner) */
  status: ItemStatus | undefined;
}) {
  const meta = (
    <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{KIND[item.kind] ?? item.kind}</span>
      {item.file && <span>{item.file.name}</span>}
      {!item.published && <Badge tone="warning">Hidden from learners</Badge>}
      {status && <ItemStatusBadge status={status} />}
      {status && !item.required && <Badge>Optional</Badge>}
    </span>
  );
  if (item.locked) {
    return (
      <li className="flex flex-col gap-1 p-3">
        <span className="font-medium">{item.title}</span>
        <span className="text-sm">
          <Badge>Available from {when(item.availableFrom)}</Badge>
        </span>
      </li>
    );
  }
  return (
    <li className="p-3">
      <Link
        to={`/offerings/${offeringId}/items/${item.id}` as '/'}
        className="-m-1 flex min-h-11 flex-col justify-center gap-1 rounded-md p-1 hover:bg-muted"
      >
        <span className="font-medium text-primary">{item.title}</span>
        {meta}
        {item.availableFrom && (
          <span className="text-xs text-muted-foreground">Opened {when(item.availableFrom)}</span>
        )}
      </Link>
    </li>
  );
}

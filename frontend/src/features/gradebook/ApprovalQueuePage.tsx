import type { Queue } from '@lms/backend/contracts';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { type Column, DataTable } from '../../shared/ui/data-table';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { getCollegeSettings, getQueue, gradebookKeys, patchCollegeSettings } from './gradebook.api';
import { STATUS_TEXT } from './workflowText';

type Entry = Queue['items'][number];
type Status = 'submitted' | 'returned' | 'locked';
const TABS: { key: Status; label: string }[] = [
  { key: 'submitted', label: 'Waiting for approval' },
  { key: 'returned', label: 'Returned' },
  { key: 'locked', label: 'Approved' },
];

/** The approval queue of the college: every offering's gradebook by status. Opening one shows the read-only review. */
export function ApprovalQueuePage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>('submitted');
  const q = useInfiniteQuery<
    Queue,
    Error,
    InfiniteData<Queue, string | undefined>,
    ReturnType<typeof gradebookKeys.queue>,
    string | undefined
  >({
    queryKey: gradebookKeys.queue(status),
    queryFn: ({ pageParam, signal }) => getQueue(status, pageParam, signal),
    initialPageParam: undefined,
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const settings = useQuery({
    queryKey: gradebookKeys.college,
    queryFn: ({ signal }) => getCollegeSettings(signal),
  });
  const toggle = useMutation({
    mutationFn: (allowSelfApproval: boolean) => patchCollegeSettings({ allowSelfApproval }),
    onSuccess: (s) => {
      qc.setQueryData(gradebookKeys.college, s);
      toast.success(
        s.allowSelfApproval ? 'Self-approval is allowed' : 'Self-approval is not allowed',
      );
    },
    onError: (e) => toast.error(describeError(e)),
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const columns: Column<Entry>[] = [
    {
      header: 'Course',
      cell: (r) => (
        <Link to={`/offerings/${r.offeringId}/gradebook` as '/'} className="text-primary underline">
          {r.courseCode} · {r.courseTitle}
          {r.label ? ` · ${r.label}` : ''}
        </Link>
      ),
    },
    { header: 'Term', cell: (r) => r.termName },
    {
      header: 'Status',
      cell: (r) => (
        <Badge
          tone={
            r.status === 'locked' ? 'success' : r.status === 'submitted' ? 'warning' : 'neutral'
          }
        >
          {STATUS_TEXT[r.status]}
        </Badge>
      ),
    },
    { header: 'Version', cell: (r) => r.versionNo },
    { header: 'Submitted by', cell: (r) => r.submittedBy ?? '—' },
    { header: 'When', cell: (r) => new Date(r.submittedAt ?? r.updatedAt).toLocaleString() },
  ];
  return (
    <div className="space-y-5">
      <PageHeader
        title="Gradebook approvals"
        description="Gradebooks that instructors submitted, the ones returned and the approved ones."
      />
      <div
        role="tablist"
        aria-label="Status"
        className="flex flex-wrap gap-2 border-b border-border"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={status === t.key}
            onClick={() => setStatus(t.key)}
            className={`min-h-11 px-4 text-sm font-medium sm:min-h-9 ${status === t.key ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {q.isLoading && <ListSkeleton rows={5} label="Loading the queue" />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.isSuccess && items.length === 0 && (
        <EmptyState
          title="Nothing here"
          description={
            status === 'submitted'
              ? 'No gradebook is waiting for approval.'
              : 'No gradebook has this status.'
          }
        />
      )}
      {items.length > 0 && (
        <DataTable
          caption="Gradebooks"
          columns={columns}
          rows={items}
          rowKey={(r) => r.gradebookId}
        />
      )}
      {q.hasNextPage && (
        <Button
          variant="secondary"
          loading={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          Load more
        </Button>
      )}
      <Card title="College setting">
        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={settings.data?.allowSelfApproval === true}
            disabled={!settings.data || toggle.isPending}
            onChange={(e) => toggle.mutate(e.target.checked)}
          />
          <span>
            Allow self-approval of gradebooks
            <span className="block text-muted-foreground">
              Off by default: the person who submitted a gradebook cannot approve or return it.
              Every approval, and every refused attempt, is in the audit log.
            </span>
          </span>
        </label>
      </Card>
    </div>
  );
}

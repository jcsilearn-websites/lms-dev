import type { Suppression, SuppressionPage } from '@lms/backend/contracts';
import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { DataTable } from '../../shared/ui/data-table';
import { ConfirmDialog } from '../../shared/ui/dialog';
import { PageHeader } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { clearSuppression, listSuppressions, notificationKeys } from './notifications.api';

type Pages = InfiniteData<SuppressionPage, string | undefined>;

const REASON: Record<Suppression['reason'], string> = {
  bounce: 'Bounced (address does not exist or refuses mail)',
  complaint: 'Reported as spam (security emails still sent)',
  manual: 'Stopped by an administrator',
};

/**
 * Members whose address is on the suppression list. Nothing is emailed to a bouncing address until it is cleared here (after the
 * member fixed it, e.g. a full mailbox emptied or a typo corrected). Clearing is audited.
 */
export function EmailSuppressionsPage() {
  const qc = useQueryClient();
  const [target, setTarget] = useState<Suppression | null>(null);
  const list = useInfiniteQuery<
    SuppressionPage,
    Error,
    Pages,
    readonly unknown[],
    string | undefined
  >({
    queryKey: notificationKeys.suppressions,
    queryFn: ({ pageParam, signal }) => listSuppressions(pageParam, signal),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  const clear = async () => {
    if (!target) return;
    try {
      await clearSuppression(target.id);
      qc.setQueryData<Pages>(notificationKeys.suppressions, (d) =>
        d
          ? {
              ...d,
              pages: d.pages.map((p) => ({
                ...p,
                items: p.items.filter((x) => x.id !== target.id),
              })),
            }
          : d,
      );
      void qc.invalidateQueries({ queryKey: notificationKeys.emailStatus });
      toast.success(`Emails to ${target.email} will be sent again`);
      setTarget(null);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <div>
      <PageHeader
        title="Bouncing addresses"
        description="Members of your college we no longer email, and why. Clear an address once the member has fixed it."
      />
      {list.isPending ? (
        <ListSkeleton label="Loading bouncing addresses" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No bouncing addresses"
          description="Every member's email is being delivered."
        />
      ) : (
        <>
          <DataTable<Suppression>
            caption="Bouncing addresses"
            rows={rows}
            rowKey={(r) => r.id}
            columns={[
              { header: 'Member', cell: (r) => r.displayName ?? '' },
              { header: 'Email', cell: (r) => r.email },
              { header: 'Why', cell: (r) => REASON[r.reason] },
              { header: 'Since', cell: (r) => new Date(r.createdAt).toLocaleString() },
              {
                header: 'Action',
                cell: (r) => (
                  <Button
                    variant="secondary"
                    onClick={() => setTarget(r)}
                    aria-label={`Clear ${r.email}`}
                  >
                    Clear
                  </Button>
                ),
              },
            ]}
          />
          {list.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="secondary"
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        open={target !== null}
        title={`Send email to ${target?.email ?? ''} again?`}
        description="Only clear an address that works now. If it bounces again it goes back on this list."
        confirmLabel={`Clear ${target?.email ?? ''}`}
        onConfirm={() => void clear()}
        onClose={() => setTarget(null)}
      />
    </div>
  );
}

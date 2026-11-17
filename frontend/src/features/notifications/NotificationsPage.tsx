import type { Notification, NotificationPage } from '@lms/backend/contracts';
import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { hostKind } from '../../app/host';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { PageHeader } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { notifyCountChanged } from './NotificationBell';
import {
  listNotifications,
  markAllRead,
  markPlatformRead,
  markRead,
  notificationKeys,
} from './notifications.api';
import { notificationText } from './notificationText';

type Pages = InfiniteData<NotificationPage, string | undefined>;

/** Every notification, newest first, keyset "load more"; an unread filter; mark one or all read (the cache is patched). */
export function NotificationsPage() {
  const platform = hostKind === 'admin';
  const qc = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const key = [...notificationKeys.list(unreadOnly), platform];
  const list = useInfiniteQuery<
    NotificationPage,
    Error,
    Pages,
    readonly unknown[],
    string | undefined
  >({
    queryKey: key,
    queryFn: ({ pageParam, signal }) =>
      listNotifications(platform, { after: pageParam, limit: 20, unread: unreadOnly }, signal),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const now = () => new Date().toISOString();

  const patch = (fn: (n: Notification) => Notification) =>
    qc.setQueryData<Pages>(key, (d) =>
      d ? { ...d, pages: d.pages.map((p) => ({ ...p, items: p.items.map(fn) })) } : d,
    );

  const readOne = async (n: Notification) => {
    if (n.readAt) return;
    try {
      await (platform ? markPlatformRead(n.id) : markRead(n.id));
      patch((x) => (x.id === n.id ? { ...x, readAt: now() } : x));
      notifyCountChanged();
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  const readAll = async () => {
    try {
      const r = await markAllRead(platform);
      patch((x) => ({ ...x, readAt: x.readAt ?? now() }));
      notifyCountChanged();
      toast.success(
        r.updated === 1
          ? 'Marked 1 notification as read'
          : `Marked ${r.updated} notifications as read`,
      );
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Deadlines, results, digests and updates. Emails say the same and link here."
        actions={
          <>
            {!platform && (
              <Link
                to={'/me/notifications' as '/'}
                className="inline-flex min-h-11 items-center rounded-md border border-input px-4 text-sm font-medium hover:bg-muted sm:min-h-9"
              >
                Notification settings
              </Link>
            )}
            <Button variant="secondary" onClick={() => void readAll()}>
              Mark all as read
            </Button>
          </>
        }
      />
      <label className="mb-4 flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={unreadOnly}
          onChange={(e) => setUnreadOnly(e.target.checked)}
          className="h-5 w-5"
        />
        Show unread only
      </label>
      {list.isPending ? (
        <ListSkeleton label="Loading notifications" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={unreadOnly ? 'Nothing unread' : 'No notifications yet'}
          description="When something needs your attention it appears here."
        />
      ) : (
        <>
          <ul
            aria-label="Notifications"
            className="divide-y divide-border rounded-md border border-border bg-surface"
          >
            {rows.map((n) => {
              const t = notificationText(n);
              return (
                <li key={n.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {!n.readAt && (
                        <span className="mr-2 inline-flex rounded-full border border-primary px-2 text-xs text-primary">
                          Unread
                        </span>
                      )}
                      {n.link ? (
                        <Link
                          to={n.link as '/'}
                          onClick={() => void readOne(n)}
                          className="underline"
                        >
                          {t.title}
                        </Link>
                      ) : (
                        t.title
                      )}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {t.detail && `${t.detail} · `}
                      <time dateTime={n.createdAt}>{new Date(n.createdAt).toLocaleString()}</time>
                    </p>
                  </div>
                  {!n.readAt && (
                    <Button
                      variant="ghost"
                      onClick={() => void readOne(n)}
                      aria-label={`Mark as read: ${t.title}`}
                    >
                      Mark as read
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
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
    </div>
  );
}

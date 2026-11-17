import type { Notification } from '@lms/backend/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { toast } from '../../shared/ui/toast';
import { useAfterLoad } from '../../shared/utils/afterLoad';
import { createNotificationPoller, type NotificationPoller } from './notificationPoller';
import {
  listNotifications,
  markAllRead,
  markPlatformRead,
  markRead,
  notificationKeys,
  pollUnread,
} from './notifications.api';
import { notificationText } from './notificationText';

/** Other screens (the notifications page) tell the bell that the count changed. */
export const notificationEvents = new EventTarget();
export const notifyCountChanged = () => notificationEvents.dispatchEvent(new Event('changed'));

export const countLabel = (n: number) => (n >= 100 ? '99+' : String(n));

/**
 * The bell in the header: the unread count (polled cheaply, see notificationPoller.ts) and, when opened, the latest
 * notifications with "Mark all as read" and a link to the full list. Small on purpose: it is part of the app shell.
 */
export function NotificationBell({ platform = false }: { platform?: boolean }) {
  const qc = useQueryClient();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const poller = useRef<NotificationPoller | null>(null);
  const ready = useAfterLoad();

  useEffect(() => {
    if (!ready) return;
    const p = createNotificationPoller({ poll: (etag) => pollUnread(etag), onCount: setCount });
    poller.current = p;
    p.start();
    const onChanged = () => p.refresh();
    notificationEvents.addEventListener('changed', onChanged);
    return () => {
      notificationEvents.removeEventListener('changed', onChanged);
      p.stop();
    };
  }, [ready]);

  const latest = useQuery({
    queryKey: [...notificationKeys.latest, platform],
    queryFn: ({ signal }) => listNotifications(platform, { limit: 8 }, signal),
    enabled: open,
    staleTime: 0,
  });

  // close on Escape (focus back to the bell) and on a click outside
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  const readAll = async () => {
    try {
      await markAllRead(platform);
      setCount(0);
      qc.setQueryData<{ items: Notification[]; nextCursor: string | null }>(
        [...notificationKeys.latest, platform],
        (d) =>
          d
            ? {
                ...d,
                items: d.items.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })),
              }
            : d,
      );
      void qc.invalidateQueries({ queryKey: ['notifications', 'list'] });
      poller.current?.refresh();
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  const openOne = (n: Notification) => {
    setOpen(false);
    if (n.readAt) return;
    setCount((c) => Math.max(0, c - 1));
    void (platform ? markPlatformRead(n.id) : markRead(n.id))
      .then(() => poller.current?.refresh())
      .catch(() => {});
  };

  const items = latest.data?.items ?? [];
  const label = count > 0 ? `Notifications, ${countLabel(count)} unread` : 'Notifications';

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="relative flex min-h-11 min-w-11 items-center justify-center rounded-md border border-input sm:min-h-9 sm:min-w-9"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {count > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full bg-danger px-1 text-center text-xs font-semibold leading-5 text-danger-foreground"
          >
            {countLabel(count)}
          </span>
        )}
      </button>
      {open && (
        <section
          id={panelId}
          aria-label="Latest notifications"
          className="absolute right-0 z-40 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-surface shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold">Notifications</h2>
            {count > 0 && (
              <button
                type="button"
                onClick={() => void readAll()}
                className="min-h-9 rounded-md px-2 text-sm text-primary underline hover:bg-muted"
              >
                Mark all as read
              </button>
            )}
          </div>
          {latest.isPending ? (
            <p role="status" className="px-3 py-4 text-sm text-muted-foreground">
              Loading…
            </p>
          ) : latest.isError ? (
            <div role="alert" className="px-3 py-4 text-sm">
              <p>{describeError(latest.error)}</p>
              <button
                type="button"
                className="mt-2 min-h-9 underline"
                onClick={() => void latest.refetch()}
              >
                Try again
              </button>
            </div>
          ) : items.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">You have no notifications.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-border overflow-y-auto">
              {items.map((n) => {
                const t = notificationText(n);
                const body = (
                  <>
                    <span className="block text-sm font-medium">
                      {!n.readAt && (
                        <span className="mr-1 inline-flex rounded-full border border-primary px-1.5 text-xs text-primary">
                          Unread
                        </span>
                      )}{' '}
                      {t.title}
                    </span>
                    {t.detail && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {t.detail}
                      </span>
                    )}
                  </>
                );
                return (
                  <li key={n.id} className={n.readAt ? '' : 'bg-muted/50'}>
                    {n.link ? (
                      <Link
                        to={n.link as '/'}
                        onClick={() => openOne(n)}
                        className="block min-h-11 px-3 py-2 hover:bg-muted"
                      >
                        {body}
                      </Link>
                    ) : (
                      <div className="px-3 py-2">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="border-t border-border px-3 py-2">
            <Link
              to={'/notifications' as '/'}
              onClick={() => setOpen(false)}
              className="flex min-h-9 items-center text-sm text-primary underline"
            >
              See all notifications
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useAfterLoad } from '../../shared/utils/afterLoad';
import { getEmailStatus, notificationKeys } from './notifications.api';

/**
 * Shown when the signed-in member's own address is on the suppression list (it bounced, or a spam complaint was made): we no
 * longer email them, so they should know why reminders stopped. Admins get a link to the list where they can clear it.
 */
export function EmailStatusBanner({ canManage }: { canManage: boolean }) {
  const status = useQuery({
    queryKey: notificationKeys.emailStatus,
    queryFn: ({ signal }) => getEmailStatus(signal),
    enabled: useAfterLoad(),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const s = status.data;
  if (!s?.suppressed) return null;
  const since = s.since ? new Date(s.since).toLocaleDateString() : null;
  return (
    <section
      aria-label="Email delivery problem"
      className="border-b border-warning bg-surface px-4 py-2 text-sm"
    >
      <p className="mx-auto max-w-6xl">
        <strong>
          Emails to {s.email} are {s.reason === 'complaint' ? 'stopped' : 'bouncing'}
        </strong>
        {since ? ` (since ${since})` : ''}
        {s.reason === 'complaint'
          ? ': it was reported as spam, so only security emails are sent. '
          : ': we cannot deliver to this address, so no email is sent to it. '}
        {canManage ? (
          <Link to={'/settings/email' as '/'} className="underline">
            Review bouncing addresses
          </Link>
        ) : (
          'Contact your college admin.'
        )}
      </p>
    </section>
  );
}

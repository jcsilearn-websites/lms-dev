import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { ErrorState, Skeleton } from '../../shared/ui/states';
import { AuthLayout } from '../auth/AuthLayout';
import { getUnsubscribeInfo, notificationKeys, unsubscribe } from './notifications.api';

/**
 * The page behind the "Stop emails about ..." link of an email. Opening it changes NOTHING (mail scanners open links): the
 * member confirms with the button. Mail clients use the one-click POST of the List-Unsubscribe header instead.
 */
export function UnsubscribePage() {
  const { t } = useSearch({ strict: false }) as { t?: string };
  const token = t ?? '';
  const info = useQuery({
    queryKey: notificationKeys.unsubscribe(token),
    queryFn: ({ signal }) => getUnsubscribeInfo(token, signal),
    enabled: token.length > 0,
    retry: false,
  });
  const done = useMutation({ mutationFn: () => unsubscribe(token) });

  return (
    <AuthLayout title="Email settings">
      {!token ? (
        <p role="alert">This link is incomplete. Open it again from the email.</p>
      ) : info.isPending ? (
        <div role="status" aria-label="Loading" className="space-y-2">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : info.isError ? (
        <ErrorState title="This link does not work" error={info.error} />
      ) : done.isSuccess ? (
        <div role="status" className="space-y-3">
          <p className="font-medium">
            You will no longer get emails about {done.data.categoryLabel.toLowerCase()}.
          </p>
          <p className="text-sm text-muted-foreground">
            You still see them in the notifications of {info.data.college}. Security emails
            (password, invitations) are always sent. You can turn this back on in your notification
            settings.
          </p>
          <Link to={'/me/notifications' as '/'} className="text-sm underline">
            Open my notification settings
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          <p>
            Stop emails about <strong>{info.data.categoryLabel.toLowerCase()}</strong> from{' '}
            {info.data.college} to {info.data.emailMasked}?
          </p>
          {!info.data.subscribed && (
            <p className="text-sm text-muted-foreground">These emails are already switched off.</p>
          )}
          {done.isError && (
            <p role="alert" className="text-sm text-danger">
              {describeError(done.error)}
            </p>
          )}
          <Button onClick={() => done.mutate()} loading={done.isPending} className="w-full">
            Unsubscribe
          </Button>
        </div>
      )}
    </AuthLayout>
  );
}

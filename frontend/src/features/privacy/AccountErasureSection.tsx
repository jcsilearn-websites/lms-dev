import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { Badge, Card } from '../../shared/ui/layout';
import { ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import {
  erasureKeys,
  getMyAccountErasure,
  type MyAccountErasure,
  requestAccountErasure,
} from './privacy.erasure.api';

const when = (iso: string) => new Date(iso).toLocaleString();

/**
 * "Erase my whole account". Available while this is the ONE college the person belongs to: the college erasure comes first (an
 * administrator approves it, 7 days of grace), the account follows it. A member of several colleges is told what to do instead.
 */
export function AccountErasureSection() {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [understood, setUnderstood] = useState(false);
  const state = useQuery({
    queryKey: erasureKeys.account,
    queryFn: ({ signal }) => getMyAccountErasure(signal),
    retry: false,
  });
  const ask = useMutation({
    mutationFn: () => requestAccountErasure({ password }),
    onSuccess: (r) => {
      setPassword('');
      setUnderstood(false);
      toast.success(
        r.alreadyInProgress
          ? 'Your earlier request is still open.'
          : 'Your request was sent. An administrator of the college has to approve it.',
      );
      qc.setQueryData<MyAccountErasure>(erasureKeys.account, (cur) =>
        cur ? { ...cur, request: r.request } : cur,
      );
      // the college half is a request of this college too: the card above follows it
      void qc.invalidateQueries({ queryKey: erasureKeys.preview });
    },
    onError: (err) => toast.error(describeError(err)),
  });

  const open = state.data?.request;
  const isOpen =
    open && ['waiting_college', 'pending_approval', 'approved', 'executing'].includes(open.status);

  return (
    <Card title="Erase my whole account">
      {state.isPending ? (
        <ListSkeleton rows={2} label="Loading your account erasure options" />
      ) : state.isError ? (
        <ErrorState error={state.error} onRetry={() => void state.refetch()} />
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            This removes your sign-in itself: your account is replaced by a code, your password and
            all your sign-ins are deleted, and the address you used is released. Every college you
            were a member of shows only that code afterwards. It does not touch any college&apos;s
            academic record: hand-ins, quiz attempts, grades and approved gradebooks stay with the
            college, as described above.
          </p>
          {isOpen ? (
            <div className="space-y-2 rounded-md border border-border p-3" role="status">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="warning">
                  {open.status === 'waiting_college'
                    ? 'Waiting for the college'
                    : open.status === 'approved'
                      ? 'Approved'
                      : 'In progress'}
                </Badge>
                <span className="text-sm font-medium">You asked to erase your whole account.</span>
              </div>
              <p className="text-muted-foreground">
                First the college erasure above is decided by an administrator and, once approved,
                carried out after {7} days. Your account is erased right after that. You can cancel
                the request above until the grace period ends; cancelling it also cancels this.
                {open.expiresAt ? ` If nobody decides it ends on ${when(open.expiresAt)}.` : ''}
              </p>
            </div>
          ) : state.data.eligible ? (
            <form
              noValidate
              className="max-w-sm space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (password && understood) ask.mutate();
              }}
            >
              <Field
                label="Password to confirm your account erasure"
                type="password"
                autoComplete="current-password"
                hint="We ask again so that nobody else can do this from an open session."
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <label className="flex min-h-11 items-start gap-2 sm:min-h-0">
                <input
                  type="checkbox"
                  className="mt-1 size-4"
                  checked={understood}
                  onChange={(e) => setUnderstood(e.target.checked)}
                />
                <span>
                  I understand that my whole account will be erased after the grace period, that I
                  will not be able to sign in again with it, and that it cannot be undone.
                </span>
              </label>
              <Button
                type="submit"
                variant="danger"
                loading={ask.isPending}
                disabled={!password || !understood}
              >
                Ask to erase my whole account
              </Button>
            </form>
          ) : (
            <p role="status">
              {state.data.colleges > 1
                ? `You belong to ${state.data.colleges} colleges, so your whole account cannot be erased from here. Ask to be erased from each college; when you belong to none, the platform team can erase the account itself.`
                : 'Your whole account cannot be erased from here. Ask the platform team.'}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

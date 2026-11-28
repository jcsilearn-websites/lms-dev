import type { MfaResetItem } from '@lms/backend/contracts';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { ConfirmDialog } from '../../shared/ui/dialog';
import { Field } from '../../shared/ui/field';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { decideMfaReset, fileMfaReset, listMfaResets, mfaKeys } from './mfa.api';

const STATUS_TEXT: Record<MfaResetItem['status'], string> = {
  pending_approval: 'Waiting for a decision',
  approved: 'Approved: waiting 24 hours',
  done: 'Reset done',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  expired: 'Expired: nobody decided in 7 days',
};
const TONE: Record<MfaResetItem['status'], 'neutral' | 'success' | 'danger' | 'warning'> = {
  pending_approval: 'warning',
  approved: 'warning',
  done: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
  expired: 'neutral',
};
const REASON: Record<string, string> = {
  subject_signed_in: 'the person signed in with their second step',
  subject_disabled: 'the person turned two-step sign-in off',
  no_factor: 'there was no second step left to reset',
  break_glass: 'reset on the server (break glass)',
};
const when = (iso: string) => new Date(iso).toLocaleString();
const who = (i: MfaResetItem) =>
  i.personEmail ? `${i.personName} (${i.personEmail})` : i.personName;

type Action = 'approve' | 'reject' | 'cancel';
const VERB: Record<Action, string> = { approve: 'Approve', reject: 'Reject', cancel: 'Cancel' };
const DONE: Record<Action, string> = {
  approve: 'Approved. The reset runs in 24 hours.',
  reject: 'Rejected. Nothing was changed.',
  cancel: 'Cancelled. Nothing was changed.',
};

/**
 * Resetting the second factor of a person who lost the phone and the recovery codes. Three different people: one platform
 * administrator files, ANOTHER approves, neither is the person. It runs 24 hours after the approval.
 */
export function MfaResetsPage() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [target, setTarget] = useState<{ item: MfaResetItem; action: Action } | null>(null);
  const list = useInfiniteQuery({
    queryKey: mfaKeys.resets,
    queryFn: ({ pageParam, signal }) => listMfaResets(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: mfaKeys.resets });
  const file = useMutation({
    mutationFn: () => fileMfaReset(email.trim()),
    onSuccess: async () => {
      toast.success('The request was filed. A different platform administrator has to approve it.');
      setEmail('');
      await refresh();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; action: Action }) => decideMfaReset(v.id, v.action),
    onSuccess: async (_r, v) => {
      toast.success(DONE[v.action]);
      setTarget(null);
      await refresh();
    },
    onError: async (err) => {
      toast.error(describeError(err));
      setTarget(null);
      await refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim().length >= 3) file.mutate();
  };
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Two-step sign-in resets"
        description="For a person who lost both the authenticator app and the recovery codes"
      />
      <Card title="File a reset">
        <p className="mb-3 text-sm text-muted-foreground">
          Confirm who is asking by another channel first. The person is e-mailed and can stop the
          reset by signing in with their second step.
        </p>
        <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field
            label="Address of the account"
            name="email"
            type="email"
            className="flex-1"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" loading={file.isPending}>
            File the request
          </Button>
        </form>
      </Card>
      {list.isPending ? (
        <ListSkeleton rows={3} label="Loading reset requests" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="No reset requests" description="Requests you file appear here." />
      ) : (
        <ul aria-label="Reset requests" className="space-y-3">
          {items.map((item) => (
            <li key={item.id} className="rounded-md border border-border bg-surface p-4 text-sm">
              <p className="break-words font-medium">{who(item)}</p>
              <p className="mt-1">
                <Badge tone={TONE[item.status]}>{STATUS_TEXT[item.status]}</Badge>
              </p>
              <p className="mt-1 text-muted-foreground">
                Filed by {item.requestedByName} on {when(item.requestedAt)}
                {item.approvedByName && `, approved by ${item.approvedByName}`}
              </p>
              {item.status === 'approved' && item.executeAfter && (
                <p className="text-muted-foreground">Runs after {when(item.executeAfter)}</p>
              )}
              {item.status === 'pending_approval' && (
                <p className="text-muted-foreground">Expires {when(item.expiresAt)}</p>
              )}
              {item.reason && (
                <p className="text-muted-foreground">
                  Ended because {REASON[item.reason] ?? item.reason}
                </p>
              )}
              {item.status === 'pending_approval' && !item.canApprove && (
                <p className="text-muted-foreground">
                  A different administrator decides: you filed it, or it is your own account.
                </p>
              )}
              {item.canCancel && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {item.canApprove && (
                    <>
                      <Button onClick={() => setTarget({ item, action: 'approve' })}>
                        Approve
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => setTarget({ item, action: 'reject' })}
                      >
                        Reject
                      </Button>
                    </>
                  )}
                  <Button variant="secondary" onClick={() => setTarget({ item, action: 'cancel' })}>
                    Cancel
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <Button
          variant="secondary"
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          Load more
        </Button>
      )}
      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        onConfirm={() => target && decide.mutate({ id: target.item.id, action: target.action })}
        title={
          target
            ? `${VERB[target.action]} the reset of ${target.item.personName}?`
            : 'Decide the request'
        }
        description={
          target?.action === 'approve'
            ? `In 24 hours ${who(target.item)} loses the second step, is signed out everywhere and must choose a new password.`
            : 'Nothing about the account changes.'
        }
        confirmLabel={target ? `${VERB[target.action]} reset` : 'Confirm'}
        pending={decide.isPending}
      />
    </div>
  );
}

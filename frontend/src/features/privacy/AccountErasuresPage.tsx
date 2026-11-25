import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { ConfirmDialog } from '../../shared/ui/dialog';
import { Field } from '../../shared/ui/field';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import {
  decideAccountErasure,
  erasureKeys,
  fileAccountErasure,
  listAccountErasures,
  type PlatformErasureItem,
} from './privacy.erasure.api';

const STATUS_TEXT: Record<string, string> = {
  waiting_college: 'Waiting for the college',
  pending_approval: 'Waiting for a decision',
  approved: 'Approved: grace period running',
  executing: 'Being carried out',
  done: 'Carried out',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
  expired: 'Expired: nobody decided in 30 days',
};
const TONE: Record<string, 'neutral' | 'success' | 'danger' | 'warning'> = {
  waiting_college: 'warning',
  pending_approval: 'warning',
  approved: 'warning',
  executing: 'neutral',
  done: 'success',
  cancelled: 'neutral',
  rejected: 'danger',
  expired: 'neutral',
};
const when = (iso: string) => new Date(iso).toLocaleString();

type Action = 'approve' | 'reject' | 'cancel';
const VERB: Record<Action, string> = { approve: 'Approve', reject: 'Reject', cancel: 'Cancel' };

/**
 * Erasing a GLOBAL account that has no active membership anywhere (the person cannot sign in, so they cannot ask themselves). One
 * platform administrator files the request, a DIFFERENT one approves it; 7 days of grace; either can cancel until then.
 */
export function AccountErasuresPage() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [target, setTarget] = useState<{ item: PlatformErasureItem; action: Action } | null>(null);
  const list = useQuery({
    queryKey: erasureKeys.platform,
    queryFn: ({ signal }) => listAccountErasures(signal),
  });
  const file = useMutation({
    mutationFn: () => fileAccountErasure(email.trim()),
    onSuccess: () => {
      toast.success('The request was filed. A different platform administrator has to approve it.');
      setEmail('');
      void qc.invalidateQueries({ queryKey: erasureKeys.platform });
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; action: Action }) => decideAccountErasure(v.id, v.action),
    onSuccess: (_r, v) => {
      toast.success(
        v.action === 'approve'
          ? 'Approved. The account is erased after the grace period.'
          : v.action === 'reject'
            ? 'Rejected. Nothing was changed.'
            : 'Cancelled. Nothing was changed.',
      );
      setTarget(null);
      void qc.invalidateQueries({ queryKey: erasureKeys.platform });
    },
    onError: (err) => {
      toast.error(describeError(err));
      setTarget(null);
      void qc.invalidateQueries({ queryKey: erasureKeys.platform });
    },
  });

  const actions = (x: PlatformErasureItem): Action[] => {
    if (x.status === 'pending_approval')
      return x.canApprove ? ['approve', 'reject', 'cancel'] : ['cancel'];
    return x.status === 'approved' ? ['cancel'] : [];
  };

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Account erasures"
        description="Erase the account of a person who is no longer a member of any college. You file the request, a different platform administrator approves it."
      />
      <Card title="File a request">
        <form
          noValidate
          className="max-w-md space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) file.mutate();
          }}
        >
          <Field
            label="Address of the account"
            type="email"
            autoComplete="off"
            hint="Only accounts with no active, pending or suspended membership can be erased."
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" loading={file.isPending} disabled={!email.trim()}>
            File the request
          </Button>
        </form>
      </Card>
      <Card title="Requests">
        {list.isPending ? (
          <ListSkeleton rows={3} label="Loading the account erasure requests" />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 ? (
          <EmptyState
            title="No requests"
            description="Requests to erase an account will be listed here."
          />
        ) : (
          <ul className="divide-y divide-border">
            {list.data.items.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {x.personName}
                    {x.personEmail ? ` · ${x.personEmail}` : ''}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Filed {when(x.requestedAt)}
                    {x.requestedByName ? ` by ${x.requestedByName}` : ''}
                    {x.status === 'pending_approval' && x.expiresAt
                      ? ` · ends ${when(x.expiresAt)} if undecided`
                      : ''}
                    {x.status === 'approved' && x.graceUntil
                      ? ` · carried out ${when(x.graceUntil)}`
                      : ''}
                    {x.status === 'done' && x.executedAt
                      ? ` · carried out ${when(x.executedAt)}`
                      : ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={TONE[x.status] ?? 'neutral'}>
                    {STATUS_TEXT[x.status] ?? x.status}
                  </Badge>
                  {actions(x).map((a) => (
                    <Button
                      key={a}
                      variant={a === 'approve' ? 'danger' : 'secondary'}
                      onClick={() => setTarget({ item: x, action: a })}
                    >
                      {VERB[a]}
                    </Button>
                  ))}
                  {x.status === 'pending_approval' && !x.canApprove && (
                    <span className="text-xs text-muted-foreground">
                      A different administrator decides on a request you filed.
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        pending={decide.isPending}
        title={
          target
            ? `${VERB[target.action]} the erasure of the account of ${target.item.personName}?`
            : ''
        }
        confirmLabel={target ? VERB[target.action] : 'Confirm'}
        onConfirm={() => target && decide.mutate({ id: target.item.id, action: target.action })}
        description={
          target?.action === 'approve' ? (
            <>
              After approval there are 7 days in which either of you can still cancel. Then the
              account is replaced by a code, its password and sign-ins are deleted, the address is
              released, and every college where this person was a member shows only a code. It
              cannot be undone. The colleges&apos; academic records are not touched.
            </>
          ) : target?.action === 'reject' ? (
            <>The request ends and nothing is changed.</>
          ) : (
            <>The request ends and nothing is changed.</>
          )
        }
      />
    </div>
  );
}

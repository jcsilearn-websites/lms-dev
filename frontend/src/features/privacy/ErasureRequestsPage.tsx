import type { ErasureStatus } from '@lms/backend/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { ConfirmDialog } from '../../shared/ui/dialog';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { usePermissions } from '../auth/useMe';
import {
  decideErasure,
  type ErasureAdminItem,
  erasureKeys,
  listErasureRequests,
} from './privacy.erasure.api';

const STATUS_TEXT: Record<ErasureStatus, string> = {
  pending_approval: 'Waiting for a decision',
  approved: 'Approved: grace period running',
  executing: 'Being carried out',
  done: 'Carried out',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
  expired: 'Expired: nobody decided in 30 days',
};
const TONE: Record<ErasureStatus, 'neutral' | 'success' | 'danger' | 'warning'> = {
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
 * The college's erasure requests. An administrator never decides on their own request (the database refuses it too). Approving starts
 * 7 days of grace; the erasure itself is carried out by the worker afterwards and cannot be undone.
 */
export function ErasureRequestsPage() {
  const qc = useQueryClient();
  const { me } = usePermissions();
  const [target, setTarget] = useState<{ item: ErasureAdminItem; action: Action } | null>(null);
  const list = useQuery({
    queryKey: erasureKeys.admin,
    queryFn: ({ signal }) => listErasureRequests(signal),
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; action: Action }) => decideErasure(v.id, v.action),
    onSuccess: (r, v) => {
      toast.success(
        v.action === 'approve'
          ? 'Approved. The erasure is carried out after the grace period.'
          : v.action === 'reject'
            ? 'Rejected. The member was told.'
            : 'Cancelled. Nothing was changed.',
      );
      qc.setQueryData<{ items: ErasureAdminItem[] }>(erasureKeys.admin, (cur) =>
        cur ? { items: cur.items.map((x) => (x.id === v.id ? { ...x, ...r.request } : x)) } : cur,
      );
      setTarget(null);
    },
    onError: (err) => {
      toast.error(describeError(err));
      setTarget(null);
      void qc.invalidateQueries({ queryKey: erasureKeys.admin });
    },
  });

  const actions = (x: ErasureAdminItem): Action[] =>
    x.status === 'pending_approval'
      ? ['approve', 'reject', 'cancel']
      : x.status === 'approved'
        ? ['cancel']
        : [];

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Erasure requests"
        description="Members who asked to be erased from this college. You decide; you cannot decide on your own request."
      />
      <Card>
        {list.isPending ? (
          <ListSkeleton rows={3} label="Loading the erasure requests" />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 ? (
          <EmptyState
            title="No requests"
            description="Requests to be erased will be listed here."
          />
        ) : (
          <ul className="divide-y divide-border">
            {list.data.items.map((x) => {
              const own = me?.user.email === x.memberEmail;
              return (
                <li key={x.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {x.memberName}
                      {x.withAccount ? ' · and their whole account' : ''}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Asked {when(x.requestedAt)}
                      {x.status === 'pending_approval' && x.expiresAt
                        ? ` · ends ${when(x.expiresAt)} if undecided`
                        : ''}
                      {x.status === 'approved' && x.graceUntil
                        ? ` · carried out ${when(x.graceUntil)}`
                        : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={TONE[x.status]}>{STATUS_TEXT[x.status]}</Badge>
                    {actions(x)
                      .filter((a) => !(own && a !== 'cancel'))
                      .map((a) => (
                        <Button
                          key={a}
                          variant={a === 'approve' ? 'danger' : 'secondary'}
                          onClick={() => setTarget({ item: x, action: a })}
                        >
                          {VERB[a]}
                        </Button>
                      ))}
                    {own && x.status === 'pending_approval' && (
                      <span className="text-xs text-muted-foreground">
                        Another administrator decides on your request.
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        pending={decide.isPending}
        title={target ? `${VERB[target.action]} the request of ${target.item.memberName}?` : ''}
        confirmLabel={target ? VERB[target.action] : 'Confirm'}
        onConfirm={() => target && decide.mutate({ id: target.item.id, action: target.action })}
        description={
          target?.action === 'approve' ? (
            <>
              After approval there are 7 days in which {target.item.memberName} or an administrator
              can still cancel. Then the member&apos;s name, contact details, sign-ins and
              notifications are removed, the member can no longer sign in to this college, and it
              cannot be undone. Their submissions, quiz attempts, grades and progress, the approved
              gradebooks and the audit trail are kept, as described to the member.
              {target.item.withAccount
                ? ' The member also asked for their whole account to be erased: it follows right after, with its sign-in, its password and the name it shows in every college.'
                : ''}
            </>
          ) : target?.action === 'reject' ? (
            <>The member is told that the request was not approved. Nothing is changed.</>
          ) : (
            <>The request ends and nothing is changed. The member is told.</>
          )
        }
      />
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError } from '../../shared/api/client';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { ConfirmDialog } from '../../shared/ui/dialog';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { usePermissions } from '../auth/useMe';
import { dropMember, putMember } from './cache';
import { STATUS_TONE } from './MembersPage';
import {
  changeRole,
  getMember,
  getProfile,
  memberKeys,
  reactivateMember,
  removeMember,
  resendInvite,
  suspendMember,
  unlockMember,
} from './members.api';
import { ProfileCard } from './ProfileCard';

type Confirm = null | 'suspend' | 'remove';

/** One mutation with a success toast (naming the person) and an error toast with the server message. */
function useAction<T>(fn: () => Promise<T>, done: (r: T) => void, message: string) {
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      done(r);
      toast.success(message);
    },
    onError: (err) => toast.error(describeError(err)),
  });
}

export function MemberDetailPage() {
  const { userId } = useParams({ strict: false }) as { userId: string };
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { me, has } = usePermissions();
  const [confirm, setConfirm] = useState<Confirm>(null);

  // member and profile are independent: both start at once
  const member = useQuery({
    queryKey: memberKeys.detail(userId),
    queryFn: ({ signal }) => getMember(userId, signal),
  });
  const profile = useQuery({
    queryKey: memberKeys.profile(userId),
    queryFn: ({ signal }) => getProfile(userId, signal),
    enabled: has('profile.manage'),
    retry: false,
  });

  const m = member.data;
  const name = m?.displayName ?? 'this member';
  const isSelf = me?.user.id === userId;

  const role = useAction(
    () => changeRole(userId, m?.role === 'member' ? 'institution_admin' : 'member'),
    (r) => putMember(qc, r),
    'Role changed.',
  );
  const suspend = useAction(
    () => suspendMember(userId),
    (r) => {
      putMember(qc, r);
      setConfirm(null);
    },
    `${name} is suspended.`,
  );
  const reactivate = useAction(
    () => reactivateMember(userId),
    (r) => putMember(qc, r),
    `${name} is active again.`,
  );
  const remove = useAction(
    () => removeMember(userId),
    () => {
      dropMember(qc, userId);
      setConfirm(null);
      void navigate({ to: '/members' as '/' });
    },
    `${name} was removed from the college.`,
  );
  const unlock = useAction(
    () => unlockMember(userId),
    () => undefined,
    `${name} can sign in again.`,
  );
  const resend = useAction(
    () => resendInvite(userId),
    () => undefined,
    'Invitation sent again.',
  );

  if (member.isPending) return <ListSkeleton rows={4} label="Loading member" />;
  if (member.isError) {
    const notFound = member.error instanceof ApiError && member.error.status === 404;
    return (
      <ErrorState
        error={member.error}
        title={notFound ? 'This member does not exist' : 'Could not load this member'}
        onRetry={notFound ? undefined : () => void member.refetch()}
      />
    );
  }
  if (!m) return null;

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link to={'/members' as '/'} className="text-primary underline">
          Back to members
        </Link>
      </p>
      <PageHeader title={m.displayName} description={m.email} />
      <div className="flex flex-wrap gap-2">
        <Badge>{m.role === 'institution_admin' ? 'Institution admin' : 'Member'}</Badge>
        <Badge tone={STATUS_TONE[m.status]}>{m.status}</Badge>
        {m.profileType && <Badge>{m.profileType}</Badge>}
      </div>

      <Card title="Account">
        {isSelf && (
          <p className="mb-3 text-sm text-muted-foreground">
            This is you. You cannot change your own role, suspend or remove yourself.
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          {has('member.update_role') && (
            <div className="flex items-end gap-2">
              <p className="text-sm">
                Role:{' '}
                <strong>{m.role === 'institution_admin' ? 'Institution admin' : 'Member'}</strong>
              </p>
              <Button
                variant="secondary"
                disabled={isSelf || m.status === 'pending'}
                loading={role.isPending}
                onClick={() => role.mutate()}
              >
                {m.role === 'member' ? 'Make institution admin' : 'Make member'}
              </Button>
            </div>
          )}
          {has('member.suspend') &&
            (m.status === 'suspended' ? (
              <Button
                variant="secondary"
                loading={reactivate.isPending}
                onClick={() => reactivate.mutate()}
              >
                Reactivate
              </Button>
            ) : (
              <Button variant="secondary" disabled={isSelf} onClick={() => setConfirm('suspend')}>
                Suspend
              </Button>
            ))}
          {has('member.unlock') && (
            <Button variant="secondary" loading={unlock.isPending} onClick={() => unlock.mutate()}>
              Unlock sign-in
            </Button>
          )}
          {has('member.invite') && m.status === 'pending' && (
            <Button variant="secondary" loading={resend.isPending} onClick={() => resend.mutate()}>
              Resend invitation
            </Button>
          )}
          {has('member.remove') && (
            <Button variant="danger" disabled={isSelf} onClick={() => setConfirm('remove')}>
              Remove from college
            </Button>
          )}
        </div>
      </Card>

      {has('profile.manage') && <ProfileCard userId={userId} member={m} profile={profile} />}

      <ConfirmDialog
        open={confirm === 'suspend'}
        onClose={() => setConfirm(null)}
        onConfirm={() => suspend.mutate()}
        pending={suspend.isPending}
        title={`Suspend ${m.displayName}?`}
        description={`${m.displayName} will be signed out and cannot sign in until you reactivate them.`}
        confirmLabel={`Suspend ${m.displayName}`}
      />
      <ConfirmDialog
        open={confirm === 'remove'}
        onClose={() => setConfirm(null)}
        onConfirm={() => remove.mutate()}
        pending={remove.isPending}
        title={`Remove ${m.displayName}?`}
        description={`${m.displayName} (${m.email}) loses access to this college. Their account stays; they can be invited again.`}
        confirmLabel={`Remove ${m.displayName}`}
      />
    </div>
  );
}

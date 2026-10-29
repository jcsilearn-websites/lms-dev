import {
  AdminInviteRequestSchema,
  type Member,
  type MemberListResponse,
  UpdateTenantRequestSchema,
} from '@lms/backend/contracts';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ApiError } from '../../shared/api/client';
import { describeError } from '../../shared/api/errors';
import { typeboxResolver } from '../../shared/forms/validation';
import { Button } from '../../shared/ui/button';
import { DataTable } from '../../shared/ui/data-table';
import { ConfirmDialog, Dialog } from '../../shared/ui/dialog';
import { Field } from '../../shared/ui/field';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import {
  getTenant,
  inviteTenantAdmin,
  platformKeys,
  reactivateTenant,
  renameTenant,
  suspendTenant,
  tenantMembers,
} from './platform.api';

export function CollegeDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<null | 'rename' | 'invite' | 'suspend'>(null);
  const [showMembers, setShowMembers] = useState(false);

  const detail = useQuery({
    queryKey: platformKeys.detail(id),
    queryFn: ({ signal }) => getTenant(id, signal),
  });
  const t = detail.data;

  // the list endpoints return the plain tenant; keep the detail (with counts) and patch its fields
  const patch = (next: { name: string; status: 'active' | 'suspended'; updatedAt: string }) => {
    qc.setQueryData(platformKeys.detail(id), (old: typeof t) => (old ? { ...old, ...next } : old));
    void qc.invalidateQueries({ queryKey: platformKeys.all, refetchType: 'none' });
  };
  const suspend = useMutation({
    mutationFn: () => suspendTenant(id),
    onSuccess: (r) => {
      patch(r);
      setDialog(null);
      toast.success(`${r.name} is suspended. Its people are signed out.`);
    },
    onError: (err) => {
      setDialog(null);
      toast.error(describeError(err));
    },
  });
  const reactivate = useMutation({
    mutationFn: () => reactivateTenant(id),
    onSuccess: (r) => {
      patch(r);
      toast.success(`${r.name} is active again.`);
    },
    onError: (err) => toast.error(describeError(err)),
  });

  if (detail.isPending) return <ListSkeleton rows={4} label="Loading college" />;
  if (detail.isError) {
    const gone = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <ErrorState
        error={detail.error}
        title={gone ? 'This college does not exist' : 'Could not load this college'}
        onRetry={gone ? undefined : () => void detail.refetch()}
      />
    );
  }
  if (!t) return null;

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link to={'/colleges' as '/'} className="text-primary underline">
          All colleges
        </Link>
      </p>
      <PageHeader
        title={t.name}
        description={`Address: ${t.slug}`}
        actions={<Badge tone={t.status === 'active' ? 'success' : 'danger'}>{t.status}</Badge>}
      />
      <Card title="Overview">
        <dl className="mb-4 grid grid-cols-2 gap-3 text-center sm:max-w-sm">
          <div className="rounded-md border border-border p-3">
            <dd className="text-2xl font-semibold">{t.members}</dd>
            <dt className="text-xs text-muted-foreground">Members</dt>
          </div>
          <div className="rounded-md border border-border p-3">
            <dd className="text-2xl font-semibold">{t.activeAdmins}</dd>
            <dt className="text-xs text-muted-foreground">Active admins</dt>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setDialog('rename')}>
            Rename
          </Button>
          <Button variant="secondary" onClick={() => setDialog('invite')}>
            Invite an admin
          </Button>
          {t.status === 'active' ? (
            <Button variant="danger" onClick={() => setDialog('suspend')}>
              Suspend college
            </Button>
          ) : (
            <Button
              variant="secondary"
              loading={reactivate.isPending}
              onClick={() => reactivate.mutate()}
            >
              Reactivate college
            </Button>
          )}
        </div>
      </Card>

      <Card title="Members (read only)">
        {showMembers ? (
          <Members id={id} />
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Looking at a college's members is recorded in the audit log of the college and of the
              platform.
            </p>
            <Button variant="secondary" onClick={() => setShowMembers(true)}>
              Show members
            </Button>
          </div>
        )}
      </Card>

      {dialog === 'rename' && (
        <RenameDialog
          id={id}
          current={t.name}
          onClose={() => setDialog(null)}
          onSaved={(r) => {
            patch(r);
            setDialog(null);
            toast.success(`Renamed to ${r.name}.`);
          }}
        />
      )}
      {dialog === 'invite' && <InviteAdminDialog id={id} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog === 'suspend'}
        onClose={() => setDialog(null)}
        pending={suspend.isPending}
        onConfirm={() => suspend.mutate()}
        title={`Suspend ${t.name}?`}
        description={`Everyone in ${t.name} is signed out and the college address stops working until you reactivate it.`}
        confirmLabel={`Suspend ${t.name}`}
      />
    </div>
  );
}

function Members({ id }: { id: string }) {
  const list = useInfiniteQuery<
    MemberListResponse,
    Error,
    InfiniteData<MemberListResponse, string | undefined>,
    ReturnType<typeof platformKeys.members>,
    string | undefined
  >({
    queryKey: platformKeys.members(id),
    queryFn: ({ pageParam, signal }) => tenantMembers(id, pageParam, signal),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 0,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  if (list.isPending) return <ListSkeleton rows={4} label="Loading members" />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  return (
    <>
      <DataTable<Member>
        caption="Members of the college"
        rows={rows}
        rowKey={(m) => m.id}
        columns={[
          { header: 'Name', cell: (m) => m.displayName },
          { header: 'Email', cell: (m) => m.email },
          {
            header: 'Role',
            cell: (m) => (m.role === 'institution_admin' ? 'Institution admin' : 'Member'),
          },
          { header: 'Status', cell: (m) => m.status },
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
  );
}

function RenameDialog({
  id,
  current,
  onClose,
  onSaved,
}: {
  id: string;
  current: string;
  onClose: () => void;
  onSaved: (r: { name: string; status: 'active' | 'suspended'; updatedAt: string }) => void;
}) {
  const form = useForm<{ name: string }>({
    defaultValues: { name: current },
    resolver: typeboxResolver<{ name: string }>(UpdateTenantRequestSchema, {
      name: 'College name',
    }),
  });
  const save = useMutation({
    mutationFn: (v: { name: string }) => renameTenant(id, v.name.trim()),
    onSuccess: onSaved,
    onError: (err) => toast.error(describeError(err)),
  });
  return (
    <Dialog open onClose={onClose} title="Rename the college">
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate className="space-y-4">
        <Field
          label="College name"
          error={form.formState.errors.name?.message}
          {...form.register('name')}
        />
        <p className="text-xs text-muted-foreground">The web address does not change.</p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function InviteAdminDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const form = useForm<{ email: string; displayName: string }>({
    defaultValues: { email: '', displayName: '' },
    resolver: typeboxResolver(AdminInviteRequestSchema),
  });
  const invite = useMutation({
    mutationFn: (v: { email: string; displayName: string }) => inviteTenantAdmin(id, v),
    onSuccess: (r, v) => {
      toast.success(
        r.outcome === 'promoted'
          ? `${v.email} is now an institution admin and was notified.`
          : `Invitation sent to ${v.email}.`,
      );
      void qc.invalidateQueries({ queryKey: platformKeys.detail(id) });
      onClose();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const { errors } = form.formState;
  return (
    <Dialog open onClose={onClose} title="Invite an institution admin">
      <form onSubmit={form.handleSubmit((v) => invite.mutate(v))} noValidate className="space-y-4">
        <Field label="Name" error={errors.displayName?.message} {...form.register('displayName')} />
        <Field
          label="Email"
          type="email"
          error={errors.email?.message}
          {...form.register('email')}
        />
        <p className="text-xs text-muted-foreground">
          If this person is already an active member, they become an institution admin and their
          sessions in this college are signed out.
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={invite.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={invite.isPending}>
            Send
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

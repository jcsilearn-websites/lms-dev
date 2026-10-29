import { ChangePasswordRequestSchema, type ProfileDto } from '@lms/backend/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { ApiError, api } from '../../shared/api/client';
import { describeError } from '../../shared/api/errors';
import { typeboxResolver } from '../../shared/forms/validation';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { ErrorState, ListSkeleton, Skeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { changePassword, listSessions, revokeSession } from '../auth/auth.api';
import { usePermissions } from '../auth/useMe';

const sessionsKey = ['sessions'] as const;

export function MePage() {
  const { me, has } = usePermissions();
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="My account"
        description={me ? `${me.user.displayName} (${me.user.email})` : undefined}
      />
      {has('profile.read_own') && <MyProfile />}
      <ChangePassword />
      <Sessions />
    </div>
  );
}

function MyProfile() {
  const profile = useQuery({
    queryKey: ['me', 'profile'],
    queryFn: ({ signal }) => api<ProfileDto>('/me/profile', { signal }),
    retry: false,
  });
  const none = profile.error instanceof ApiError && profile.error.status === 404;
  const p = profile.data;
  return (
    <Card title="My profile">
      {profile.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : none ? (
        <p className="text-sm text-muted-foreground">
          Your college has not set up your profile yet.
        </p>
      ) : profile.isError ? (
        <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />
      ) : p ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {(
            [
              ['Type', p.profileType],
              ['Phone', p.phone],
              ['Register number', p.registerNumber],
              ['Employee id', p.employeeId],
              ['Department', p.departmentCode],
              ['Program', p.programName ? `${p.programName} (${p.programCode})` : p.programCode],
              ['Batch', p.batchLabel],
              ['Section', p.sectionCode],
            ] as const
          )
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
        </dl>
      ) : null}
    </Card>
  );
}

interface PwValues {
  currentPassword: string;
  newPassword: string;
  confirm: string;
}

function ChangePassword() {
  const form = useForm<PwValues>({
    defaultValues: { currentPassword: '', newPassword: '', confirm: '' },
    resolver: async (values, ctx, opts) => {
      const result = await typeboxResolver<PwValues>(ChangePasswordRequestSchema)(
        { currentPassword: values.currentPassword, newPassword: values.newPassword } as never,
        ctx,
        opts,
      );
      const errors = { ...result.errors } as Record<string, { type: string; message: string }>;
      if (!errors.confirm && values.newPassword !== values.confirm) {
        errors.confirm = { type: 'validate', message: 'The two passwords do not match.' };
      }
      return Object.keys(errors).length > 0 ? { values: {}, errors } : { values, errors: {} };
    },
  });
  const save = useMutation({
    mutationFn: (v: PwValues) => changePassword(v.currentPassword, v.newPassword),
    onSuccess: () => {
      toast.success('Your password was changed. Your other sessions were signed out.');
      form.reset();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const { errors } = form.formState;
  return (
    <Card title="Change password">
      <form
        onSubmit={form.handleSubmit((v) => save.mutate(v))}
        noValidate
        className="max-w-sm space-y-4"
      >
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          error={errors.currentPassword?.message}
          {...form.register('currentPassword')}
        />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters."
          error={errors.newPassword?.message}
          {...form.register('newPassword')}
        />
        <Field
          label="Repeat the new password"
          type="password"
          autoComplete="new-password"
          error={errors.confirm?.message}
          {...form.register('confirm')}
        />
        <Button type="submit" loading={save.isPending}>
          Change password
        </Button>
      </form>
    </Card>
  );
}

function Sessions() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: sessionsKey, queryFn: () => listSessions() });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeSession(id),
    onSuccess: (_a, id) => {
      // drop just that row
      qc.setQueryData<typeof sessions.data>(sessionsKey, (old) =>
        old ? { ...old, items: old.items.filter((s) => s.id !== id) } : old,
      );
      toast.success('That session was signed out.');
    },
    onError: (err) => toast.error(describeError(err)),
  });
  return (
    <Card title="My sessions">
      {sessions.isPending ? (
        <ListSkeleton rows={2} label="Loading sessions" />
      ) : sessions.isError ? (
        <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : (
        <ul className="divide-y divide-border">
          {sessions.data.items.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {s.userAgent ?? 'Unknown device'}
                </span>
                <span className="block text-muted-foreground">
                  {s.ip ?? 'unknown address'}, last active {new Date(s.lastSeenAt).toLocaleString()}
                </span>
              </span>
              {s.current ? (
                <Badge tone="success">this device</Badge>
              ) : (
                <Button
                  variant="secondary"
                  loading={revoke.isPending && revoke.variables === s.id}
                  onClick={() => revoke.mutate(s.id)}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

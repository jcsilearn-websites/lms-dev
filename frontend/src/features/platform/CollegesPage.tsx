import { CreateTenantRequestSchema, type TenantDto, type TenantList } from '@lms/backend/contracts';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { describeError } from '../../shared/api/errors';
import { typeboxResolver } from '../../shared/forms/validation';
import { Button } from '../../shared/ui/button';
import { DataTable } from '../../shared/ui/data-table';
import { Dialog } from '../../shared/ui/dialog';
import { Field, INPUT_CLASS } from '../../shared/ui/field';
import { Badge, PageHeader } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { createTenant, listTenants, platformKeys } from './platform.api';

type Data = InfiniteData<TenantList, string | undefined>;

export function CollegesPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const list = useInfiniteQuery<
    TenantList,
    Error,
    Data,
    ReturnType<typeof platformKeys.list>,
    string | undefined
  >({
    queryKey: platformKeys.list(debounced),
    queryFn: ({ pageParam, signal }) => listTenants(debounced, pageParam, signal),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div>
      <PageHeader
        title="Colleges"
        description="Every college on the platform."
        actions={<Button onClick={() => setCreating(true)}>Create college</Button>}
      />
      <div className="mb-4 max-w-md">
        <label htmlFor="college-search" className="sr-only">
          Search colleges by name or address
        </label>
        <input
          id="college-search"
          type="search"
          className={INPUT_CLASS}
          placeholder="Search by name or address (2+ letters)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {list.isPending ? (
        <ListSkeleton label="Loading colleges" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No colleges found" />
      ) : (
        <>
          <DataTable<TenantDto>
            caption="Colleges"
            rows={rows}
            rowKey={(t) => t.id}
            columns={[
              {
                header: 'Name',
                cell: (t) => (
                  <Link to={`/colleges/${t.id}` as '/'} className="text-primary underline">
                    {t.name}
                  </Link>
                ),
              },
              { header: 'Address', cell: (t) => t.slug },
              {
                header: 'Status',
                cell: (t) => (
                  <Badge tone={t.status === 'active' ? 'success' : 'danger'}>{t.status}</Badge>
                ),
              },
              { header: 'Created', cell: (t) => new Date(t.createdAt).toLocaleDateString() },
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
      )}
      {creating && (
        <CreateCollegeDialog
          onClose={() => setCreating(false)}
          onCreated={() => void qc.invalidateQueries({ queryKey: platformKeys.all })}
        />
      )}
    </div>
  );
}

interface Values {
  name: string;
  slug: string;
  adminEmail: string;
  adminName: string;
}

function CreateCollegeDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const form = useForm<Values>({
    defaultValues: { name: '', slug: '', adminEmail: '', adminName: '' },
    resolver: typeboxResolver<Values>(CreateTenantRequestSchema, {
      name: 'College name',
      slug: 'Web address',
      adminName: "First admin's name",
      adminEmail: "First admin's email",
    }),
  });
  const create = useMutation({
    mutationFn: (v: Values) => createTenant({ ...v, slug: v.slug.trim().toLowerCase() }),
    onSuccess: (r) => {
      toast.success(
        `${r.tenant.name} was created and ${form.getValues('adminEmail')} was invited as its first admin.`,
      );
      onCreated();
      onClose();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const { errors } = form.formState;
  return (
    <Dialog open onClose={onClose} title="Create a college">
      <form onSubmit={form.handleSubmit((v) => create.mutate(v))} noValidate className="space-y-4">
        <Field label="College name" error={errors.name?.message} {...form.register('name')} />
        <Field
          label="Web address"
          hint="Lowercase letters, digits and hyphens, 3-63 characters. It cannot be changed later."
          autoCapitalize="none"
          error={errors.slug?.message}
          {...form.register('slug')}
        />
        <Field
          label="First admin's name"
          error={errors.adminName?.message}
          {...form.register('adminName')}
        />
        <Field
          label="First admin's email"
          type="email"
          error={errors.adminEmail?.message}
          {...form.register('adminEmail')}
        />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create and send the invitation
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

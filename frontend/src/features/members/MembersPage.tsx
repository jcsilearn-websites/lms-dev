import type { Member, MemberListResponse } from '@lms/backend/contracts';
import { type InfiniteData, useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Button } from '../../shared/ui/button';
import { DataTable } from '../../shared/ui/data-table';
import { INPUT_CLASS } from '../../shared/ui/field';
import { Badge, PageHeader } from '../../shared/ui/layout';
import { Select } from '../../shared/ui/select';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { useAcademicOptions } from '../academics/useOptions';
import { usePermissions } from '../auth/useMe';
import { listMembers, type MemberFilters, memberKeys } from './members.api';

// the invite form (react-hook-form + the contract schemas) is only needed once someone clicks "Invite"
const InviteMemberDialog = lazy(() =>
  import('./InviteMemberDialog').then((m) => ({ default: m.InviteMemberDialog })),
);

export const STATUS_TONE = { active: 'success', pending: 'warning', suspended: 'danger' } as const;

const FILTER_KEYS = [
  'q',
  'role',
  'status',
  'profileType',
  'departmentId',
  'programId',
  'batchId',
  'sectionId',
] as const;

/** Reads the filters from the URL (shareable, survives reload) and writes them back. */
function useFilters() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const filters: MemberFilters = {};
  for (const k of FILTER_KEYS) {
    const v = search[k];
    if (typeof v === 'string' && v) filters[k] = v;
  }
  const set = (patch: Partial<Record<(typeof FILTER_KEYS)[number], string | undefined>>) =>
    navigate({
      to: '/members' as '/',
      search: ((prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        for (const k of FILTER_KEYS) if (!next[k]) delete next[k];
        return next;
      }) as never,
      replace: true,
    });
  return { filters, set };
}

export function MembersPage() {
  const { filters, set } = useFilters();
  const { has } = usePermissions();
  const [inviting, setInviting] = useState(false);
  const [q, setQ] = useState(filters.q ?? '');

  // search box: wait 300 ms after the last keystroke before it goes to the URL (and the API)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onSearchInput = (value: string) => {
    setQ(value);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void set({ q: value || undefined }), 300);
  };
  useEffect(() => () => clearTimeout(debounce.current), []);

  // Both start in the same render: the list and the department options never wait for each other.
  const list = useInfiniteQuery<
    MemberListResponse,
    Error,
    InfiniteData<MemberListResponse, string | undefined>,
    ReturnType<typeof memberKeys.list>,
    string | undefined
  >({
    queryKey: memberKeys.list(filters),
    queryFn: ({ pageParam, signal }) => listMembers(filters, pageParam, signal),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const options = useAcademicOptions(filters);

  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const sel = (
    label: string,
    key: (typeof FILTER_KEYS)[number],
    children: React.ReactNode,
    disabled = false,
  ) => (
    <Select
      label={label}
      hideLabel
      value={filters[key] ?? ''}
      disabled={disabled}
      onChange={(e) => {
        const value = e.target.value || undefined;
        // changing a step of the cascade clears every step below it
        const reset: Partial<Record<(typeof FILTER_KEYS)[number], undefined>> =
          key === 'departmentId'
            ? { programId: undefined, batchId: undefined, sectionId: undefined }
            : key === 'programId'
              ? { batchId: undefined, sectionId: undefined }
              : key === 'batchId'
                ? { sectionId: undefined }
                : {};
        void set({ ...reset, [key]: value });
      }}
    >
      {children}
    </Select>
  );

  return (
    <div>
      <PageHeader
        title="Members"
        description="Everyone in your college. Search, filter and open a person to manage them."
        actions={
          has('member.invite') && <Button onClick={() => setInviting(true)}>Invite member</Button>
        }
      />

      {/* biome-ignore lint/a11y/useSemanticElements: a labelled form with role=search is the landmark pattern for filters */}
      <form
        role="search"
        aria-label="Filter members"
        className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="sm:col-span-2">
          <label htmlFor="member-search" className="sr-only">
            Search by name or email
          </label>
          <input
            id="member-search"
            type="search"
            className={INPUT_CLASS}
            placeholder="Search by name or email (2+ letters)"
            value={q}
            onChange={(e) => onSearchInput(e.target.value)}
          />
        </div>
        {sel(
          'Role',
          'role',
          <>
            <option value="">All roles</option>
            <option value="institution_admin">Institution admin</option>
            <option value="member">Member</option>
          </>,
        )}
        {sel(
          'Status',
          'status',
          <>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="pending">Pending</option>
            <option value="suspended">Suspended</option>
          </>,
        )}
        {sel(
          'Profile type',
          'profileType',
          <>
            <option value="">All profile types</option>
            <option value="student">Student</option>
            <option value="faculty">Faculty</option>
            <option value="staff">Staff</option>
          </>,
        )}
        {sel(
          'Department',
          'departmentId',
          <>
            <option value="">All departments</option>
            {options.departments.data?.items.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} - {d.name}
              </option>
            ))}
          </>,
        )}
        {sel(
          'Program',
          'programId',
          <>
            <option value="">
              {filters.departmentId ? 'All programs' : 'Program (pick a department)'}
            </option>
            {options.programs.data?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code}
              </option>
            ))}
          </>,
          !filters.departmentId,
        )}
        {sel(
          'Batch',
          'batchId',
          <>
            <option value="">{filters.programId ? 'All batches' : 'Batch (pick a program)'}</option>
            {options.batches.data?.items.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </>,
          !filters.programId,
        )}
        {sel(
          'Section',
          'sectionId',
          <>
            <option value="">{filters.batchId ? 'All sections' : 'Section (pick a batch)'}</option>
            {options.sections.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code}
              </option>
            ))}
          </>,
          !filters.batchId,
        )}
      </form>
      {options.truncated && (
        <p className="mb-3 text-xs text-muted-foreground">
          A filter list shows only its first 100 entries.
        </p>
      )}

      {list.isPending ? (
        <ListSkeleton label="Loading members" />
      ) : list.isError ? (
        <ErrorState
          error={list.error}
          onRetry={() => void list.refetch()}
          title="Could not load members"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No members found"
          description={
            Object.keys(filters).length
              ? 'Try removing a filter.'
              : 'Invite people or import a CSV file.'
          }
        />
      ) : (
        <>
          <DataTable<Member>
            caption="Members"
            rows={rows}
            rowKey={(m) => m.id}
            columns={[
              {
                header: 'Name',
                cell: (m) => (
                  <Link to={`/members/${m.userId}` as '/'} className="text-primary underline">
                    {m.displayName}
                  </Link>
                ),
              },
              { header: 'Email', cell: (m) => m.email },
              {
                header: 'Role',
                cell: (m) => (m.role === 'institution_admin' ? 'Institution admin' : 'Member'),
              },
              {
                header: 'Status',
                cell: (m) => <Badge tone={STATUS_TONE[m.status]}>{m.status}</Badge>,
              },
              { header: 'Profile', cell: (m) => m.profileType ?? '-' },
              {
                header: 'Register / employee no.',
                cell: (m) => m.registerNumber ?? m.employeeId ?? '-',
              },
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

      {inviting && (
        <Suspense fallback={null}>
          <InviteMemberDialog open onClose={() => setInviting(false)} />
        </Suspense>
      )}
    </div>
  );
}

import type { AuditEntryDto, AuditListResponse } from '@lms/backend/contracts';
import { type InfiniteData, useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../shared/api/client';
import { Button } from '../../shared/ui/button';
import { DataTable } from '../../shared/ui/data-table';
import { Field } from '../../shared/ui/field';
import { PageHeader } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';

interface Filters {
  action: string;
  from: string;
  to: string;
}

/** datetime-local gives "2026-10-29T10:00" in local time; the API wants an ISO instant. */
const iso = (local: string) => (local ? new Date(local).toISOString() : undefined);

/** The audit log (college or platform: same shape, different endpoint), filtered and keyset paged. */
export function AuditLog({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}) {
  const [draft, setDraft] = useState<Filters>({ action: '', from: '', to: '' });
  const [applied, setApplied] = useState<Filters>(draft);

  const list = useInfiniteQuery<
    AuditListResponse,
    Error,
    InfiniteData<AuditListResponse, string | undefined>,
    readonly unknown[],
    string | undefined
  >({
    queryKey: ['audit', path, applied],
    queryFn: ({ pageParam, signal }) =>
      api<AuditListResponse>(path, {
        signal,
        query: {
          action: applied.action.trim() || undefined,
          from: iso(applied.from),
          to: iso(applied.to),
          limit: 50,
          after: pageParam,
        },
      }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div>
      <PageHeader title={title} description={description} />
      <form
        aria-label="Filter the audit log"
        className="mb-4 grid gap-2 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(draft);
        }}
      >
        <Field
          label="Action"
          placeholder="e.g. member.suspended"
          value={draft.action}
          onChange={(e) => setDraft({ ...draft, action: e.target.value })}
        />
        <Field
          label="From"
          type="datetime-local"
          value={draft.from}
          onChange={(e) => setDraft({ ...draft, from: e.target.value })}
        />
        <Field
          label="To"
          type="datetime-local"
          value={draft.to}
          onChange={(e) => setDraft({ ...draft, to: e.target.value })}
        />
        <div className="flex items-end gap-2">
          <Button type="submit">Apply</Button>
          <Button
            variant="secondary"
            onClick={() => {
              const empty = { action: '', from: '', to: '' };
              setDraft(empty);
              setApplied(empty);
            }}
          >
            Clear
          </Button>
        </div>
      </form>

      {list.isPending ? (
        <ListSkeleton label="Loading the audit log" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No entries" description="Nothing matches these filters." />
      ) : (
        <>
          <DataTable<AuditEntryDto>
            caption="Audit log"
            rows={rows}
            rowKey={(r) => r.id}
            columns={[
              { header: 'When', cell: (r) => new Date(r.createdAt).toLocaleString() },
              { header: 'Action', cell: (r) => <code className="text-xs">{r.action}</code> },
              {
                header: 'Target',
                cell: (r) => `${r.targetType}${r.targetId ? ` ${r.targetId.slice(0, 8)}` : ''}`,
              },
              {
                header: 'By',
                cell: (r) =>
                  r.actorName ? (
                    <span>
                      {r.actorName}
                      {r.actorEmail && (
                        <span className="block text-xs text-muted-foreground">{r.actorEmail}</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">System</span>
                  ),
              },
              {
                header: 'Details',
                cell: (r) =>
                  Object.keys(r.metadata).length === 0 ? (
                    '-'
                  ) : (
                    <details>
                      <summary className="cursor-pointer text-primary underline">Show</summary>
                      <pre className="mt-1 max-w-md overflow-x-auto whitespace-pre-wrap text-xs">
                        {JSON.stringify(r.metadata, null, 2)}
                      </pre>
                    </details>
                  ),
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
    </div>
  );
}

export function CollegeAuditPage() {
  return (
    <AuditLog title="Audit log" description="Who changed what in your college." path="/audit" />
  );
}

export function PlatformAuditPage() {
  return (
    <AuditLog
      title="Platform audit log"
      description="Actions taken on the platform, including every access to a college's members."
      path="/platform/audit"
    />
  );
}

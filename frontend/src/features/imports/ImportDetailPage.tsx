import type { ImportDto, ImportRow, ImportRows } from '@lms/backend/contracts';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError } from '../../shared/api/client';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { DataTable } from '../../shared/ui/data-table';
import { ConfirmDialog } from '../../shared/ui/dialog';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { usePolling } from '../../shared/utils/usePolling';
import {
  cancelImport,
  confirmImport,
  downloadErrors,
  getImport,
  getRows,
  importKeys,
  RUNNING,
  TERMINAL,
} from './imports.api';
import { statusLabel, statusTone } from './status';

/** "email - name" of a staged row (the cells are keyed by column name, in no particular order). */
function personOf(cells: Record<string, string>): string {
  const named = [cells.email, cells.full_name].filter(Boolean);
  return (named.length > 0 ? named : Object.values(cells).slice(0, 2)).join(' - ');
}

export function ImportDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const qc = useQueryClient();
  const imp = useQuery({
    queryKey: importKeys.detail(id),
    queryFn: ({ signal }) => getImport(id, signal),
  });
  const data = imp.data;

  // live progress: 1 s, backing off to 5 s, paused while the tab is hidden, stopped at a terminal status
  usePolling({
    enabled: !!data && RUNNING.has(data.status),
    poll: () =>
      qc.fetchQuery({
        queryKey: importKeys.detail(id),
        queryFn: ({ signal }) => getImport(id, signal),
        staleTime: 0,
      }),
  });

  if (imp.isPending) return <ListSkeleton rows={4} label="Loading import" />;
  if (imp.isError) {
    const gone = imp.error instanceof ApiError && imp.error.status === 404;
    return (
      <ErrorState
        error={imp.error}
        title={gone ? 'This import does not exist' : 'Could not load this import'}
        onRetry={gone ? undefined : () => void imp.refetch()}
      />
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link to={'/imports' as '/'} className="text-primary underline">
          All imports
        </Link>
      </p>
      <PageHeader
        title={data.fileName}
        description={`${data.kind === 'students' ? 'Students' : 'Faculty'} import`}
        actions={<Badge tone={statusTone(data.status)}>{statusLabel(data.status)}</Badge>}
      />
      {data.status === 'validated' && <Review imp={data} />}
      {RUNNING.has(data.status) && <Progress imp={data} />}
      {TERMINAL.has(data.status) && <Summary imp={data} />}
    </div>
  );
}

function Counts({ imp }: { imp: ImportDto }) {
  const c = imp.counts;
  const items: [string, number][] = [
    ['Rows in the file', c.total],
    ['Valid', c.valid],
    ['With problems', c.invalid],
  ];
  return (
    <dl className="grid grid-cols-3 gap-3 text-center">
      {items.map(([label, n]) => (
        <div key={label} className="rounded-md border border-border p-3">
          <dd className="text-2xl font-semibold">{n}</dd>
          <dt className="text-xs text-muted-foreground">{label}</dt>
        </div>
      ))}
    </dl>
  );
}

// ------------------------------------------------------------------ review + confirm
function Review({ imp }: { imp: ImportDto }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'invalid' | 'all'>(
    imp.counts.invalid > 0 ? 'invalid' : 'all',
  );
  const [updateExisting, setUpdateExisting] = useState(false);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const hasInvalid = imp.counts.invalid > 0;

  const confirm = useMutation({
    mutationFn: () =>
      confirmImport(imp.id, { updateExisting, skipInvalid: hasInvalid ? skipInvalid : undefined }),
    onSuccess: (next) => {
      qc.setQueryData(importKeys.detail(imp.id), next);
      toast.success('The import has started.');
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const cancel = useMutation({
    mutationFn: () => cancelImport(imp.id),
    onSuccess: (next) => {
      qc.setQueryData(importKeys.detail(imp.id), next);
      setCancelling(false);
      toast.success(`${imp.fileName} was cancelled. Nothing was saved.`);
    },
    onError: (err) => {
      setCancelling(false);
      toast.error(describeError(err));
    },
  });
  const errorsCsv = useMutation({
    mutationFn: () => downloadErrors(imp.id),
    onError: (err) => toast.error(describeError(err)),
  });

  return (
    <>
      <Card title="2. Review the check">
        <div className="space-y-4">
          <Counts imp={imp} />
          {hasInvalid && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm">
                {imp.counts.invalid} row{imp.counts.invalid === 1 ? ' has' : 's have'} problems and
                will not be imported.
              </p>
              <Button
                variant="secondary"
                loading={errorsCsv.isPending}
                onClick={() => errorsCsv.mutate()}
              >
                Download the error report (CSV)
              </Button>
            </div>
          )}
          {/* biome-ignore lint/a11y/useSemanticElements: a toggle-button group, not a form fieldset */}
          <div className="flex gap-2" role="group" aria-label="Rows to show">
            {(['invalid', 'all'] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className="min-h-9 rounded-md border border-input px-3 text-sm aria-pressed:bg-primary aria-pressed:text-primary-foreground"
              >
                {f === 'invalid' ? 'Problems only' : 'All rows'}
              </button>
            ))}
          </div>
          <RowsTable id={imp.id} status={filter} />
        </div>
      </Card>

      <Card title="3. Confirm">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            confirm.mutate();
          }}
        >
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4"
              checked={updateExisting}
              onChange={(e) => setUpdateExisting(e.target.checked)}
            />
            <span>
              <strong>Update existing members.</strong> People who are already members get their
              profile updated. Their names are never changed.
            </span>
          </label>
          {hasInvalid && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={skipInvalid}
                onChange={(e) => setSkipInvalid(e.target.checked)}
              />
              <span>
                <strong>Skip the {imp.counts.invalid} rows with problems</strong> and import the
                other {imp.counts.valid}.
              </span>
            </label>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="danger" onClick={() => setCancelling(true)}>
              Cancel this import
            </Button>
            <Button
              type="submit"
              loading={confirm.isPending}
              disabled={imp.counts.valid === 0 || (hasInvalid && !skipInvalid)}
            >
              Import {imp.counts.valid} {imp.counts.valid === 1 ? 'person' : 'people'}
            </Button>
          </div>
          {hasInvalid && !skipInvalid && imp.counts.valid > 0 && (
            <p className="text-xs text-muted-foreground">
              Tick "skip the rows with problems" to continue, or fix the file and upload it again.
            </p>
          )}
        </form>
      </Card>

      <ConfirmDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        pending={cancel.isPending}
        onConfirm={() => cancel.mutate()}
        title={`Cancel the import of ${imp.fileName}?`}
        description="Nothing has been saved yet. The checked rows are discarded and you can upload the file again later."
        confirmLabel={`Cancel ${imp.fileName}`}
      />
    </>
  );
}

function RowsTable({ id, status }: { id: string; status: 'invalid' | 'all' }) {
  const rows = useInfiniteQuery<
    ImportRows,
    Error,
    InfiniteData<ImportRows, number | undefined>,
    ReturnType<typeof importKeys.rows>,
    number | undefined
  >({
    queryKey: importKeys.rows(id, status),
    queryFn: ({ pageParam, signal }) => getRows(id, status, pageParam, signal),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = rows.data?.pages.flatMap((p) => p.items) ?? [];

  if (rows.isPending) return <ListSkeleton rows={4} label="Loading rows" />;
  if (rows.isError) return <ErrorState error={rows.error} onRetry={() => void rows.refetch()} />;
  if (items.length === 0) {
    return <EmptyState title={status === 'invalid' ? 'No problems found' : 'No rows'} />;
  }
  return (
    <>
      <DataTable<ImportRow>
        caption="Rows of the file"
        rows={items}
        rowKey={(r) => String(r.rowNumber)}
        columns={[
          { header: 'Row', cell: (r) => r.rowNumber },
          { header: 'Person', cell: (r) => personOf(r.cells) },
          {
            header: 'Problems',
            cell: (r) =>
              r.errors.length === 0 ? (
                <Badge tone="success">ok</Badge>
              ) : (
                <ul className="list-disc space-y-0.5 pl-4">
                  {r.errors.map((e) => (
                    <li key={`${e.column}:${e.message}`}>
                      {e.column ? <strong>{e.column}: </strong> : null}
                      {e.message}
                    </li>
                  ))}
                </ul>
              ),
          },
        ]}
      />
      {rows.hasNextPage && (
        <div className="mt-3 flex justify-center">
          <Button
            variant="secondary"
            loading={rows.isFetchingNextPage}
            onClick={() => void rows.fetchNextPage()}
          >
            Load more rows
          </Button>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ live progress
function Progress({ imp }: { imp: ImportDto }) {
  const done = imp.counts.processed + imp.counts.skipped + imp.counts.failed;
  const total = Math.max(imp.counts.valid, 1);
  const pct = imp.status === 'parsing' ? 0 : Math.min(100, Math.round((done / total) * 100));
  return (
    <Card title="4. Importing">
      <div className="space-y-3">
        <div
          role="progressbar"
          aria-label="Import progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="h-3 w-full overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <p aria-live="polite" className="text-sm">
          {imp.status === 'queued' || imp.status === 'parsing'
            ? 'Waiting for the import to start...'
            : `${done} of ${imp.counts.valid} rows done (${pct}%).`}
        </p>
        <p className="text-xs text-muted-foreground">
          You can leave this page; the import keeps running. Come back through "All imports".
        </p>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ summary
function Summary({ imp }: { imp: ImportDto }) {
  const c = imp.counts;
  const errorsCsv = useMutation({
    mutationFn: () => downloadErrors(imp.id),
    onError: (err) => toast.error(describeError(err)),
  });
  const items: [string, number][] = [
    ['New members', c.created],
    ['Updated', c.updated],
    ['Skipped', c.skipped],
    ['Failed', c.failed],
  ];
  const failedHard = imp.status === 'failed';
  return (
    <Card title="Result">
      <div className="space-y-4">
        {failedHard && (
          <p role="alert" className="text-sm text-danger">
            The import failed{imp.error ? `: ${imp.error}` : '.'}
          </p>
        )}
        {imp.status === 'cancelled' && (
          <p className="text-sm">This import was cancelled. Nothing was saved.</p>
        )}
        {imp.status !== 'cancelled' && (
          <dl className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
            {items.map(([label, n]) => (
              <div key={label} className="rounded-md border border-border p-3">
                <dd className="text-2xl font-semibold">{n}</dd>
                <dt className="text-xs text-muted-foreground">{label}</dt>
              </div>
            ))}
          </dl>
        )}
        {imp.status !== 'cancelled' && !failedHard && (
          <p className="text-sm text-muted-foreground">
            New members are "pending" and have been sent an invitation email.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {(c.invalid > 0 || c.failed > 0) && !imp.rowsPurged && (
            <Button
              variant="secondary"
              loading={errorsCsv.isPending}
              onClick={() => errorsCsv.mutate()}
            >
              Download the error report (CSV)
            </Button>
          )}
          <Link
            to={'/members' as '/'}
            className="inline-flex min-h-11 items-center rounded-md border border-input px-4 text-sm font-medium hover:bg-muted sm:min-h-9"
          >
            Go to members
          </Link>
          <Link
            to={'/imports' as '/'}
            className="inline-flex min-h-11 items-center rounded-md px-4 text-sm font-medium text-primary underline sm:min-h-9"
          >
            Start another import
          </Link>
        </div>
      </div>
    </Card>
  );
}

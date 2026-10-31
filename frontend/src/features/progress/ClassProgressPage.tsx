import type { ClassPage, ClassRow } from '@lms/backend/contracts';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { download } from '../../shared/api/client';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { type Column, DataTable } from '../../shared/ui/data-table';
import { Dialog } from '../../shared/ui/dialog';
import { Field } from '../../shared/ui/field';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { Select } from '../../shared/ui/select';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import {
  courseKeys,
  getOffering,
  listOfferingSections,
  updateOffering,
} from '../courses/courses.api';
import { putOffering } from '../courses/offeringCache';
import { ItemStatusBadge, ProgressBar } from './ProgressBar';
import {
  type ClassFilters,
  classCsvPath,
  getLearner,
  listClass,
  progressKeys,
} from './progress.api';

type ListData = InfiniteData<ClassPage, string | undefined>;
type Status = NonNullable<ClassFilters['status']>;

const STATUS_LABEL: Record<Status, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  behind: 'Behind',
  completed: 'Completed',
};
const STATUS_TONE: Record<Status, 'neutral' | 'success' | 'warning' | 'danger'> = {
  not_started: 'neutral',
  in_progress: 'neutral',
  behind: 'danger',
  completed: 'success',
};

function when(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'Never';
}

/**
 * The class view for instructors, assistants and administrators (read only): learners x modules with percentages,
 * filters, sort, keyset "load more", a drilldown per learner and the CSV export. The API enforces who may see it.
 */
export function ClassProgressPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const [filters, setFilters] = useState<ClassFilters>({ sort: 'name', dir: 'asc' });
  const [open, setOpen] = useState<ClassRow | null>(null);
  const offering = useQuery({
    queryKey: courseKeys.offering(id),
    queryFn: ({ signal }) => getOffering(id, signal),
  });
  const sections = useQuery({
    queryKey: courseKeys.sections(id),
    queryFn: ({ signal }) => listOfferingSections(id, signal),
  });
  const table = useInfiniteQuery<
    ClassPage,
    Error,
    ListData,
    ReturnType<typeof progressKeys.classTable>,
    string | undefined
  >({
    queryKey: progressKeys.classTable(id, filters),
    queryFn: ({ pageParam, signal }) => listClass(id, filters, pageParam, signal),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const csv = useMutation({
    mutationFn: () => download(classCsvPath(id, filters), 'class-progress.csv'),
    onError: (err) => toast.error(describeError(err)),
  });

  const set = (patch: Partial<ClassFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const pages = table.data?.pages ?? [];
  const rows = pages.flatMap((p) => p.items);
  const modules = pages[0]?.modules ?? [];
  const total = pages[0]?.total ?? 0;
  const o = offering.data;

  const titleCount = new Map<string, number>();
  const columns: Column<ClassRow>[] = [
    {
      header: 'Learner',
      cell: (r) => (
        <span className="flex flex-col">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{r.displayName}</span>
            {r.removed && <Badge>Removed</Badge>}
          </span>
          <span className="text-xs text-muted-foreground">{r.email}</span>
        </span>
      ),
    },
    { header: 'Section', cell: (r) => r.sectionName ?? '—' },
    {
      header: 'Progress',
      className: 'min-w-40',
      cell: (r) => (
        <ProgressBar
          percent={r.percent}
          label={`Progress of ${r.displayName}`}
          detail={r.totalRequired > 0 ? `${r.completedRequired}/${r.totalRequired}` : undefined}
        />
      ),
    },
    {
      header: 'Status',
      cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>,
    },
    ...modules.map((m): Column<ClassRow> => {
      // a header is the key of its column: two modules with one title stay apart
      const n = (titleCount.get(m.title) ?? 0) + 1;
      titleCount.set(m.title, n);
      return {
        header: n > 1 ? `${m.title} (${n})` : m.title,
        className: 'tabular-nums',
        cell: (r) => {
          const p = r.modules.find((x) => x.moduleId === m.id)?.percent;
          return p === null || p === undefined ? '—' : `${p}%`;
        },
      };
    }),
    { header: 'Last activity', cell: (r) => when(r.lastActivityAt) },
  ];

  return (
    <div className="space-y-6">
      <Link to={`/offerings/${id}` as '/'} className="text-sm text-primary underline">
        ← Back to the course
      </Link>
      <PageHeader
        title="Class progress"
        description={o ? `${o.title} · ${o.courseCode} · ${o.termName}` : undefined}
        actions={
          <Button variant="secondary" loading={csv.isPending} onClick={() => csv.mutate()}>
            Export CSV
          </Button>
        }
      />

      <form
        aria-label="Filters"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
        onSubmit={(e) => e.preventDefault()}
      >
        <Select
          label="Section"
          value={filters.section ?? ''}
          onChange={(e) => set({ section: e.target.value || undefined })}
        >
          <option value="">All sections</option>
          {sections.data?.items.map((s) => (
            <option key={s.sectionId} value={s.sectionId}>
              {s.programCode} · {s.batchLabel} · {s.sectionCode}
            </option>
          ))}
        </Select>
        <Select
          label="Status"
          value={filters.status ?? ''}
          onChange={(e) => set({ status: (e.target.value || undefined) as Status | undefined })}
        >
          <option value="">Any status</option>
          {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <Select
          label="Learners"
          value={filters.learners ?? 'active'}
          onChange={(e) => set({ learners: e.target.value === 'removed' ? 'removed' : undefined })}
        >
          <option value="active">Current learners</option>
          <option value="removed">Removed learners (history)</option>
        </Select>
        <Select
          label="Sort by"
          value={filters.sort ?? 'name'}
          onChange={(e) => set({ sort: e.target.value as ClassFilters['sort'] })}
        >
          <option value="name">Name</option>
          <option value="percent">Progress</option>
          <option value="activity">Last activity</option>
        </Select>
        <Select
          label="Order"
          value={filters.dir ?? 'asc'}
          onChange={(e) => set({ dir: e.target.value === 'desc' ? 'desc' : 'asc' })}
        >
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </Select>
      </form>

      {table.isLoading ? (
        <ListSkeleton rows={6} label="Loading class progress" />
      ) : table.isError ? (
        <ErrorState
          title="Could not load the class progress"
          error={table.error}
          onRetry={() => void table.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No learners to show"
          description={
            filters.section || filters.status || filters.learners
              ? 'No learner matches these filters.'
              : 'Learners appear here once they are in the course.'
          }
        />
      ) : (
        <div className="space-y-3">
          <p role="status" className="text-sm text-muted-foreground">
            {total} learner{total === 1 ? '' : 's'}
            {filters.learners === 'removed' ? ' (removed: read-only history)' : ''}
          </p>
          <DataTable
            caption="Class progress"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.participantId}
            actions={(r) => (
              <Button
                variant="secondary"
                aria-label={`Details of ${r.displayName}`}
                onClick={() => setOpen(r)}
              >
                Details
              </Button>
            )}
          />
          {table.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                loading={table.isFetchingNextPage}
                onClick={() => void table.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </div>
      )}

      {o && o.myParticipation === 'instructor' && <SettingsCard offeringId={id} />}
      <LearnerDialog offeringId={id} row={open} onClose={() => setOpen(null)} />
    </div>
  );
}

/** One learner, item by item. */
function LearnerDialog({
  offeringId,
  row,
  onClose,
}: {
  offeringId: string;
  row: ClassRow | null;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: progressKeys.learner(offeringId, row?.participantId ?? ''),
    queryFn: ({ signal }) => getLearner(offeringId, row?.participantId ?? '', signal),
    enabled: row !== null,
  });
  return (
    <Dialog
      open={row !== null}
      onClose={onClose}
      title={row ? `${row.displayName}'s progress` : ''}
    >
      {q.isLoading && <ListSkeleton rows={4} label="Loading" />}
      {q.isError && (
        <ErrorState title="Could not load" error={q.error} onRetry={() => void q.refetch()} />
      )}
      {q.data && (
        <div className="space-y-3">
          <ProgressBar
            percent={q.data.learner.percent}
            label={`Progress of ${q.data.learner.displayName}`}
            detail={`${q.data.learner.completedRequired} of ${q.data.learner.totalRequired} required items`}
          />
          {q.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">There are no items yet.</p>
          ) : (
            <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto text-sm">
              {q.data.items.map((i) => (
                <li key={i.itemId} className="space-y-1 py-2">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{i.title}</span>
                    <ItemStatusBadge status={i.status} />
                    {!i.required && <Badge>Optional</Badge>}
                    {i.flagged > 0 && (
                      <Badge tone="warning">
                        {i.flagged} flagged heartbeat{i.flagged === 1 ? '' : 's'}
                      </Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {i.moduleTitle}
                    {i.watchedPercent !== null ? ` · watched ${i.watchedPercent}%` : ''}
                    {` · last activity: ${when(i.lastActivityAt)}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

/** The two numbers of the offering that decide "completed" (video share) and "behind" (days). */
function SettingsCard({ offeringId }: { offeringId: string }) {
  const offering = useQuery({
    queryKey: courseKeys.offering(offeringId),
    queryFn: ({ signal }) => getOffering(offeringId, signal),
  });
  const qc = useQueryClient();
  const [threshold, setThreshold] = useState<string | null>(null);
  const [days, setDays] = useState<string | null>(null);
  const o = offering.data;
  const save = useMutation({
    mutationFn: (body: { completionThreshold: number; behindAfterDays: number }) =>
      updateOffering(offeringId, body),
    onSuccess: (next) => {
      putOffering(qc, next);
      // the percentages and statuses depend on both numbers
      void qc.invalidateQueries({ queryKey: [...progressKeys.all, 'class'] });
      setThreshold(null);
      setDays(null);
      toast.success('Settings saved');
    },
    onError: (err) => toast.error(describeError(err)),
  });
  if (!o) return null;
  const tv = threshold ?? String(o.completionThreshold);
  const dv = days ?? String(o.behindAfterDays);
  const tn = Number(tv);
  const dn = Number(dv);
  const tErr =
    Number.isInteger(tn) && tn >= 50 && tn <= 100
      ? undefined
      : 'Enter a whole number from 50 to 100';
  const dErr =
    Number.isInteger(dn) && dn >= 1 && dn <= 60 ? undefined : 'Enter a whole number from 1 to 60';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (tErr || dErr) return;
    save.mutate({ completionThreshold: tn, behindAfterDays: dn });
  };
  return (
    <Card title="Completion settings">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-3 sm:items-start" noValidate>
        <Field
          label="Video completes at (% watched)"
          type="number"
          inputMode="numeric"
          min={50}
          max={100}
          value={tv}
          onChange={(e) => setThreshold(e.target.value)}
          error={tErr}
          hint="The share of the video a learner must have really played."
        />
        <Field
          label="Behind after (days)"
          type="number"
          inputMode="numeric"
          min={1}
          max={60}
          value={dv}
          onChange={(e) => setDays(e.target.value)}
          error={dErr}
          hint="A required item open longer than this and not done makes a learner “Behind”."
        />
        <div className="sm:pt-6">
          <Button
            type="submit"
            loading={save.isPending}
            disabled={threshold === null && days === null}
          >
            Save settings
          </Button>
        </div>
      </form>
    </Card>
  );
}

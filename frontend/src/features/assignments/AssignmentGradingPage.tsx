import type { GradeSaved, GradingQueue, GradingRow } from '@lms/backend/contracts';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { ConfirmDialog } from '../../shared/ui/dialog';
import { Badge, PageHeader } from '../../shared/ui/layout';
import { Select } from '../../shared/ui/select';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { listOfferingSections } from '../courses/courses.api';
import {
  assignmentKeys,
  getQueue,
  getSummary,
  type QueueFilter,
  releaseGrades,
  zipUrl,
} from './assignments.api';
import { duration } from './format';
import { LearnerPanel } from './LearnerPanel';

// The grading screen: the queue on the left (filters, keyset "load more"), one learner on the right. j / k (or the arrow
// keys) move to the next and the previous learner of the queue. While grading is blind the rows carry an anonymous code
// and no name, and the queue cannot be ordered by name.

const STATUS: Record<string, string> = {
  not_submitted: 'Not submitted',
  submitted: 'Submitted',
  late: 'Late',
  graded: 'Graded',
  released: 'Released',
};
const TONE: Record<string, 'neutral' | 'success' | 'warning'> = {
  not_submitted: 'neutral',
  submitted: 'neutral',
  late: 'warning',
  graded: 'success',
  released: 'success',
};

const LINK =
  'inline-flex min-h-11 items-center rounded-md border border-input px-4 text-sm hover:bg-muted sm:min-h-9';

export function AssignmentGradingPage() {
  const { id, itemId } = useParams({ strict: false }) as { id: string; itemId: string };
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [sort, setSort] = useState('');
  // a link to one learner (?learner=<key>) opens them at once; picking another keeps the address current
  const [selected, setSelectedState] = useState<string | null>(() => {
    const k = new URLSearchParams(window.location.search).get('learner');
    return k && /^[0-9a-f-]{36}$/i.test(k) ? k : null;
  });
  const setSelected = useCallback((key: string | null) => {
    setSelectedState(key);
    const url = new URL(window.location.href);
    if (key) url.searchParams.set('learner', key);
    else url.searchParams.delete('learner');
    window.history.replaceState(window.history.state, '', url);
  }, []);
  const [releasing, setReleasing] = useState(false);
  const filter: QueueFilter = {
    status: status || undefined,
    sectionId: sectionId || undefined,
    sort: (sort || undefined) as QueueFilter['sort'],
  };
  const filterKey = JSON.stringify(filter);
  const queue = useInfiniteQuery({
    queryKey: assignmentKeys.queue(id, itemId, filterKey),
    queryFn: ({ pageParam, signal }) => getQueue(id, itemId, filter, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const summary = useQuery({
    queryKey: assignmentKeys.summary(id, itemId),
    queryFn: ({ signal }) => getSummary(id, itemId, signal),
  });
  const sections = useQuery({
    queryKey: ['offerings', 'sections', id],
    queryFn: ({ signal }) => listOfferingSections(id, signal),
  });
  const rows = useMemo(() => queue.data?.pages.flatMap((p) => p.items) ?? [], [queue.data]);
  const blind = queue.data?.pages[0]?.blind ?? false;

  const index = rows.findIndex((r) => r.learnerKey === selected);
  const go = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      const next =
        index < 0
          ? delta > 0
            ? 0
            : rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, index + delta));
      setSelected(rows[next]?.learnerKey ?? null);
    },
    [rows, index, setSelected],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (
        el &&
        (el.matches('input, textarea, select, [contenteditable="true"]') || el.isContentEditable)
      )
        return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        go(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);
  // load the next page when the grader reaches the end of what is loaded
  useEffect(() => {
    if (index >= 0 && index === rows.length - 1 && queue.hasNextPage && !queue.isFetchingNextPage)
      void queue.fetchNextPage();
  }, [index, rows.length, queue]);

  /** The queue row of a learner is patched in place: a save does not refetch the whole list. */
  const patchRow = (key: string, patch: Partial<GradingRow>) =>
    qc.setQueriesData<InfiniteData<GradingQueue>>(
      { queryKey: assignmentKeys.queueAll(id, itemId) },
      (old) =>
        old && {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            items: p.items.map((r) => (r.learnerKey === key ? { ...r, ...patch } : r)),
          })),
        },
    );
  const onGraded = (key: string, g: GradeSaved) =>
    patchRow(key, {
      status: g.releasedAt ? 'released' : 'graded',
      rawScore: g.rawScore,
      finalScore: g.finalScore,
      gradeOutdated: false,
    });
  const onReleased = (key: string) => patchRow(key, { status: 'released' });

  const releaseAll = useMutation({
    mutationFn: () => releaseGrades(id, itemId),
    onSuccess: (r) => {
      setReleasing(false);
      toast.success(`${r.released} grade${r.released === 1 ? '' : 's'} released.`);
      void qc.invalidateQueries({ queryKey: assignmentKeys.queueAll(id, itemId) });
      void qc.invalidateQueries({ queryKey: assignmentKeys.summary(id, itemId) });
      if (selected)
        void qc.invalidateQueries({ queryKey: assignmentKeys.learner(id, itemId, selected) });
    },
    onError: (err) => toast.error(describeError(err)),
  });

  const s = summary.data;
  return (
    <div className="space-y-4">
      <Link
        to={`/offerings/${id}/items/${itemId}/assignment` as '/'}
        className="text-sm text-primary underline"
      >
        ← Assignment settings
      </Link>
      <PageHeader
        title="Grading"
        description={
          blind
            ? 'Blind grading is on: names and register numbers are hidden until a grade is released.'
            : 'Open a learner, grade the latest version. j / k move to the next and the previous learner.'
        }
        actions={
          <>
            <a href={zipUrl(id, itemId)} className={LINK} download>
              Download all submissions (ZIP)
            </a>
            <Button variant="secondary" onClick={() => setReleasing(true)}>
              Release all graded
            </Button>
          </>
        }
      />
      {s && (
        <ul
          className="flex flex-wrap gap-2 text-sm"
          aria-label="Status of the class"
          data-testid="summary"
        >
          {(
            [
              ['', `All ${s.learners}`],
              ['not_submitted', `Not submitted ${s.notSubmitted}`],
              ['submitted', `Submitted ${s.submitted}`],
              ['late', `Late ${s.late}`],
              ['graded', `Graded ${s.graded}`],
              ['released', `Released ${s.released}`],
            ] as const
          ).map(([value, label]) => (
            <li key={value}>
              <button
                type="button"
                aria-pressed={status === value}
                onClick={() => setStatus(value)}
                className="min-h-11 rounded-full border border-input px-3 aria-pressed:bg-primary aria-pressed:text-primary-foreground sm:min-h-9"
              >
                {label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <section aria-label="Queue" className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
            <Select
              label="Section"
              value={sectionId}
              onChange={(e) => setSectionId(e.target.value)}
            >
              <option value="">All sections</option>
              {sections.data?.items.map((x) => (
                <option key={x.sectionId} value={x.sectionId}>
                  {x.programCode} {x.batchLabel} {x.sectionCode}
                </option>
              ))}
            </Select>
            <Select label="Order by" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="">{blind ? 'Anonymous code' : 'Name'}</option>
              <option value="time">Submission time</option>
              {!blind && <option value="code">Anonymous code</option>}
            </Select>
          </div>
          {queue.isLoading ? (
            <ListSkeleton rows={8} label="Loading the queue" />
          ) : queue.isError ? (
            <ErrorState
              title="Could not load the queue"
              error={queue.error}
              onRetry={() => void queue.refetch()}
            />
          ) : rows.length === 0 ? (
            <EmptyState title="Nobody here" description="No learner matches this filter." />
          ) : (
            <>
              <ul
                className="divide-y divide-border rounded-md border border-border bg-surface"
                data-testid="queue"
              >
                {rows.map((r) => (
                  <li key={r.learnerKey}>
                    <button
                      type="button"
                      onClick={() => setSelected(r.learnerKey)}
                      aria-current={r.learnerKey === selected ? 'true' : undefined}
                      className="flex min-h-11 w-full flex-col gap-1 px-3 py-2 text-left text-sm hover:bg-muted aria-[current=true]:bg-muted"
                    >
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <strong>{r.name ?? `Learner ${r.anonCode}`}</strong>
                        <Badge tone={TONE[r.status] ?? 'neutral'}>{STATUS[r.status]}</Badge>
                      </span>
                      <span className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                        {r.registerNumber && <span>{r.registerNumber}</span>}
                        {r.versionNo != null && <span>version {r.versionNo}</span>}
                        {r.lateSeconds > 0 && <span>late {duration(r.lateSeconds)}</span>}
                        {r.gradeOutdated && <span>newer version since the grade</span>}
                        {r.finalScore != null && (
                          <span className="font-medium text-foreground">
                            {r.finalScore} / {queue.data?.pages[0]?.maxPoints}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {queue.hasNextPage && (
                <Button
                  variant="secondary"
                  loading={queue.isFetchingNextPage}
                  onClick={() => void queue.fetchNextPage()}
                >
                  Load more
                </Button>
              )}
            </>
          )}
        </section>
        <section aria-label="Learner" className="min-w-0">
          {selected ? (
            <>
              <div className="mb-3 flex gap-2">
                <Button variant="secondary" onClick={() => go(-1)} disabled={index <= 0}>
                  Previous (k)
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => go(1)}
                  disabled={index >= rows.length - 1}
                >
                  Next (j)
                </Button>
              </div>
              <LearnerPanel
                key={selected}
                offeringId={id}
                itemId={itemId}
                rowKey={selected}
                onGraded={onGraded}
                onReleased={onReleased}
              />
            </>
          ) : (
            <EmptyState
              title="Choose a learner"
              description="Pick someone from the queue to see their work."
            />
          )}
        </section>
      </div>
      <ConfirmDialog
        open={releasing}
        onClose={() => setReleasing(false)}
        onConfirm={() => releaseAll.mutate()}
        pending={releaseAll.isPending}
        title="Release every graded submission?"
        description={
          <>
            Learners see their score, the late penalty and the feedback, and with blind grading
            their names appear next to the grades. Only grades of the latest version are released.
          </>
        }
        confirmLabel="Release all graded"
      />
    </div>
  );
}

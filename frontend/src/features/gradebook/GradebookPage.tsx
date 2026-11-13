import type { Grid, GridRow } from '@lms/backend/contracts';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Badge, PageHeader } from '../../shared/ui/layout';
import { Select } from '../../shared/ui/select';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { usePermissions } from '../auth/useMe';
import { courseKeys, getOffering, listOfferingSections } from '../courses/courses.api';
import { GradebookGrid } from './GradebookGrid';
import { getConfig, getGrid, gradebookKeys, type MarkCell, saveMarks } from './gradebook.api';
import { WorkflowPanel } from './WorkflowPanel';
import { STATUS_TEXT } from './workflowText';

// what is used only on demand is its own chunk: the first paint of the grid does not pay for the settings editors, the import
// dialog or the explanation panel
const SettingsPanel = lazy(() =>
  import('./SettingsPanel').then((m) => ({ default: m.SettingsPanel })),
);
const ExplainPanel = lazy(() =>
  import('./ExplainPanel').then((m) => ({ default: m.ExplainPanel })),
);
const ImportDialog = lazy(() =>
  import('./ImportDialog').then((m) => ({ default: m.ImportDialog })),
);

type GridData = InfiniteData<Grid, string | undefined>;
type Tab = 'grid' | 'settings';

/**
 * The gradebook of an offering. Instructors configure it, enter marks (paste from Excel, type, import a CSV), see how every final was
 * calculated and submit it; assistants enter marks where they may; an institution admin reviews, approves, returns and unlocks.
 * The API enforces all of it: what is hidden here is only cosmetic.
 */
export function GradebookPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const qc = useQueryClient();
  const { has } = usePermissions();
  const [tab, setTab] = useState<Tab>('grid');
  const [section, setSection] = useState<string | undefined>(undefined);
  const [explain, setExplain] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState('');

  const offering = useQuery({
    queryKey: courseKeys.offering(id),
    queryFn: ({ signal }) => getOffering(id, signal),
  });
  const sections = useQuery({
    queryKey: courseKeys.sections(id),
    queryFn: ({ signal }) => listOfferingSections(id, signal),
  });
  const config = useQuery({
    queryKey: gradebookKeys.config(id),
    queryFn: ({ signal }) => getConfig(id, signal),
  });
  const grid = useInfiniteQuery<
    Grid,
    Error,
    GridData,
    ReturnType<typeof gradebookKeys.grid>,
    string | undefined
  >({
    queryKey: gradebookKeys.grid(id, section),
    queryFn: ({ pageParam, signal }) => getGrid(id, section, pageParam, signal),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  // learners arrive in chunks of 500 and are appended: a class of 1,200 fills in while the first rows are already usable
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = grid;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const rows = useMemo(() => grid.data?.pages.flatMap((p) => p.rows) ?? [], [grid.data]);
  const total = grid.data?.pages[0]?.total ?? null;
  const cfg = config.data;
  const part = offering.data?.myParticipation ?? null;
  const isInstructor = part === 'instructor';
  const isApprover = has('gradebook.approve');
  const locked = cfg ? cfg.status === 'submitted' || cfg.status === 'locked' : true;
  const canEnter = useCallback(
    (item: { assistantsMayEnter: boolean }) =>
      isInstructor || (part === 'assistant' && item.assistantsMayEnter),
    [isInstructor, part],
  );

  const marks = useMutation({
    mutationFn: (cells: MarkCell[]) => saveMarks(id, cells),
    onSuccess: async (r) => {
      // patch the rows the answer recomputed in place (no refetch of the whole grid)
      qc.setQueryData<GridData>(gradebookKeys.grid(id, section), (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((p) => ({
                ...p,
                rows: p.rows.map((row) => {
                  const n = r.rows[row.participantId];
                  return n ? { ...row, ...n } : row;
                }),
              })),
            }
          : old,
      );
      if (r.conflicts.length > 0) {
        toast.error(
          `${r.conflicts.length} cell${r.conflicts.length === 1 ? ' was' : 's were'} changed by someone else meanwhile and not overwritten. The grid shows the current values.`,
        );
        await qc.invalidateQueries({ queryKey: ['gradebook', id, 'grid'] });
      } else if (r.invalid.length > 0)
        toast.error(
          `${r.invalid.length} cell${r.invalid.length === 1 ? ' was' : 's were'} not valid and not saved.`,
        );
      else toast.success(`${r.saved} mark${r.saved === 1 ? '' : 's'} saved`);
      if (r.saved > 0) void qc.invalidateQueries({ queryKey: gradebookKeys.config(id) });
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const commit = useCallback(
    async (cells: MarkCell[]) => {
      await marks.mutateAsync(cells).catch(() => undefined);
    },
    [marks],
  );
  const explainRow = useCallback((row: GridRow) => setExplain(row.participantId), []);

  const o = offering.data;
  if (config.isLoading)
    return (
      <div className="space-y-5">
        <PageHeader
          title="Gradebook"
          description={o ? `${o.title} · ${o.courseCode} · ${o.termName}` : ' '}
        />
        <ListSkeleton rows={8} label="Loading the gradebook" />
      </div>
    );
  if (config.isError || !cfg)
    return <ErrorState error={config.error} onRetry={() => void config.refetch()} />;

  return (
    <div className="space-y-5">
      <Link to={`/offerings/${id}` as '/'} className="text-sm text-primary underline">
        ← Back to the course
      </Link>
      <PageHeader
        title="Gradebook"
        description={o ? `${o.title} · ${o.courseCode} · ${o.termName}` : ' '}
        actions={
          <>
            <Badge
              tone={
                cfg.status === 'locked'
                  ? 'success'
                  : cfg.status === 'submitted'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {STATUS_TEXT[cfg.status]}
            </Badge>
            {(isInstructor ||
              (part === 'assistant' && cfg.items.some((i) => i.assistantsMayEnter))) && (
              <Button variant="secondary" disabled={locked} onClick={() => setImporting(true)}>
                Import marks (CSV)
              </Button>
            )}
          </>
        }
      />

      <WorkflowPanel
        offeringId={id}
        config={cfg}
        isInstructor={isInstructor}
        isApprover={isApprover}
      />

      <div
        role="tablist"
        aria-label="Gradebook sections"
        className="flex gap-2 border-b border-border"
      >
        {(['grid', 'settings'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`panel-${t}`}
            onClick={() => setTab(t)}
            className={`min-h-11 px-4 text-sm font-medium sm:min-h-9 ${tab === t ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground'}`}
          >
            {t === 'grid' ? 'Marks' : 'Settings'}
          </button>
        ))}
      </div>

      {tab === 'grid' && (
        <div role="tabpanel" id="panel-grid" aria-labelledby="tab-grid" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Select
              label="Section"
              value={section ?? ''}
              onChange={(e) => setSection(e.target.value || undefined)}
            >
              <option value="">All sections</option>
              {sections.data?.items.map((s) => (
                <option key={s.sectionId} value={s.sectionId}>
                  {s.programCode} · {s.batchLabel} · {s.sectionCode}
                </option>
              ))}
            </Select>
          </div>
          <p className="text-sm text-muted-foreground" role="status">
            {grid.isLoading
              ? 'Loading learners…'
              : `${rows.length}${total !== null && rows.length < total ? ` of ${total}` : ''} learner${rows.length === 1 ? '' : 's'}`}
            {isFetchingNextPage || hasNextPage ? ' (more are loading)' : ''}
            {' · '}Arrow keys move, Enter or a digit edits, Delete clears, you can paste from Excel.{' '}
            ✎ set by hand · * counted as 0 · crossed out = dropped
          </p>
          {notice && (
            <p role="alert" className="rounded-md border border-danger p-2 text-sm">
              {notice}{' '}
              <button type="button" className="underline" onClick={() => setNotice('')}>
                Dismiss
              </button>
            </p>
          )}
          {grid.isError && <ErrorState error={grid.error} onRetry={() => void grid.refetch()} />}
          {grid.isLoading && <ListSkeleton rows={8} label="Loading the grid" />}
          {grid.isSuccess && rows.length === 0 && (
            <EmptyState
              title="No learners"
              description="Nobody is enrolled as a learner in this offering (or in this section) yet."
            />
          )}
          {cfg.items.length === 0 && grid.isSuccess && rows.length > 0 && (
            <EmptyState
              title="No items yet"
              description={
                isInstructor
                  ? 'Open Settings to add quizzes, assignments or manual columns.'
                  : 'The instructor has not added items yet.'
              }
            />
          )}
          {rows.length > 0 && cfg.items.length > 0 && (
            <GradebookGrid
              rows={rows}
              config={cfg}
              canEnter={canEnter}
              locked={locked}
              onCommit={commit}
              onExplain={explainRow}
              onNotice={setNotice}
            />
          )}
        </div>
      )}
      {tab === 'settings' && (
        <div role="tabpanel" id="panel-settings" aria-labelledby="tab-settings">
          {isInstructor ? (
            <Suspense fallback={<ListSkeleton rows={4} label="Loading the settings" />}>
              <SettingsPanel offeringId={id} config={cfg} disabled={locked} />
            </Suspense>
          ) : (
            <EmptyState
              title="Only the instructor changes the settings"
              description="Categories, weights, items, the grade scale and rounding are the instructor's."
            />
          )}
        </div>
      )}

      {explain !== null && (
        <Suspense fallback={null}>
          <ExplainPanel
            offeringId={id}
            participantId={explain}
            config={cfg}
            canOverride={isInstructor && !locked}
            onClose={() => setExplain(null)}
          />
        </Suspense>
      )}
      {importing && (
        <Suspense fallback={null}>
          <ImportDialog
            open={importing}
            onClose={() => setImporting(false)}
            offeringId={id}
            config={cfg}
          />
        </Suspense>
      )}
    </div>
  );
}

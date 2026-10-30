import type { Member, ParticipantDto, ParticipantPage } from '@lms/backend/contracts';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { DataTable } from '../../shared/ui/data-table';
import { ConfirmDialog, Dialog } from '../../shared/ui/dialog';
import { INPUT_CLASS } from '../../shared/ui/field';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { Select } from '../../shared/ui/select';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { useAcademicOptions } from '../academics/useOptions';
import { usePermissions } from '../auth/useMe';
import { listMembers } from '../members/members.api';
import {
  addOfferingSection,
  addParticipant,
  changeParticipant,
  courseKeys,
  getOffering,
  listOfferingSections,
  listParticipants,
  removeOfferingSection,
  removeParticipant,
} from './courses.api';

type Part = 'instructor' | 'assistant' | 'learner';
const PART_LABEL: Record<Part, string> = {
  instructor: 'Instructor',
  assistant: 'Assistant',
  learner: 'Learner',
};
type ListData = InfiniteData<ParticipantPage, string | undefined>;

/** The class list of an offering; administrators also add and remove people and enrol whole sections. */
export function PeoplePage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { has } = usePermissions();
  const manage = has('offering.manage');
  const [filter, setFilter] = useState('');
  const qc = useQueryClient();
  const offering = useQuery({
    queryKey: courseKeys.offering(id),
    queryFn: ({ signal }) => getOffering(id, signal),
  });
  const people = useInfiniteQuery<
    ParticipantPage,
    Error,
    ListData,
    ReturnType<typeof courseKeys.people>,
    string | undefined
  >({
    queryKey: courseKeys.people(id, filter),
    queryFn: ({ pageParam, signal }) =>
      listParticipants(id, { participation: filter || undefined }, pageParam, signal),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ParticipantDto | null>(null);
  const rows = people.data?.pages.flatMap((p) => p.items) ?? [];
  const archived = offering.data?.status === 'archived';

  const patchRow = (row: ParticipantDto | null, remove?: string) =>
    qc.setQueriesData<ListData>({ queryKey: ['offerings', 'people', id] }, (old) =>
      old
        ? {
            ...old,
            pages: old.pages.map((p) => ({
              ...p,
              items: remove
                ? p.items.filter((x) => x.id !== remove)
                : p.items.map((x) => (row && x.id === row.id ? row : x)),
            })),
          }
        : old,
    );
  const change = useMutation({
    mutationFn: (v: { row: ParticipantDto; participation: Part }) =>
      changeParticipant(id, v.row.id, v.participation),
    onSuccess: (row) => {
      patchRow(row);
      toast.success(`${row.displayName} is now ${PART_LABEL[row.participation].toLowerCase()}.`);
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const remove = useMutation({
    mutationFn: (row: ParticipantDto) => removeParticipant(id, row.id),
    onSuccess: (_r, row) => {
      patchRow(null, row.id);
      toast.success(`${row.displayName} was removed from this course.`);
      setRemoving(null);
    },
    onError: (err) => toast.error(describeError(err)),
  });

  return (
    <div className="space-y-6">
      <Link to={`/offerings/${id}` as '/'} className="text-sm text-primary underline">
        ← Back to the course
      </Link>
      <PageHeader
        title={manage ? 'People and sections' : 'Class list'}
        {...(offering.data ? { description: offering.data.title } : {})}
        actions={
          manage && !archived ? (
            <Button onClick={() => setAdding(true)}>Add a person</Button>
          ) : undefined
        }
      />

      <div className="max-w-xs">
        <Select label="Show" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">Everyone</option>
          <option value="instructor">Instructors</option>
          <option value="assistant">Assistants</option>
          <option value="learner">Learners</option>
        </Select>
      </div>

      {people.isLoading ? (
        <ListSkeleton rows={6} label="Loading the class list" />
      ) : people.isError ? (
        <ErrorState error={people.error} onRetry={() => void people.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nobody here yet"
          description={
            manage ? 'Add people by hand, or enrol a section below.' : 'No participants match.'
          }
        />
      ) : (
        <>
          <DataTable
            caption="Class list"
            rows={rows}
            rowKey={(r) => r.id}
            columns={[
              { header: 'Name', cell: (r) => <span className="font-medium">{r.displayName}</span> },
              { header: 'Email', cell: (r) => r.email, className: 'break-all' },
              {
                header: 'Role',
                cell: (r) =>
                  manage && !archived ? (
                    <label>
                      <span className="sr-only">Role of {r.displayName}</span>
                      <select
                        value={r.participation}
                        onChange={(e) =>
                          change.mutate({ row: r, participation: e.target.value as Part })
                        }
                        className={`${INPUT_CLASS} !w-auto`}
                      >
                        {(Object.keys(PART_LABEL) as Part[]).map((p) => (
                          <option key={p} value={p}>
                            {PART_LABEL[p]}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    PART_LABEL[r.participation]
                  ),
              },
              {
                header: 'Enrolled through',
                cell: (r) =>
                  r.source === 'section' ? (
                    <Badge>Section {r.sectionCode}</Badge>
                  ) : (
                    <Badge tone="neutral">Added by hand</Badge>
                  ),
              },
            ]}
            {...(manage && !archived
              ? {
                  actions: (r: ParticipantDto) => (
                    <Button
                      variant="danger"
                      aria-label={`Remove ${r.displayName}`}
                      onClick={() => setRemoving(r)}
                    >
                      Remove
                    </Button>
                  ),
                }
              : {})}
          />
          {people.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                loading={people.isFetchingNextPage}
                onClick={() => void people.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </>
      )}

      {manage && (
        <SectionsPanel
          offeringId={id}
          archived={archived}
          onChanged={() => void people.refetch()}
        />
      )}

      {adding && <AddPersonDialog offeringId={id} onClose={() => setAdding(false)} />}
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={removing ? `Remove ${removing.displayName}?` : 'Remove'}
        description={
          removing
            ? `${removing.displayName} will lose access to this course. If they came with a section they are not added back automatically.`
            : ''
        }
        confirmLabel={removing ? `Remove ${removing.displayName}` : 'Remove'}
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </div>
  );
}

// ------------------------------------------------------------------ add a person
function AddPersonDialog({ offeringId, onClose }: { offeringId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Member | null>(null);
  const [part, setPart] = useState<Part>('learner');
  const found = useQuery({
    queryKey: ['members', 'picker', q],
    queryFn: ({ signal }) => listMembers({ q, status: 'active' }, undefined, signal),
    enabled: q.trim().length >= 2,
  });
  const add = useMutation({
    mutationFn: () =>
      addParticipant(offeringId, { userId: (picked as Member).userId, participation: part }),
    onSuccess: (row) => {
      void qc.invalidateQueries({ queryKey: ['offerings', 'people', offeringId] });
      toast.success(
        `${row.displayName} was added as ${PART_LABEL[row.participation].toLowerCase()}.`,
      );
      onClose();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  return (
    <Dialog open onClose={onClose} title="Add a person">
      <div className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="person-q" className="block text-sm font-medium">
            Find a member (name or email)
          </label>
          <input
            id="person-q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
            className={INPUT_CLASS}
          />
        </div>
        {q.trim().length >= 2 && (
          <ul aria-label="Matching members" className="max-h-52 space-y-1 overflow-auto">
            {found.isLoading && <li className="text-sm text-muted-foreground">Searching…</li>}
            {found.data?.items.length === 0 && (
              <li className="text-sm text-muted-foreground">No active member matches.</li>
            )}
            {found.data?.items.map((m) => (
              <li key={m.userId}>
                <button
                  type="button"
                  aria-pressed={picked?.userId === m.userId}
                  onClick={() => setPicked(m)}
                  className="flex min-h-11 w-full flex-col items-start rounded-md border border-border px-3 py-1 text-left text-sm hover:bg-muted aria-pressed:border-primary aria-pressed:bg-muted sm:min-h-9"
                >
                  <span className="font-medium">{m.displayName}</span>
                  <span className="text-xs text-muted-foreground">{m.email}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {picked && (
          <p className="text-sm">
            Selected: <strong>{picked.displayName}</strong>
          </p>
        )}
        <Select
          label="Role in this course"
          value={part}
          onChange={(e) => setPart(e.target.value as Part)}
        >
          {(Object.keys(PART_LABEL) as Part[]).map((p) => (
            <option key={p} value={p}>
              {PART_LABEL[p]}
            </option>
          ))}
        </Select>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={add.isPending}>
            Cancel
          </Button>
          <Button disabled={!picked} loading={add.isPending} onClick={() => add.mutate()}>
            Add {picked ? picked.displayName : 'person'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ sections
function SectionsPanel({
  offeringId,
  archived,
  onChanged,
}: {
  offeringId: string;
  archived: boolean;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const sections = useQuery({
    queryKey: courseKeys.sections(offeringId),
    queryFn: ({ signal }) => listOfferingSections(offeringId, signal),
  });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ sectionId: string; label: string } | null>(null);
  const del = useMutation({
    mutationFn: (s: { sectionId: string; label: string }) =>
      removeOfferingSection(offeringId, s.sectionId),
    onSuccess: (_r, s) => {
      void qc.invalidateQueries({ queryKey: courseKeys.sections(offeringId) });
      toast.success(`${s.label} is no longer enrolled. Its learners are removed in a moment.`);
      setRemoving(null);
      onChanged();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  return (
    <Card title="Enrolled sections">
      <p className="mb-3 text-sm text-muted-foreground">
        Students of an enrolled section become learners and follow the section when they move. This
        runs in the background: the class list above updates within a few seconds.
      </p>
      {sections.isLoading ? (
        <ListSkeleton rows={2} label="Loading sections" />
      ) : sections.isError ? (
        <ErrorState error={sections.error} onRetry={() => void sections.refetch()} />
      ) : sections.data?.items.length === 0 ? (
        <p className="text-sm">No section is enrolled.</p>
      ) : (
        <ul className="space-y-2">
          {sections.data?.items.map((s) => {
            const label = `${s.programCode} ${s.batchLabel} section ${s.sectionCode}`;
            return (
              <li
                key={s.sectionId}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2"
              >
                <span className="min-w-0 flex-1">{label}</span>
                {!archived && (
                  <Button
                    variant="danger"
                    aria-label={`Remove ${label} from this course`}
                    onClick={() => setRemoving({ sectionId: s.sectionId, label })}
                  >
                    Remove
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 flex gap-2">
        {!archived && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Enrol a section
          </Button>
        )}
        <Button variant="ghost" onClick={onChanged}>
          Refresh the class list
        </Button>
      </div>
      {adding && (
        <AddSectionDialog
          offeringId={offeringId}
          onClose={() => setAdding(false)}
          onAdded={onChanged}
        />
      )}
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={removing ? `Stop enrolling ${removing.label}?` : 'Remove section'}
        description="Learners who came with this section lose access when the update runs. People added by hand stay."
        confirmLabel={removing ? `Remove ${removing.label}` : 'Remove'}
        pending={del.isPending}
        onConfirm={() => removing && del.mutate(removing)}
      />
    </Card>
  );
}

function AddSectionDialog({
  offeringId,
  onClose,
  onAdded,
}: {
  offeringId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const qc = useQueryClient();
  const [sel, setSel] = useState({ departmentId: '', programId: '', batchId: '', sectionId: '' });
  const opts = useAcademicOptions(sel);
  const add = useMutation({
    mutationFn: () => addOfferingSection(offeringId, sel.sectionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: courseKeys.sections(offeringId) });
      toast.success('The section is enrolled. Its students join the class list in a moment.');
      onAdded();
      onClose();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const set = (patch: Partial<typeof sel>) => setSel((s) => ({ ...s, ...patch }));
  return (
    <Dialog open onClose={onClose} title="Enrol a section">
      <div className="space-y-4">
        <Select
          label="Department"
          value={sel.departmentId}
          onChange={(e) =>
            set({ departmentId: e.target.value, programId: '', batchId: '', sectionId: '' })
          }
        >
          <option value="">Choose…</option>
          {opts.departments.data?.items.map((d) => (
            <option key={d.id} value={d.id}>
              {d.code} — {d.name}
            </option>
          ))}
        </Select>
        <Select
          label="Program"
          disabled={!sel.departmentId}
          value={sel.programId}
          onChange={(e) => set({ programId: e.target.value, batchId: '', sectionId: '' })}
        >
          <option value="">Choose…</option>
          {opts.programs.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} — {p.name}
            </option>
          ))}
        </Select>
        <Select
          label="Batch"
          disabled={!sel.programId}
          value={sel.batchId}
          onChange={(e) => set({ batchId: e.target.value, sectionId: '' })}
        >
          <option value="">Choose…</option>
          {opts.batches.data?.items.map((b) => (
            <option key={b.id} value={b.id}>
              {b.admissionYear}-{b.graduationYear}
            </option>
          ))}
        </Select>
        <Select
          label="Section"
          disabled={!sel.batchId}
          value={sel.sectionId}
          onChange={(e) => set({ sectionId: e.target.value })}
        >
          <option value="">Choose…</option>
          {opts.sections.data?.items.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code}
            </option>
          ))}
        </Select>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={add.isPending}>
            Cancel
          </Button>
          <Button disabled={!sel.sectionId} loading={add.isPending} onClick={() => add.mutate()}>
            Enrol this section
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

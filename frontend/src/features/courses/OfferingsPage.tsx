import {
  CreateOfferingRequestSchema,
  type OfferingDto,
  type OfferingPage,
} from '@lms/backend/contracts';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { describeError } from '../../shared/api/errors';
import { typeboxResolver } from '../../shared/forms/validation';
import { Button } from '../../shared/ui/button';
import { DataTable } from '../../shared/ui/data-table';
import { ConfirmDialog, Dialog } from '../../shared/ui/dialog';
import { Field } from '../../shared/ui/field';
import { Badge, PageHeader } from '../../shared/ui/layout';
import { Select } from '../../shared/ui/select';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { listEntities } from '../academics/academics.api';
import { usePermissions } from '../auth/useMe';
import {
  courseKeys,
  createOffering,
  listCourses,
  listOfferings,
  offeringAction,
} from './courses.api';
import { offeringsChanged, putOffering } from './offeringCache';

type ListData = InfiniteData<OfferingPage, string | undefined>;
export const STATUS_TONE = { draft: 'warning', published: 'success', archived: 'neutral' } as const;

/** Every offering (a course in a term) of the college, for administrators. */
export function OfferingsPage() {
  const { has } = usePermissions();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [termId, setTermId] = useState('');
  const [creating, setCreating] = useState(false);
  const [toArchive, setToArchive] = useState<OfferingDto | null>(null);
  const filters = { status: status || undefined, termId: termId || undefined };
  const terms = useQuery({
    queryKey: ['options', 'terms', 'all'],
    queryFn: ({ signal }) => listEntities('terms', { archived: 'false', limit: 100 }, signal),
    staleTime: 5 * 60_000,
  });
  const list = useInfiniteQuery<
    OfferingPage,
    Error,
    ListData,
    ReturnType<typeof courseKeys.offeringList>,
    string | undefined
  >({
    queryKey: courseKeys.offeringList(filters),
    queryFn: ({ pageParam, signal }) => listOfferings(filters, pageParam, signal),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const archive = useMutation({
    mutationFn: (o: OfferingDto) => offeringAction(o.id, 'archive'),
    onSuccess: (o) => {
      putOffering(qc, o);
      toast.success(`${o.title} (${o.termName}) is archived.`);
      setToArchive(null);
    },
    onError: (err) => toast.error(describeError(err)),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Offerings"
        description="A course taught in a term. Open one to enrol sections and assign instructors."
        actions={
          has('offering.manage') ? (
            <Button onClick={() => setCreating(true)}>New offering</Button>
          ) : undefined
        }
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Select label="Term" value={termId} onChange={(e) => setTermId(e.target.value)}>
          <option value="">All terms</option>
          {terms.data?.items.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </Select>
      </div>
      {list.isLoading ? (
        <ListSkeleton rows={6} label="Loading offerings" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No offerings found"
          description="Create an offering to teach a course in a term."
          action={
            has('offering.manage') ? (
              <Button onClick={() => setCreating(true)}>New offering</Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <DataTable
            caption="Offerings"
            rows={rows}
            rowKey={(r) => r.id}
            columns={[
              {
                header: 'Course',
                cell: (r) => (
                  <Link
                    to={`/offerings/${r.id}` as '/'}
                    className="font-medium text-primary underline"
                  >
                    {r.courseCode} — {r.title}
                    {r.label ? ` (${r.label})` : ''}
                  </Link>
                ),
              },
              { header: 'Term', cell: (r) => r.termName },
              { header: 'Sections', cell: (r) => r.sectionCount },
              {
                header: 'Status',
                cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>,
              },
            ]}
            {...(has('offering.manage')
              ? {
                  actions: (r: OfferingDto) => (
                    <div className="flex justify-end gap-2">
                      <Link
                        to={`/offerings/${r.id}/people` as '/'}
                        className="inline-flex min-h-11 items-center rounded-md border border-input px-3 text-sm sm:min-h-9"
                        aria-label={`People of ${r.title}`}
                      >
                        People
                      </Link>
                      {r.status !== 'archived' && (
                        <Button
                          variant="secondary"
                          aria-label={`Archive ${r.title}`}
                          onClick={() => setToArchive(r)}
                        >
                          Archive
                        </Button>
                      )}
                    </div>
                  ),
                }
              : {})}
          />
          {list.hasNextPage && (
            <div className="flex justify-center">
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
      {creating && <NewOfferingDialog onClose={() => setCreating(false)} />}
      <ConfirmDialog
        open={!!toArchive}
        onClose={() => setToArchive(null)}
        title={toArchive ? `Archive ${toArchive.title} (${toArchive.termName})?` : 'Archive'}
        description="An archived offering is read only and its class list is frozen."
        confirmLabel={toArchive ? `Archive ${toArchive.courseCode}` : 'Archive'}
        pending={archive.isPending}
        onConfirm={() => toArchive && archive.mutate(toArchive)}
      />
    </div>
  );
}

interface Values {
  courseId: string;
  termId: string;
  label?: string | undefined;
  titleOverride?: string | undefined;
}

function NewOfferingDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const courses = useQuery({
    queryKey: ['options', 'courses'],
    queryFn: ({ signal }) => listCourses({}, undefined, signal),
    staleTime: 60_000,
  });
  const terms = useQuery({
    queryKey: ['options', 'terms', 'all'],
    queryFn: ({ signal }) => listEntities('terms', { archived: 'false', limit: 100 }, signal),
    staleTime: 5 * 60_000,
  });
  const form = useForm<Values>({
    defaultValues: { courseId: '', termId: '', label: '', titleOverride: '' },
    resolver: typeboxResolver<Values>(CreateOfferingRequestSchema, {
      courseId: 'Course',
      termId: 'Term',
    }),
  });
  const { errors } = form.formState;
  const create = useMutation({
    mutationFn: (v: Values) =>
      createOffering({
        ...v,
        label: v.label || undefined,
        titleOverride: v.titleOverride || undefined,
      }),
    onSuccess: (o) => {
      toast.success(`Created ${o.title} for ${o.termName}. Add its instructors next.`);
      offeringsChanged(qc);
      onClose();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  return (
    <Dialog open onClose={onClose} title="New offering">
      <form onSubmit={form.handleSubmit((v) => create.mutate(v))} noValidate className="space-y-4">
        <Select label="Course" error={errors.courseId?.message} {...form.register('courseId')}>
          <option value="">Choose a course…</option>
          {courses.data?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} — {c.title}
            </option>
          ))}
        </Select>
        <Select label="Term" error={errors.termId?.message} {...form.register('termId')}>
          <option value="">Choose a term…</option>
          {terms.data?.items.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Field
          label="Label (optional)"
          hint="Tells apart two runs in one term, e.g. Evening batch"
          autoComplete="off"
          error={errors.label?.message}
          {...form.register('label', { setValueAs: (v: string) => v.trim() || undefined })}
        />
        <Field
          label="Title for this offering (optional)"
          autoComplete="off"
          error={errors.titleOverride?.message}
          {...form.register('titleOverride', { setValueAs: (v: string) => v.trim() || undefined })}
        />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create offering
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

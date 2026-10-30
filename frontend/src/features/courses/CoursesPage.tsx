import { type CourseDto, type CoursePage, CreateCourseRequestSchema } from '@lms/backend/contracts';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { describeError } from '../../shared/api/errors';
import { typeboxResolver } from '../../shared/forms/validation';
import { Button } from '../../shared/ui/button';
import { DataTable } from '../../shared/ui/data-table';
import { ConfirmDialog, Dialog } from '../../shared/ui/dialog';
import { Field, INPUT_CLASS } from '../../shared/ui/field';
import { Badge, PageHeader } from '../../shared/ui/layout';
import { Select } from '../../shared/ui/select';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { departmentOptions, optionKeys } from '../academics/academics.api';
import { usePermissions } from '../auth/useMe';
import {
  type CourseFilters,
  courseKeys,
  createCourse,
  listCourses,
  updateCourse,
} from './courses.api';

type ListData = InfiniteData<CoursePage, string | undefined>;

/** The college's course catalog (administrators). A course may belong to a department or to none (electives). */
export function CoursesPage() {
  const { has } = usePermissions();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [department, setDepartment] = useState('');
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [toArchive, setToArchive] = useState<CourseDto | null>(null);
  const filters: CourseFilters = {
    q: q.trim() || undefined,
    department: department || undefined,
    archived,
  };
  const departments = useQuery({
    queryKey: optionKeys.departments,
    queryFn: ({ signal }) => departmentOptions(signal),
    staleTime: 5 * 60_000,
  });
  const list = useInfiniteQuery<
    CoursePage,
    Error,
    ListData,
    ReturnType<typeof courseKeys.courseList>,
    string | undefined
  >({
    queryKey: courseKeys.courseList(filters),
    queryFn: ({ pageParam, signal }) => listCourses(filters, pageParam, signal),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  const patch = (c: CourseDto) =>
    qc.setQueriesData<ListData>({ queryKey: ['courses', 'list'] }, (old) =>
      old
        ? {
            ...old,
            pages: old.pages.map((p) => ({
              ...p,
              items: p.items.map((x) => (x.id === c.id ? c : x)),
            })),
          }
        : old,
    );
  const archive = useMutation({
    mutationFn: (v: { course: CourseDto; archived: boolean }) =>
      updateCourse(v.course.id, { archived: v.archived }),
    onSuccess: (c) => {
      patch(c);
      toast.success(c.archivedAt ? `${c.code} is archived.` : `${c.code} is active again.`);
      setToArchive(null);
      // an archived course leaves the default list
      if (c.archivedAt && !archived) void qc.invalidateQueries({ queryKey: ['courses', 'list'] });
    },
    onError: (err) => toast.error(describeError(err)),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Courses"
        description="The catalog of the college. A course is taught as an offering in a term."
        actions={
          has('course.create') ? (
            <Button onClick={() => setCreating(true)}>New course</Button>
          ) : undefined
        }
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <label htmlFor="course-q" className="block text-sm font-medium">
            Search code or title
          </label>
          <input
            id="course-q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className={INPUT_CLASS}
            autoComplete="off"
          />
        </div>
        <Select
          label="Department"
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
        >
          <option value="">All courses</option>
          <option value="none">No department (electives, skill courses)</option>
          {departments.data?.items.map((d) => (
            <option key={d.id} value={d.id}>
              {d.code} — {d.name}
            </option>
          ))}
        </Select>
        <label className="flex min-h-11 items-end gap-2 pb-2 text-sm sm:min-h-9">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          Include archived
        </label>
      </div>

      {list.isLoading ? (
        <ListSkeleton rows={6} label="Loading courses" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No courses found"
          description={
            q || department ? 'Try other filters.' : 'Create the first course of the college.'
          }
          action={
            has('course.create') && !q && !department ? (
              <Button onClick={() => setCreating(true)}>New course</Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <DataTable
            caption="Courses"
            rows={rows}
            rowKey={(r) => r.id}
            columns={[
              { header: 'Code', cell: (r) => <span className="font-mono">{r.code}</span> },
              { header: 'Title', cell: (r) => <span className="font-medium">{r.title}</span> },
              {
                header: 'Department',
                cell: (r) =>
                  r.departmentCode ? (
                    `${r.departmentCode}`
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  ),
              },
              { header: 'Credits', cell: (r) => r.credits ?? '—' },
              {
                header: 'Status',
                cell: (r) =>
                  r.archivedAt ? <Badge>Archived</Badge> : <Badge tone="success">Active</Badge>,
              },
            ]}
            {...(has('course.manage')
              ? {
                  actions: (r: CourseDto) =>
                    r.archivedAt ? (
                      <Button
                        variant="secondary"
                        aria-label={`Reactivate ${r.code}`}
                        onClick={() => archive.mutate({ course: r, archived: false })}
                      >
                        Reactivate
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        aria-label={`Archive ${r.code}`}
                        onClick={() => setToArchive(r)}
                      >
                        Archive
                      </Button>
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
      {creating && <NewCourseDialog onClose={() => setCreating(false)} />}
      <ConfirmDialog
        open={!!toArchive}
        onClose={() => setToArchive(null)}
        title={toArchive ? `Archive ${toArchive.code} — ${toArchive.title}?` : 'Archive'}
        description="An archived course cannot get new offerings. It is refused while any of its offerings is not archived."
        confirmLabel={toArchive ? `Archive ${toArchive.code}` : 'Archive'}
        pending={archive.isPending}
        onConfirm={() => toArchive && archive.mutate({ course: toArchive, archived: true })}
      />
    </div>
  );
}

interface Values {
  code: string;
  title: string;
  credits?: number | undefined;
  departmentId?: string | undefined;
}

function NewCourseDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const departments = useQuery({
    queryKey: optionKeys.departments,
    queryFn: ({ signal }) => departmentOptions(signal),
    staleTime: 5 * 60_000,
  });
  const form = useForm<Values>({
    defaultValues: { code: '', title: '', credits: undefined, departmentId: undefined },
    resolver: typeboxResolver<Values>(CreateCourseRequestSchema, {
      code: 'Course code',
      title: 'Title',
      credits: 'Credits',
    }),
  });
  const { errors } = form.formState;
  const create = useMutation({
    mutationFn: (v: Values) => createCourse({ ...v, departmentId: v.departmentId || undefined }),
    onSuccess: (c) => {
      toast.success(`Created ${c.code} — ${c.title}.`);
      void qc.invalidateQueries({ queryKey: ['courses', 'list'] });
      onClose();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  return (
    <Dialog open onClose={onClose} title="New course">
      <form onSubmit={form.handleSubmit((v) => create.mutate(v))} noValidate className="space-y-4">
        <Field
          label="Course code"
          autoComplete="off"
          hint="Letters, digits and . _ - (for example CS101)"
          error={errors.code?.message}
          {...form.register('code')}
        />
        <Field
          label="Title"
          autoComplete="off"
          error={errors.title?.message}
          {...form.register('title')}
        />
        <Field
          label="Credits (optional)"
          type="number"
          step="0.5"
          min="0"
          error={errors.credits?.message}
          {...form.register('credits', {
            setValueAs: (v: string) => (v === '' || v == null ? undefined : Number(v)),
          })}
        />
        <Select
          label="Department (optional)"
          hint="Leave empty for electives, value-added and skill courses"
          error={errors.departmentId?.message}
          {...form.register('departmentId', { setValueAs: (v: string) => v || undefined })}
        >
          <option value="">No department</option>
          {departments.data?.items.map((d) => (
            <option key={d.id} value={d.id}>
              {d.code} — {d.name}
            </option>
          ))}
        </Select>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create course
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

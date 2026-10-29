import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { describeError } from '../../shared/api/errors';
import { typeboxResolver } from '../../shared/forms/validation';
import { Button } from '../../shared/ui/button';
import { DataTable } from '../../shared/ui/data-table';
import { ConfirmDialog, Dialog } from '../../shared/ui/dialog';
import { Field } from '../../shared/ui/field';
import { Badge } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import {
  archiveEntity,
  createEntity,
  deleteEntity,
  type EntityDto,
  type EntityKey,
  listEntities,
  type Page,
  setCurrentYear,
  unarchiveEntity,
  updateEntity,
} from './academics.api';
import { ENTITIES, type EntitySpec } from './entities';

type Query = Record<string, string | undefined>;
type Row = EntityDto[EntityKey] & { id: string; archivedAt: string | null };

const PAGE = 25;
type Data = InfiniteData<Page<Row>, string | undefined>;

/** Form values are strings; the contract wants numbers for the number fields. */
function toBody(spec: EntitySpec, values: Record<string, string>, extra: Record<string, string>) {
  const body: Record<string, unknown> = { ...extra };
  for (const f of spec.fields) {
    const raw = (values[f.name] ?? '').trim();
    if (raw === '') continue;
    body[f.name] = f.kind === 'number' ? Number(raw) : raw;
  }
  return body;
}

/**
 * One academic entity: list (keyset "load more", archived toggle), create, edit, archive/unarchive,
 * delete. `parent` filters the list (the college's other entities are never all loaded) and `create`
 * carries the parent id that a new row needs. Every mutation updates the cached rows in place.
 */
export function EntityPanel({
  entityKey,
  parent,
  createParent,
  blockedReason,
}: {
  entityKey: EntityKey;
  parent: Query;
  createParent: Record<string, string>;
  /** set when the parent has not been chosen yet */
  blockedReason?: string | undefined;
}) {
  const spec = ENTITIES[entityKey] as EntitySpec;
  const qc = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'archive' | 'delete'; row: Row } | null>(null);

  const key = ['academics', entityKey, parent, showArchived] as const;
  const list = useInfiniteQuery<Page<Row>, Error, Data, typeof key, string | undefined>({
    queryKey: key,
    queryFn: ({ pageParam, signal }) =>
      listEntities(
        entityKey,
        {
          ...parent,
          archived: showArchived ? 'all' : 'false',
          limit: PAGE,
          after: pageParam,
        },
        signal,
      ) as unknown as Promise<Page<Row>>,
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !blockedReason,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  const patchRows = (fn: (rows: Row[]) => Row[]) =>
    qc.setQueriesData<Data>({ queryKey: ['academics', entityKey] }, (old) =>
      old ? { ...old, pages: old.pages.map((p) => ({ ...p, items: fn(p.items) })) } : old,
    );
  // The dropdown option lists hold the same entities (the parent pickers of this very page, the members
  // filters). Refetch the ones on screen (small, bounded lists); the rest are marked stale and reload
  // when they are next used. Without this a new department is missing from the "Department" picker.
  const staleOptions = () => {
    void qc.invalidateQueries({ queryKey: ['options'] });
  };

  const replace = (row: Row) => patchRows((items) => items.map((r) => (r.id === row.id ? row : r)));

  const archive = useMutation({
    mutationFn: ({ kind, row }: { kind: 'archive' | 'unarchive'; row: Row }) =>
      (kind === 'archive' ? archiveEntity : unarchiveEntity)(entityKey, row.id) as Promise<Row>,
    onSuccess: (row, v) => {
      if (showArchived) replace(row);
      else patchRows((items) => items.filter((r) => r.id !== row.id));
      staleOptions();
      setConfirm(null);
      toast.success(
        `${spec.nameOf(row as never)} ${v.kind === 'archive' ? 'archived' : 'restored'}.`,
      );
    },
    onError: (err) => {
      setConfirm(null);
      toast.error(describeError(err));
    },
  });
  const remove = useMutation({
    mutationFn: (row: Row) => deleteEntity(entityKey, row.id),
    onSuccess: (_r, row) => {
      patchRows((items) => items.filter((r) => r.id !== row.id));
      staleOptions();
      setConfirm(null);
      toast.success(`${spec.nameOf(row as never)} deleted.`);
    },
    onError: (err) => {
      setConfirm(null);
      toast.error(describeError(err));
    },
  });
  const makeCurrent = useMutation({
    mutationFn: (row: Row) => setCurrentYear(row.id),
    onSuccess: (year) => {
      // only one year is current: clear the flag on the others, set it on this one
      patchRows((items) => items.map((r) => ({ ...r, isCurrent: r.id === year.id }) as Row));
      toast.success(`${year.label} is now the current academic year.`);
    },
    onError: (err) => toast.error(describeError(err)),
  });

  if (blockedReason) return <EmptyState title={blockedReason} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
        <Button onClick={() => setEditing('new')}>Add {spec.singular}</Button>
      </div>

      {list.isPending ? (
        <ListSkeleton label={`Loading ${spec.tab.toLowerCase()}`} />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={`No ${spec.tab.toLowerCase()} yet`}
          description={`Add the first ${spec.singular}.`}
        />
      ) : (
        <>
          <DataTable<Row>
            caption={spec.tab}
            rows={rows}
            rowKey={(r) => r.id}
            columns={[
              ...spec.columns.map((c, i) => ({
                header: c.header,
                cell: (r: Row) => (
                  <>
                    {c.value(r as never)}
                    {i === 0 && 'isCurrent' in r && r.isCurrent && (
                      <>
                        {' '}
                        <Badge tone="success">current</Badge>
                      </>
                    )}
                  </>
                ),
              })),
              {
                header: 'Status',
                cell: (r: Row) =>
                  r.archivedAt ? <Badge tone="warning">archived</Badge> : <Badge>active</Badge>,
              },
            ]}
            actions={(r) => (
              <span className="flex flex-wrap justify-end gap-2">
                {entityKey === 'years' && !r.archivedAt && !('isCurrent' in r && r.isCurrent) && (
                  <Button
                    variant="secondary"
                    loading={makeCurrent.isPending}
                    onClick={() => makeCurrent.mutate(r)}
                  >
                    Set current
                  </Button>
                )}
                {!r.archivedAt && (
                  <Button variant="secondary" onClick={() => setEditing(r)}>
                    Edit
                  </Button>
                )}
                {r.archivedAt ? (
                  <Button
                    variant="secondary"
                    onClick={() => archive.mutate({ kind: 'unarchive', row: r })}
                  >
                    Restore
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => setConfirm({ kind: 'archive', row: r })}
                  >
                    Archive
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setConfirm({ kind: 'delete', row: r })}>
                  Delete
                </Button>
              </span>
            )}
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

      {editing && (
        <EntityForm
          spec={spec}
          row={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          createParent={createParent}
          onSaved={(row, created) => {
            if (created) {
              patchRows((items) => [row, ...items]);
              void qc.invalidateQueries({
                queryKey: ['academics', entityKey],
                refetchType: 'none',
              });
            } else {
              replace(row);
            }
            staleOptions();
            setEditing(null);
            toast.success(`${spec.nameOf(row as never)} ${created ? 'added' : 'saved'}.`);
          }}
        />
      )}

      <ConfirmDialog
        open={confirm?.kind === 'archive'}
        onClose={() => setConfirm(null)}
        pending={archive.isPending}
        onConfirm={() => confirm && archive.mutate({ kind: 'archive', row: confirm.row })}
        title={`Archive ${confirm ? spec.nameOf(confirm.row as never) : ''}?`}
        description={`The ${spec.singular} is hidden from pickers and new records cannot use it. It can be restored. Archiving is refused while active items still belong to it.`}
        confirmLabel={`Archive ${confirm ? spec.nameOf(confirm.row as never) : ''}`}
      />
      <ConfirmDialog
        open={confirm?.kind === 'delete'}
        onClose={() => setConfirm(null)}
        pending={remove.isPending}
        onConfirm={() => confirm && remove.mutate(confirm.row)}
        title={`Delete ${confirm ? spec.nameOf(confirm.row as never) : ''}?`}
        description={`This permanently deletes the ${spec.singular}. It is refused when anything refers to it; archive it instead.`}
        confirmLabel={`Delete ${confirm ? spec.nameOf(confirm.row as never) : ''}`}
      />
    </div>
  );
}

function EntityForm({
  spec,
  row,
  createParent,
  onClose,
  onSaved,
}: {
  spec: EntitySpec;
  row: Row | null;
  createParent: Record<string, string>;
  onClose: () => void;
  onSaved: (row: Row, created: boolean) => void;
}) {
  const fields = row ? spec.fields.filter((f) => f.editable) : spec.fields;
  const initial = Object.fromEntries(
    fields.map((f) => [
      f.name,
      row ? String((row as unknown as Record<string, unknown>)[f.name] ?? '') : '',
    ]),
  );
  const form = useForm<Record<string, string>>({
    defaultValues: initial,
    resolver: async (values, ctx, opts) => {
      const result = await typeboxResolver<Record<string, string>>(row ? spec.update : spec.create)(
        toBody(spec, values, row ? {} : createParent) as never,
        ctx,
        opts,
      );
      return Object.keys(result.errors).length > 0 ? result : { values, errors: {} };
    },
  });
  const save = useMutation({
    mutationFn: (values: Record<string, string>) =>
      row
        ? (updateEntity(spec.key, row.id, toBody(spec, values, {})) as Promise<Row>)
        : (createEntity(spec.key, toBody(spec, values, createParent)) as Promise<Row>),
    onSuccess: (saved) => onSaved(saved, !row),
    onError: (err) => toast.error(describeError(err)),
  });
  const { errors } = form.formState;
  // an error on something this form does not show (a parent id) must still be visible
  const hidden = Object.entries(errors).find(([name]) => !fields.some((f) => f.name === name));
  return (
    <Dialog
      open
      onClose={onClose}
      title={row ? `Edit ${spec.nameOf(row as never)}` : `Add ${spec.singular}`}
    >
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate className="space-y-4">
        {fields.map((f) => (
          <Field
            key={f.name}
            label={f.label}
            type={f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : 'text'}
            hint={f.hint}
            error={errors[f.name]?.message}
            {...form.register(f.name)}
          />
        ))}
        {hidden && (
          <p role="alert" className="text-sm text-danger">
            {String(hidden[1]?.message ?? 'Something is missing.')}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

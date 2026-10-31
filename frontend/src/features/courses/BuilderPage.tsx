import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { OutlineDto, OutlineItem, OutlineModule } from '@lms/backend/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { ConfirmDialog, Dialog as ModalDialog } from '../../shared/ui/dialog';
import { Field } from '../../shared/ui/field';
import { Badge, PageHeader } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { CopyDialog } from './CopyDialog';
import {
  courseKeys,
  createModule,
  deleteItem,
  deleteModule,
  getOffering,
  getOutline,
  moveItem,
  moveModule,
  offeringAction,
  updateModule,
} from './courses.api';
import { prefetchEditor } from './editor/loadEditor';
import { ItemDialog, type ItemKindChoice, toLocalInput } from './ItemDialog';
import { putOffering } from './offeringCache';
import {
  afterIdFor,
  patchOutline,
  withItemMoved,
  withModule,
  withModuleChanged,
  withModuleMoved,
  withoutItem,
  withoutModule,
} from './outlineCache';

// The instructor's builder: modules and items with drag-and-drop AND plain "move up / down" buttons (the keyboard
// and screen-reader way), text / file / link items, publish and "opens on" dates, copy from another offering.
// Every change answers with the changed row and patches the cached outline; a failed move is rolled back.

type Dialog =
  | {
      type: 'item';
      moduleId: string;
      kind: ItemKindChoice;
      item?: OutlineItem;
      after?: string | null;
    }
  | { type: 'delete-module'; module: OutlineModule }
  | { type: 'delete-item'; item: OutlineItem }
  | { type: 'rename'; module: OutlineModule }
  | { type: 'copy' }
  | null;

const KIND_LABEL: Record<string, string> = {
  text: 'Text',
  file: 'File',
  link: 'Link',
  video: 'Video',
};

export function BuilderPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const qc = useQueryClient();
  const outline = useQuery({
    queryKey: courseKeys.outline(id),
    queryFn: ({ signal }) => getOutline(id, signal),
  });
  const offering = useQuery({
    queryKey: courseKeys.offering(id),
    queryFn: ({ signal }) => getOffering(id, signal),
  });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [announcement, setAnnouncement] = useState('');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // once the builder is on screen, fetch the editor chunk in idle time: opening a text item then feels instant
  const loaded = !!outline.data?.canEdit;
  useEffect(() => {
    if (loaded) prefetchEditor();
  }, [loaded]);

  const snapshot = () => qc.getQueryData<OutlineDto>(courseKeys.outline(id));
  const restore = (s: OutlineDto | undefined) => qc.setQueryData(courseKeys.outline(id), s);

  const addModule = useMutation({
    mutationFn: () =>
      createModule(id, { title: `Module ${(outline.data?.modules.length ?? 0) + 1}` }),
    onSuccess: (m) => {
      patchOutline(qc, id, (o) => withModule(o, m, undefined));
      toast.success(`Added “${m.title}”. Rename it from its menu.`);
      setDialog({ type: 'rename', module: { ...m, hasProgress: false, items: [] } });
    },
    onError: (err) => toast.error(describeError(err)),
  });

  const status = useMutation({
    mutationFn: (action: 'publish' | 'unpublish') => offeringAction(id, action),
    onSuccess: (o) => {
      putOffering(qc, o);
      toast.success(
        o.status === 'published' ? 'The course is published.' : 'The course is back to draft.',
      );
    },
    onError: (err) => toast.error(describeError(err)),
  });

  if (outline.isLoading || offering.isLoading)
    return <ListSkeleton rows={5} label="Loading the course" />;
  if (outline.isError || !outline.data) {
    return <ErrorState error={outline.error} onRetry={() => void outline.refetch()} />;
  }
  const data = outline.data;
  const title = offering.data?.title ?? 'Course';
  if (!data.canEdit) {
    return (
      <EmptyState
        title="You cannot edit this course"
        description="Only its instructors can change the content."
        action={
          <Link to={`/offerings/${id}` as '/'} className="text-primary underline">
            Back to the course
          </Link>
        }
      />
    );
  }

  // ---- reordering (drag and drop, and the buttons)
  const moveModuleTo = (from: number, to: number) => {
    const mods = data.modules;
    const target = mods[from];
    if (!target || to < 0 || to >= mods.length || from === to) return;
    const after = afterIdFor(
      mods.map((m) => m.id),
      from,
      to,
    );
    const before = snapshot();
    patchOutline(qc, id, (o) => withModuleMoved(o, target.id, after));
    setAnnouncement(`${target.title} moved to position ${to + 1} of ${mods.length}.`);
    moveModule(id, target.id, after).catch((err) => {
      restore(before);
      toast.error(describeError(err));
    });
  };
  const onModuleDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = data.modules.map((m) => m.id);
    moveModuleTo(ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
  };

  const moveItemTo = (m: OutlineModule, from: number, to: number) => {
    const item = m.items[from];
    if (!item || to < 0 || to >= m.items.length || from === to) return;
    const after = afterIdFor(
      m.items.map((i) => i.id),
      from,
      to,
    );
    const before = snapshot();
    patchOutline(qc, id, (o) => withItemMoved(o, item.id, m.id, after));
    setAnnouncement(`${item.title} moved to position ${to + 1} of ${m.items.length}.`);
    moveItem(id, item.id, { after }).catch((err) => {
      restore(before);
      toast.error(describeError(err));
    });
  };
  const moveItemToModule = (item: OutlineItem, target: OutlineModule) => {
    const last = target.items[target.items.length - 1];
    const after = last ? last.id : null;
    const before = snapshot();
    patchOutline(qc, id, (o) => withItemMoved(o, item.id, target.id, after));
    setAnnouncement(`${item.title} moved to ${target.title}.`);
    moveItem(id, item.id, { moduleId: target.id, after }).catch((err) => {
      restore(before);
      toast.error(describeError(err));
    });
  };

  const published = offering.data?.status === 'published';
  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        description="Build the course: modules hold text, files and links."
        actions={
          <>
            <Link
              to={`/offerings/${id}` as '/'}
              className="inline-flex min-h-11 items-center rounded-md border border-input px-4 text-sm sm:min-h-9"
            >
              Preview as a learner
            </Link>
            <Button variant="secondary" onClick={() => setDialog({ type: 'copy' })}>
              Copy content from…
            </Button>
            {offering.data && offering.data.status !== 'archived' && (
              <Button
                loading={status.isPending}
                onClick={() => status.mutate(published ? 'unpublish' : 'publish')}
              >
                {published ? 'Unpublish course' : 'Publish course'}
              </Button>
            )}
          </>
        }
      />
      <p className="text-sm text-muted-foreground">
        {published ? (
          <Badge tone="success">Published</Badge>
        ) : offering.data?.status === 'archived' ? (
          <Badge>Archived</Badge>
        ) : (
          <Badge tone="warning">Draft: learners cannot see this course yet</Badge>
        )}
      </p>
      {offering.data?.copyStatus === 'running' && (
        <p role="status" className="rounded-md border border-border p-3 text-sm">
          Content is being copied into this course. It appears here when it is done.{' '}
          <button
            type="button"
            className="text-primary underline"
            onClick={() => void outline.refetch()}
          >
            Check now
          </button>
        </p>
      )}

      {/* spoken to screen readers after every move */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {data.modules.length === 0 ? (
        <EmptyState
          title="No modules yet"
          description="Add a module, then put text, files and links in it."
          action={
            <Button loading={addModule.isPending} onClick={() => addModule.mutate()}>
              Add a module
            </Button>
          }
        />
      ) : (
        <>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onModuleDragEnd}
          >
            <SortableContext
              items={data.modules.map((m) => m.id)}
              strategy={verticalListSortingStrategy}
            >
              <ol className="space-y-4">
                {data.modules.map((m, index) => (
                  <ModuleCard
                    key={m.id}
                    offeringId={id}
                    module={m}
                    index={index}
                    count={data.modules.length}
                    modules={data.modules}
                    sensors={sensors}
                    onMove={(to) => moveModuleTo(index, to)}
                    onItemMove={(from, to) => moveItemTo(m, from, to)}
                    onItemToModule={moveItemToModule}
                    onDialog={setDialog}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
          <Button
            variant="secondary"
            loading={addModule.isPending}
            onClick={() => addModule.mutate()}
          >
            Add a module
          </Button>
        </>
      )}

      {dialog?.type === 'item' && (
        <ItemDialog
          offeringId={id}
          moduleId={dialog.moduleId}
          kind={dialog.kind}
          item={dialog.item}
          after={dialog.after}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === 'rename' && (
        <RenameDialog offeringId={id} module={dialog.module} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === 'copy' && <CopyDialog offeringId={id} onClose={() => setDialog(null)} />}
      <DeleteDialogs offeringId={id} dialog={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}

// ------------------------------------------------------------------ one module
function ModuleCard({
  offeringId,
  module: m,
  index,
  count,
  modules,
  sensors,
  onMove,
  onItemMove,
  onItemToModule,
  onDialog,
}: {
  offeringId: string;
  module: OutlineModule;
  index: number;
  count: number;
  modules: OutlineModule[];
  sensors: ReturnType<typeof useSensors>;
  onMove: (to: number) => void;
  onItemMove: (from: number, to: number) => void;
  onItemToModule: (item: OutlineItem, target: OutlineModule) => void;
  onDialog: (d: Dialog) => void;
}) {
  const qc = useQueryClient();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: m.id,
  });
  const toggle = useMutation({
    mutationFn: (published: boolean) => updateModule(offeringId, m.id, { published }),
    onSuccess: (mod) => patchOutline(qc, offeringId, (o) => withModuleChanged(o, mod)),
    onError: (err) => toast.error(describeError(err)),
  });
  const onItemDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = m.items.map((i) => i.id);
    onItemMove(ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
  };
  const when = m.availableFrom ? new Date(m.availableFrom).toLocaleString() : null;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`rounded-md border border-border bg-surface ${isDragging ? 'opacity-70 shadow-lg' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <button
          type="button"
          aria-label={`Drag module ${m.title}`}
          className="min-h-11 min-w-11 cursor-grab touch-none rounded-md border border-input text-lg sm:min-h-9 sm:min-w-9"
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
        <h2 className="min-w-0 flex-1 text-lg font-semibold">{m.title}</h2>
        {!m.published && <Badge tone="warning">Hidden</Badge>}
        {when && <Badge>Opens {when}</Badge>}
        <div className="flex flex-wrap gap-1">
          <Button
            variant="secondary"
            aria-label={`Move module ${m.title} up`}
            disabled={index === 0}
            onClick={() => onMove(index - 1)}
          >
            ↑
          </Button>
          <Button
            variant="secondary"
            aria-label={`Move module ${m.title} down`}
            disabled={index === count - 1}
            onClick={() => onMove(index + 1)}
          >
            ↓
          </Button>
          <Button
            variant="secondary"
            aria-label={`Rename module ${m.title}`}
            onClick={() => onDialog({ type: 'rename', module: m })}
          >
            Rename
          </Button>
          <Button
            variant="secondary"
            aria-pressed={m.published}
            aria-label={`${m.published ? 'Hide' : 'Show'} module ${m.title} to learners`}
            loading={toggle.isPending}
            onClick={() => toggle.mutate(!m.published)}
          >
            {m.published ? 'Hide' : 'Show'}
          </Button>
          <Button
            variant="danger"
            aria-label={`Delete module ${m.title}`}
            onClick={() => onDialog({ type: 'delete-module', module: m })}
          >
            Delete
          </Button>
        </div>
      </div>

      <div className="p-3">
        {m.items.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">Nothing here yet.</p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onItemDragEnd}
          >
            <SortableContext
              items={m.items.map((i) => i.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="space-y-2">
                {m.items.map((item, i) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    index={i}
                    count={m.items.length}
                    otherModules={modules.filter((x) => x.id !== m.id)}
                    onMove={(to) => onItemMove(i, to)}
                    onToModule={(target) => onItemToModule(item, target)}
                    onEdit={() =>
                      onDialog({
                        type: 'item',
                        moduleId: m.id,
                        kind: item.kind as ItemKindChoice,
                        item,
                      })
                    }
                    onDelete={() => onDialog({ type: 'delete-item', item })}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {(['text', 'file', 'link', 'video'] as const).map((k) => (
            <Button
              key={k}
              variant="secondary"
              onClick={() => onDialog({ type: 'item', moduleId: m.id, kind: k })}
            >
              Add {k}
            </Button>
          ))}
        </div>
      </div>
    </li>
  );
}

function ItemRow({
  item,
  index,
  count,
  otherModules,
  onMove,
  onToModule,
  onEdit,
  onDelete,
}: {
  item: OutlineItem;
  index: number;
  count: number;
  otherModules: OutlineModule[];
  onMove: (to: number) => void;
  onToModule: (target: OutlineModule) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });
  const when = item.availableFrom ? new Date(item.availableFrom).toLocaleString() : null;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex flex-wrap items-center gap-2 rounded-md border border-border p-2 ${isDragging ? 'opacity-70 shadow-lg' : ''}`}
    >
      <button
        type="button"
        aria-label={`Drag ${item.title}`}
        className="min-h-11 min-w-11 cursor-grab touch-none rounded-md border border-input sm:min-h-9 sm:min-w-9"
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      <Badge>{KIND_LABEL[item.kind] ?? item.kind}</Badge>
      <span className="min-w-0 flex-1 break-words font-medium">{item.title}</span>
      {item.video?.status === 'processing' && (
        <Badge tone="warning">Processing {item.video.progress}%</Badge>
      )}
      {item.video?.status === 'failed' && <Badge tone="danger">Video failed</Badge>}
      {item.video?.status === 'ready' && item.video.durationMs ? (
        <Badge>{Math.max(1, Math.round(item.video.durationMs / 60000))} min</Badge>
      ) : null}
      {!item.published && <Badge tone="warning">Hidden</Badge>}
      {when && <Badge>Opens {toLocalInput(item.availableFrom).replace('T', ' ') || when}</Badge>}
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="secondary"
          aria-label={`Move ${item.title} up`}
          disabled={index === 0}
          onClick={() => onMove(index - 1)}
        >
          ↑
        </Button>
        <Button
          variant="secondary"
          aria-label={`Move ${item.title} down`}
          disabled={index === count - 1}
          onClick={() => onMove(index + 1)}
        >
          ↓
        </Button>
        {otherModules.length > 0 && (
          <label className="text-sm">
            <span className="sr-only">Move {item.title} to another module</span>
            <select
              value=""
              onChange={(e) => {
                const target = otherModules.find((x) => x.id === e.target.value);
                if (target) onToModule(target);
              }}
              className="min-h-11 rounded-md border border-input bg-surface px-2 sm:min-h-9"
            >
              <option value="">Move to…</option>
              {otherModules.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button variant="secondary" aria-label={`Edit ${item.title}`} onClick={onEdit}>
          Edit
        </Button>
        <Button variant="danger" aria-label={`Delete ${item.title}`} onClick={onDelete}>
          Delete
        </Button>
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ dialogs
function RenameDialog({
  offeringId,
  module: m,
  onClose,
}: {
  offeringId: string;
  module: OutlineModule;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const form = useForm<{ title: string }>({ defaultValues: { title: m.title } });
  const ref = useRef<HTMLInputElement | null>(null);
  const save = useMutation({
    mutationFn: (v: { title: string }) => updateModule(offeringId, m.id, { title: v.title.trim() }),
    onSuccess: (mod) => {
      patchOutline(qc, offeringId, (o) => withModuleChanged(o, mod));
      onClose();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const reg = form.register('title', {
    required: 'Title is required.',
    maxLength: { value: 200, message: 'Title is too long.' },
  });
  return (
    <ModalDialog open onClose={onClose} title="Rename module">
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate className="space-y-4">
        <Field
          label="Title"
          autoComplete="off"
          error={form.formState.errors.title?.message}
          {...reg}
          ref={(el) => {
            reg.ref(el);
            ref.current = el;
          }}
        />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

function DeleteDialogs({
  offeringId,
  dialog,
  onClose,
}: {
  offeringId: string;
  dialog: Dialog;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const delModule = useMutation({
    mutationFn: (m: OutlineModule) => deleteModule(offeringId, m.id),
    onSuccess: (r, m) => {
      patchOutline(qc, offeringId, (o) => withoutModule(o, m.id));
      toast.success(
        r.status === 'archived'
          ? `Archived module “${m.title}”. Its learner progress is kept.`
          : `Deleted module “${m.title}”.`,
      );
      onClose();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const delItem = useMutation({
    mutationFn: (i: OutlineItem) => deleteItem(offeringId, i.id),
    onSuccess: (r, i) => {
      patchOutline(qc, offeringId, (o) => withoutItem(o, i.id));
      toast.success(
        r.status === 'archived'
          ? `Archived “${i.title}”. Its learner progress is kept.`
          : `Deleted “${i.title}”.`,
      );
      onClose();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  return (
    <>
      <ConfirmDialog
        open={dialog?.type === 'delete-module'}
        onClose={onClose}
        title={
          dialog?.type === 'delete-module'
            ? `${dialog.module.hasProgress ? 'Archive' : 'Delete'} module “${dialog.module.title}”?`
            : 'Delete module'
        }
        description={
          dialog?.type === 'delete-module'
            ? dialog.module.hasProgress
              ? `Learners have progress in this module, so it will be archived: it and its ${dialog.module.items.length} item${dialog.module.items.length === 1 ? '' : 's'} disappear from the course, the builder and the percentages, and the learners' history is kept.`
              : `This also deletes its ${dialog.module.items.length} item${dialog.module.items.length === 1 ? '' : 's'}. This cannot be undone.`
            : ''
        }
        confirmLabel={
          dialog?.type === 'delete-module'
            ? `${dialog.module.hasProgress ? 'Archive' : 'Delete'} “${dialog.module.title}”`
            : 'Delete'
        }
        pending={delModule.isPending}
        onConfirm={() => dialog?.type === 'delete-module' && delModule.mutate(dialog.module)}
      />
      <ConfirmDialog
        open={dialog?.type === 'delete-item'}
        onClose={onClose}
        title={
          dialog?.type === 'delete-item'
            ? `${dialog.item.hasProgress ? 'Archive' : 'Delete'} “${dialog.item.title}”?`
            : 'Delete item'
        }
        description={
          dialog?.type === 'delete-item' && dialog.item.hasProgress
            ? "This item has learner progress, so it will be archived: it disappears from the course, the builder and the percentages, and the learners' history is kept."
            : 'Learners will no longer see it. This cannot be undone.'
        }
        confirmLabel={
          dialog?.type === 'delete-item'
            ? `${dialog.item.hasProgress ? 'Archive' : 'Delete'} “${dialog.item.title}”`
            : 'Delete'
        }
        pending={delItem.isPending}
        onConfirm={() => dialog?.type === 'delete-item' && delItem.mutate(dialog.item)}
      />
    </>
  );
}

import type { ItemDto, OutlineItem } from '@lms/backend/contracts';
import { Type } from '@sinclair/typebox';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { describeError } from '../../shared/api/errors';
import { typeboxResolver } from '../../shared/forms/validation';
import { Button } from '../../shared/ui/button';
import { Dialog } from '../../shared/ui/dialog';
import { Field } from '../../shared/ui/field';
import { Select } from '../../shared/ui/select';
import { Skeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { VideoField } from '../video/VideoField';
import { courseKeys, createItem, getItem, updateItem } from './courses.api';
import { loadEditor } from './editor/loadEditor';
import { patchOutline, withItem, withItemChanged } from './outlineCache';
import { uploadFile } from './uploadFile';

// The rich-text editor is its own chunk: it is only fetched when a text item is opened for editing (or ahead of
// time, in idle time, by the builder page).
const RichTextEditor = lazy(loadEditor);

const FormSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  url: Type.Optional(Type.String({ maxLength: 2000 })),
  availableFrom: Type.Optional(Type.String()),
  published: Type.Boolean(),
  required: Type.Boolean(),
  completion: Type.String(),
});
interface Values {
  title: string;
  url?: string | undefined;
  availableFrom?: string | undefined;
  published: boolean;
  /** counts towards the learner's progress */
  required: boolean;
  /** manual (Mark as done) | on_view (opening it); a video is always completed by watching it */
  completion: string;
}

export type ItemKindChoice = 'text' | 'file' | 'link' | 'video';

/** ISO time -> the value of an <input type="datetime-local"> in the viewer's time zone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (v: string | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

export function ItemDialog({
  offeringId,
  moduleId,
  kind,
  item,
  after,
  onClose,
}: {
  offeringId: string;
  moduleId: string;
  kind: ItemKindChoice;
  /** set when editing */
  item?: OutlineItem | undefined;
  /** where a new item goes (undefined = the end of the module) */
  after?: string | null | undefined;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const editing = !!item;
  // the text of an existing item is not in the outline: fetch it when the dialog opens
  const full = useQuery({
    queryKey: courseKeys.item(offeringId, item?.id ?? ''),
    queryFn: ({ signal }) => getItem(offeringId, (item as OutlineItem).id, signal),
    enabled: editing && kind === 'text',
  });
  const [body, setBody] = useState<unknown>(null);
  const [bodyTouched, setBodyTouched] = useState(false);
  const [fileId, setFileId] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(item?.file?.name ?? null);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  // video: the one to save (null = keep the item's current one), whether it can be saved, and whether bytes travel
  const [videoId, setVideoId] = useState<string | null>(item?.video?.id ?? null);
  const [videoReady, setVideoReady] = useState(item?.video?.status === 'ready');
  const [videoBusy, setVideoBusy] = useState(false);
  const onVideoSelect = useCallback((id: string | null, ready: boolean) => {
    setVideoId(id);
    setVideoReady(ready);
  }, []);

  const form = useForm<Values>({
    defaultValues: {
      title: item?.title ?? '',
      url: item?.url ?? 'https://',
      availableFrom: toLocalInput(item?.availableFrom ?? null),
      published: item?.published ?? false,
      required: item?.required ?? true,
      completion: item?.completion ?? (kind === 'text' ? 'manual' : 'on_view'),
    },
    resolver: typeboxResolver<Values>(FormSchema, { title: 'Title', url: 'Web address' }),
  });
  const { errors } = form.formState;

  const save = useMutation({
    mutationFn: async (v: Values): Promise<{ saved: ItemDto; created: boolean }> => {
      const common = {
        title: v.title.trim(),
        published: v.published,
        availableFrom: fromLocalInput(v.availableFrom),
        required: v.required,
        // a video is completed by watching it: the server sets that rule
        ...(kind === 'video' ? {} : { completion: v.completion }),
      };
      const extra =
        kind === 'link'
          ? { url: v.url?.trim() }
          : kind === 'file'
            ? fileId
              ? { fileId }
              : {}
            : kind === 'video'
              ? videoId && videoId !== item?.video?.id
                ? { videoId }
                : {}
              : bodyTouched || !editing
                ? { body: body ?? { type: 'doc', content: [] } }
                : {};
      if (item)
        return {
          saved: await updateItem(offeringId, item.id, { ...common, ...extra }),
          created: false,
        };
      return {
        saved: await createItem(offeringId, moduleId, {
          kind,
          ...common,
          ...extra,
          ...(after === undefined ? {} : { after }),
        }),
        created: true,
      };
    },
    onSuccess: ({ saved, created }) => {
      patchOutline(qc, offeringId, (o) =>
        created ? withItem(o, saved, after) : withItemChanged(o, saved),
      );
      qc.setQueryData(courseKeys.item(offeringId, saved.id), saved);
      toast.success(created ? `Added “${saved.title}”.` : `Saved “${saved.title}”.`);
      onClose();
    },
    onError: (err) => toast.error(describeError(err)),
  });

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setUploadError(null);
    setProgress(0);
    abort.current = new AbortController();
    try {
      const done = await uploadFile(offeringId, file, setProgress, abort.current.signal);
      setFileId(done.id);
      setFileName(done.name);
      if (!form.getValues('title')) form.setValue('title', done.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      setUploadError(describeError(err));
    } finally {
      setProgress(null);
      abort.current = null;
    }
  };

  const canSave =
    kind === 'video'
      ? videoReady && !videoBusy
      : kind !== 'file' || !!fileId || (editing && !!item?.file);
  const label = { text: 'text', file: 'file', link: 'link', video: 'video' }[kind];
  return (
    <Dialog open onClose={onClose} title={`${editing ? 'Edit' : 'Add'} ${label}`}>
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate className="space-y-4">
        <Field
          label="Title"
          autoComplete="off"
          error={errors.title?.message}
          {...form.register('title')}
        />

        {kind === 'link' && (
          <Field
            label="Web address"
            type="url"
            inputMode="url"
            autoComplete="off"
            hint="Starts with https:// or http://"
            error={errors.url?.message}
            {...form.register('url')}
          />
        )}

        {kind === 'file' && (
          <div className="space-y-2">
            <label htmlFor="item-file" className="block text-sm font-medium">
              File
            </label>
            <input
              id="item-file"
              type="file"
              disabled={progress !== null}
              onChange={(e) => void pick(e.target.files?.[0])}
              className="block w-full text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:border-input file:bg-surface file:px-3 sm:file:min-h-9"
              aria-describedby="item-file-hint"
            />
            <p id="item-file-hint" className="text-xs text-muted-foreground">
              PDF, images, Office documents, text, CSV, ZIP, MP4 or MP3 — up to 50 MB.
            </p>
            {progress !== null && (
              <div className="flex items-center gap-2">
                <progress
                  max={1}
                  value={progress}
                  aria-label="Upload progress"
                  className="h-2 flex-1"
                />
                <span className="w-10 text-right text-xs tabular-nums">
                  {Math.round(progress * 100)}%
                </span>
                <Button variant="secondary" onClick={() => abort.current?.abort()}>
                  Cancel upload
                </Button>
              </div>
            )}
            {uploadError && (
              <p role="alert" className="text-sm text-danger">
                {uploadError}
              </p>
            )}
            {fileName && progress === null && !uploadError && (
              <p className="text-sm">
                {fileId ? 'Uploaded: ' : 'Current file: '}
                <strong>{fileName}</strong>
              </p>
            )}
          </div>
        )}

        {kind === 'video' && (
          <VideoField
            offeringId={offeringId}
            current={item?.video ?? null}
            itemId={item?.id}
            itemTitle={item?.title}
            onSelect={onVideoSelect}
            onBusy={setVideoBusy}
          />
        )}

        {kind === 'text' && (
          <div className="space-y-1">
            <p className="text-sm font-medium" id="body-label">
              Text
            </p>
            {editing && full.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <Suspense fallback={<Skeleton className="h-40 w-full" />}>
                <RichTextEditor
                  label="Text of this item"
                  value={editing ? (full.data?.body ?? null) : null}
                  onChange={(doc) => {
                    setBody(doc);
                    setBodyTouched(true);
                  }}
                />
              </Suspense>
            )}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-9">
            <input type="checkbox" className="h-5 w-5" {...form.register('published')} />
            Visible to learners
          </label>
          <Field
            label="Opens on (optional)"
            type="datetime-local"
            hint="Learners see the title, not the content, until then."
            error={errors.availableFrom?.message}
            {...form.register('availableFrom')}
          />
        </div>

        <fieldset className="grid gap-4 rounded-md border border-border p-3 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium">Progress</legend>
          <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-9">
            <input type="checkbox" className="h-5 w-5" {...form.register('required')} />
            Required (counts towards course progress)
          </label>
          {kind === 'video' ? (
            <p className="text-sm text-muted-foreground">
              Completed when the learner has watched enough of the video (the share is a setting of
              the course).
            </p>
          ) : (
            <Select label="Completed when" {...form.register('completion')}>
              <option value="manual">The learner marks it as done</option>
              <option value="on_view">The learner opens it</option>
            </Select>
          )}
        </fieldset>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending} disabled={!canSave || progress !== null}>
            {editing ? 'Save changes' : `Add ${label}`}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

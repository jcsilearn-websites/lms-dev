import type { ItemVideo, VideoAsset } from '@lms/backend/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../shared/api/client';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { ConfirmDialog } from '../../shared/ui/dialog';
import { Skeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { useMe } from '../auth/useMe';
import { loadPlayer } from './loadPlayer';
import { resumeStore, type UploadResume, uploadVideoFile } from './uploader';
import { addCaption, deleteCaption, getVideo, playbackSession, videoKeys } from './video.api';

const VideoPlayer = lazy(loadPlayer);

// The video part of the item dialog: choose a file, upload it (progress, cancel, resume), watch it being processed,
// replace it, add WebVTT captions, preview it. The item itself (title, visibility, date) is the dialog's form.

const LANGUAGES: [string, string][] = [
  ['en', 'English'],
  ['hi', 'Hindi'],
  ['ta', 'Tamil'],
  ['te', 'Telugu'],
  ['ml', 'Malayalam'],
  ['kn', 'Kannada'],
  ['mr', 'Marathi'],
  ['bn', 'Bengali'],
  ['gu', 'Gujarati'],
  ['pa', 'Punjabi'],
  ['ur', 'Urdu'],
];

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export interface VideoFieldProps {
  offeringId: string;
  /** the video the item has now (editing) */
  current: ItemVideo | null;
  /** the item being edited (a preview needs one) */
  itemId?: string | undefined;
  itemTitle?: string | undefined;
  /** tells the dialog which video to save and whether it can be saved yet */
  onSelect: (videoId: string | null, ready: boolean) => void;
  /** true while bytes are travelling (the dialog cannot be submitted) */
  onBusy: (busy: boolean) => void;
}

export function VideoField({
  offeringId,
  current,
  itemId,
  itemTitle,
  onSelect,
  onBusy,
}: VideoFieldProps) {
  const qc = useQueryClient();
  const me = useMe().data;
  const [videoId, setVideoId] = useState<string | null>(current?.id ?? null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const [remembered] = useState(() => resumeStore.load(offeringId));

  const asset = useQuery({
    queryKey: videoKeys.video(offeringId, videoId ?? ''),
    queryFn: ({ signal }) => getVideo(offeringId, videoId as string, signal),
    enabled: !!videoId,
    // processing takes a while: look again every couple of seconds until it is ready or failed
    refetchInterval: (q) => (q.state.data?.status === 'processing' ? 2000 : false),
  });
  const video: VideoAsset | undefined = asset.data;
  const ready = video?.status === 'ready';

  useEffect(() => {
    onSelect(videoId, ready);
  }, [videoId, ready, onSelect]);
  useEffect(() => {
    onBusy(progress !== null);
  }, [progress, onBusy]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setProgress(0);
    abort.current = new AbortController();
    const resume: UploadResume | undefined =
      remembered && remembered.fileName === file.name && remembered.size === file.size
        ? { videoId: remembered.videoId, chunkBytes: remembered.chunkBytes }
        : undefined;
    try {
      const done = await uploadVideoFile({
        offeringId,
        file,
        resume,
        signal: abort.current.signal,
        onProgress: setProgress,
        onCreated: (r) =>
          resumeStore.save({ ...r, offeringId, fileName: file.name, size: file.size }),
      });
      resumeStore.clear();
      qc.setQueryData(videoKeys.video(offeringId, done.id), done);
      setVideoId(done.id);
    } catch (err) {
      // a cancelled or dropped upload keeps its place on the server: choosing the same file again resumes it
      setError(
        err instanceof ApiError && err.code === 'aborted'
          ? 'Upload paused. Choose the same file again to continue where it stopped.'
          : describeError(err),
      );
    } finally {
      setProgress(null);
      abort.current = null;
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <label htmlFor="item-video" className="block text-sm font-medium">
          {video ? 'Replace the video' : 'Video file'}
        </label>
        <input
          id="item-video"
          type="file"
          accept=".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm"
          disabled={progress !== null}
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = '';
          }}
          aria-describedby="item-video-hint"
          className="block w-full text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:border-input file:bg-surface file:px-3 sm:file:min-h-9"
        />
        <p id="item-video-hint" className="text-xs text-muted-foreground">
          MP4, MOV, MKV or WebM, up to 2 GB and 3 hours. A dropped connection resumes where it
          stopped.
        </p>
        {remembered && !video && progress === null && (
          <p className="text-sm">
            An upload of <strong>{remembered.fileName}</strong> ({mb(remembered.size)}) was
            interrupted. Choose the same file to continue it.
          </p>
        )}
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
              Pause upload
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>

      {video && progress === null && (
        <div aria-live="polite" className="rounded-md border border-border p-3 text-sm">
          <p className="font-medium break-all">{video.fileName}</p>
          {video.status === 'processing' && (
            <div className="mt-1 flex items-center gap-2">
              <progress
                max={100}
                value={video.progress}
                aria-label="Processing progress"
                className="h-2 flex-1"
              />
              <span>Processing {video.progress}%</span>
            </div>
          )}
          {video.status === 'uploading' && <p>Waiting for the rest of the file.</p>}
          {ready && (
            <p>
              Ready{video.durationMs ? ` · ${Math.round(video.durationMs / 60000) || 1} min` : ''}
              {video.renditions.length > 0
                ? ` · ${video.renditions.map((r) => r.name).join(', ')}`
                : ''}
            </p>
          )}
          {video.status === 'failed' && (
            <p role="alert" className="text-danger">
              {video.error?.message ?? 'The video could not be processed.'} Choose another file.
            </p>
          )}
        </div>
      )}

      {ready && itemId && videoId === current?.id && (
        <div className="space-y-2">
          <Button variant="secondary" aria-expanded={preview} onClick={() => setPreview((p) => !p)}>
            {preview ? 'Hide preview' : 'Preview'}
          </Button>
          {preview && me && (
            <Preview
              offeringId={offeringId}
              itemId={itemId}
              title={itemTitle ?? 'Video'}
              videoId={videoId}
              me={me.user}
            />
          )}
        </div>
      )}

      {ready && video && <Captions offeringId={offeringId} video={video} />}
    </div>
  );
}

function Preview({
  offeringId,
  itemId,
  title,
  videoId,
  me,
}: {
  offeringId: string;
  itemId: string;
  title: string;
  videoId: string;
  me: { displayName: string; email: string };
}) {
  const session = useQuery({
    queryKey: videoKeys.playback(offeringId, itemId),
    queryFn: ({ signal }) => playbackSession(offeringId, itemId, signal),
    staleTime: 10 * 60_000,
  });
  if (session.isError)
    return (
      <p role="alert" className="text-sm text-danger">
        {describeError(session.error)}
      </p>
    );
  if (!session.data) return <Skeleton className="aspect-video w-full" />;
  return (
    <Suspense fallback={<Skeleton className="aspect-video w-full" />}>
      <VideoPlayer
        autoPlay
        session={session.data}
        title={title}
        itemId={itemId}
        videoId={videoId}
        viewer={{ name: me.displayName, email: me.email }}
        renewSession={() => playbackSession(offeringId, itemId)}
      />
    </Suspense>
  );
}

function Captions({ offeringId, video }: { offeringId: string; video: VideoAsset }) {
  const qc = useQueryClient();
  const [language, setLanguage] = useState('en');
  const [removing, setRemoving] = useState<{ language: string; label: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const key = videoKeys.video(offeringId, video.id);

  const add = useMutation({
    mutationFn: async (file: File) => {
      const label = LANGUAGES.find(([l]) => l === language)?.[1] ?? language;
      return addCaption(offeringId, video.id, { language, label, content: await file.text() });
    },
    onSuccess: (c) => {
      setProblem(null);
      qc.setQueryData<VideoAsset>(key, (v) =>
        v
          ? {
              ...v,
              captions: [...v.captions.filter((x) => x.language !== c.language), c].sort((a, b) =>
                a.language.localeCompare(b.language),
              ),
            }
          : v,
      );
      toast.success(`Added ${c.label} captions.`);
    },
    onError: (err) => setProblem(describeError(err)),
  });
  const remove = useMutation({
    mutationFn: (lang: string) => deleteCaption(offeringId, video.id, lang),
    onSuccess: (_r, lang) => {
      qc.setQueryData<VideoAsset>(key, (v) =>
        v ? { ...v, captions: v.captions.filter((x) => x.language !== lang) } : v,
      );
      setRemoving(null);
      toast.success('Captions removed.');
    },
    onError: (err) => toast.error(describeError(err)),
  });

  return (
    <fieldset className="space-y-2 rounded-md border border-border p-3">
      <legend className="px-1 text-sm font-medium">Captions (WebVTT)</legend>
      {video.captions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No captions yet. Learners get a captions menu in the player once you add one.
        </p>
      ) : (
        <ul className="space-y-1">
          {video.captions.map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-sm">
              <span className="flex-1">
                {c.label} <span className="text-muted-foreground">({c.language})</span>
              </span>
              <Button
                variant="secondary"
                aria-label={`Remove ${c.label} captions`}
                onClick={() => setRemoving(c)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {video.captions.length < 5 && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="mb-1 block font-medium">Language</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="min-h-11 rounded-md border border-input bg-surface px-2 sm:min-h-9"
            >
              {LANGUAGES.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0 flex-1 text-sm">
            <span className="mb-1 block font-medium">Captions file (.vtt)</span>
            <input
              type="file"
              accept=".vtt,text/vtt"
              disabled={add.isPending}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) add.mutate(f);
              }}
              className="block w-full text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:border-input file:bg-surface file:px-3 sm:file:min-h-9"
            />
          </label>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Up to 5 languages, 256 KB each. Adding a language again replaces it.
      </p>
      {problem && (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing.language)}
        title={`Remove ${removing?.label ?? ''} captions?`}
        description={`Learners will no longer see the ${removing?.label ?? ''} captions of this video.`}
        confirmLabel={`Remove ${removing?.label ?? ''} captions`}
        pending={remove.isPending}
      />
    </fieldset>
  );
}

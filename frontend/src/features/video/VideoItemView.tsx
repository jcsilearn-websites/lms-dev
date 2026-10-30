import type { ItemDto } from '@lms/backend/contracts';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { Badge, Card } from '../../shared/ui/layout';
import { ErrorState, Skeleton } from '../../shared/ui/states';
import { useMe } from '../auth/useMe';
import { loadPlayer } from './loadPlayer';
import { playbackSession, videoKeys } from './video.api';

// The player (hls.js) is its own chunk: it is fetched only when a video item is opened.
const VideoPlayer = lazy(loadPlayer);

function formatDuration(ms: number | null): string {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : m > 0 ? `${m} min ${s % 60} s` : `${s} s`;
}

/** A video item: the player when the video is ready, its progress while it is being processed. */
export function VideoItemView({ offeringId, item }: { offeringId: string; item: ItemDto }) {
  const video = item.video;
  const me = useMe().data;
  const ready = video?.status === 'ready';
  // The page opens with the poster and a Play button. hls.js (a 113 KB chunk) is fetched when the viewer shows
  // intent (hover, focus) or presses Play, not on every page view: the page stays light, and a video that is never
  // played costs nothing.
  const [started, setStarted] = useState(false);
  const session = useQuery({
    queryKey: videoKeys.playback(offeringId, item.id),
    queryFn: ({ signal }) => playbackSession(offeringId, item.id, signal),
    enabled: ready,
    // a session is good for hours; the player asks for a new one itself when a link expires
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  if (!video) {
    return (
      <Card>
        <p>This video is not available.</p>
      </Card>
    );
  }
  if (video.status === 'failed') {
    return (
      <Card>
        <p role="alert" className="text-danger">
          This video could not be prepared. Ask your instructor to upload it again.
        </p>
      </Card>
    );
  }
  if (!ready) {
    return (
      <Card>
        <p role="status">
          {video.status === 'uploading'
            ? 'This video is still being uploaded.'
            : `This video is being prepared… ${video.progress}%`}
        </p>
        <progress
          max={100}
          value={video.progress}
          aria-label="Processing"
          className="mt-2 h-2 w-full"
        />
      </Card>
    );
  }
  if (session.isError) {
    return (
      <ErrorState
        title="Could not start the video"
        error={session.error}
        onRetry={() => void session.refetch()}
      />
    );
  }
  if (!session.data || !me) return <Skeleton className="aspect-video w-full" />;
  return (
    <div className="space-y-2">
      {!started ? (
        <section
          aria-label={`Video player: ${item.title}`}
          className="relative aspect-video w-full overflow-hidden rounded-md bg-black"
        >
          {session.data.posterUrl && (
            <img
              src={session.data.posterUrl}
              alt=""
              width={1280}
              height={720}
              className="h-full w-full object-cover"
              referrerPolicy="no-referrer"
            />
          )}
          <button
            type="button"
            onClick={() => setStarted(true)}
            onPointerEnter={() => void loadPlayer()}
            onFocus={() => void loadPlayer()}
            aria-label="Play"
            className="absolute inset-0 flex items-center justify-center bg-black/30 text-5xl text-white hover:bg-black/20 focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-white"
          >
            <span aria-hidden="true" className="rounded-full bg-black/60 px-6 py-3">
              ▶
            </span>
          </button>
        </section>
      ) : (
        <Suspense fallback={<Skeleton className="aspect-video w-full" />}>
          <VideoPlayer
            autoPlay
            session={session.data}
            title={item.title}
            itemId={item.id}
            videoId={video.id}
            viewer={{ name: me.user.displayName, email: me.user.email }}
            renewSession={() => playbackSession(offeringId, item.id)}
          />
        </Suspense>
      )}
      {video.durationMs ? <Badge>{formatDuration(video.durationMs)}</Badge> : null}
    </div>
  );
}

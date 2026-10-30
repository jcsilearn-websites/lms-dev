import type { PlaybackSession } from '@lms/backend/contracts';
import type HlsType from 'hls.js';
import Hls from 'hls.js/light';
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { emitPlayerEvent, HEARTBEAT_SECONDS, type PlayerEventType } from './playerEvents';

// THIS FILE IS ITS OWN CHUNK (it pulls in hls.js): it is loaded only by the video item page and the builder's
// preview, never by the sign-in, admin or any other screen (`pnpm bundle:check` fails if anything else reaches it).
// Native HLS on Safari, hls.js elsewhere. Own accessible controls: quality (auto / manual), speed 0.75-2x, captions,
// keyboard shortcuts, the position is remembered on this device, and a moving watermark with the viewer's name.
// A watermark is a deterrent only: screen recording cannot be prevented by a web page.

export interface VideoPlayerProps {
  session: PlaybackSession;
  title: string;
  itemId: string;
  videoId: string;
  viewer: { name: string; email: string };
  /** start playing as soon as the stream is attached (the viewer pressed Play to get here) */
  autoPlay?: boolean;
  /** asks for a fresh playback session (the token of the old one expired) */
  renewSession: () => Promise<PlaybackSession>;
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const WATERMARK_SPOTS: [number, number][] = [
  [6, 8],
  [62, 14],
  [30, 44],
  [66, 70],
  [8, 76],
  [44, 24],
];
const posKey = (videoId: string) => `lms.video.position.${videoId}`;

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const isSafari = () =>
  typeof navigator !== 'undefined' &&
  /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);

function readPosition(videoId: string): number {
  try {
    return Number(localStorage.getItem(posKey(videoId))) || 0;
  } catch {
    return 0;
  }
}
function writePosition(videoId: string, seconds: number): void {
  try {
    localStorage.setItem(posKey(videoId), String(Math.floor(seconds)));
  } catch {
    // storage blocked: the position is simply not remembered
  }
}

export default function VideoPlayer({
  session,
  title,
  itemId,
  videoId,
  viewer,
  autoPlay = false,
  renewSession,
}: VideoPlayerProps) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<HlsType | null>(null);
  const [cur, setCur] = useState(session);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [levels, setLevels] = useState<{ index: number; height: number }[]>([]);
  const [level, setLevel] = useState(-1);
  const [caption, setCaption] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(true);
  const [spot, setSpot] = useState(0);
  const renewing = useRef(false);
  const lastSaved = useRef(0);

  const emit = useCallback(
    (type: PlayerEventType) => {
      const v = video.current;
      if (!v) return;
      emitPlayerEvent({
        type,
        itemId,
        videoId,
        positionMs: Math.round(v.currentTime * 1000),
        durationMs: Math.round((Number.isFinite(v.duration) ? v.duration : 0) * 1000),
        playbackRate: v.playbackRate,
        at: new Date().toISOString(),
      });
    },
    [itemId, videoId],
  );

  // The address of this page must not leak the playback URL (it carries a credential) to anything it links to.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  // ---- attach the stream; again with a fresh token when the old one expires
  const start = useCallback(
    (manifestUrl: string, at: number) => {
      const el = video.current;
      if (!el) return;
      hls.current?.destroy();
      hls.current = null;
      if (isSafari() && el.canPlayType('application/vnd.apple.mpegurl')) {
        el.src = manifestUrl;
        el.currentTime = at;
        return;
      }
      if (!Hls.isSupported()) {
        setError(
          'This browser cannot play this video. Try a current Chrome, Edge, Firefox or Safari.',
        );
        return;
      }
      const h = new Hls({ startPosition: at, enableWorker: false, capLevelToPlayerSize: true });
      hls.current = h;
      h.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        setLevels(data.levels.map((l, index) => ({ index, height: l.height })));
      });
      h.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        const code = (data as { response?: { code?: number } }).response?.code;
        if (code === 403 && !renewing.current) {
          // the playback session expired: ask for a new one and continue where the viewer was
          renewing.current = true;
          const position = el.currentTime;
          void renewSession()
            .then((next) => {
              setCur(next);
              start(next.manifestUrl, position);
              if (!el.paused) void el.play().catch(() => undefined);
            })
            .catch(() => setError('Your session ended. Reload the page to continue.'))
            .finally(() => {
              renewing.current = false;
            });
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) h.recoverMediaError();
        else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) h.startLoad();
        else setError('The video could not be played.');
      });
      h.loadSource(manifestUrl);
      h.attachMedia(el);
    },
    [renewSession],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the stream is attached once per mounted player
  useEffect(() => {
    const saved = readPosition(videoId);
    // the element, now: React clears `video.current` before this cleanup runs
    const el = video.current;
    start(session.manifestUrl, saved > 5 && saved < session.durationMs / 1000 - 10 ? saved : 0);
    if (autoPlay) void Promise.resolve(el?.play()).catch(() => undefined);
    return () => {
      if (el && el.currentTime > 0) writePosition(videoId, el.currentTime);
      hls.current?.destroy();
      hls.current = null;
    };
  }, [videoId]);

  // ---- the watermark moves now and then
  useEffect(() => {
    const t = setInterval(
      () => setSpot((s) => (s + 1 + Math.floor(Math.random() * 3)) % WATERMARK_SPOTS.length),
      20_000,
    );
    return () => clearInterval(t);
  }, []);

  // ---- heartbeat while playing
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => emit('heartbeat'), HEARTBEAT_SECONDS * 1000);
    return () => clearInterval(t);
  }, [playing, emit]);

  // ---- captions: one track is "showing" at a time (the tracks are new elements after a new session)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `cur` re-runs this for the new <track> elements
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    for (const track of Array.from(el.textTracks)) {
      track.mode = track.language === caption ? 'showing' : 'disabled';
    }
  }, [caption, cur]);

  const toggle = () => {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setPlaying(false));
    else el.pause();
  };
  const seekBy = (seconds: number) => {
    const el = video.current;
    if (el)
      el.currentTime = Math.min(Math.max(0, el.currentTime + seconds), el.duration || Infinity);
  };
  const setVol = (v: number) => {
    const el = video.current;
    if (!el) return;
    el.volume = Math.min(1, Math.max(0, v));
    el.muted = false;
  };
  const chooseLevel = (index: number) => {
    setLevel(index);
    if (hls.current) hls.current.currentLevel = index;
  };
  const chooseRate = (r: number) => {
    setRate(r);
    if (video.current) video.current.playbackRate = r;
  };
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen?.();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    const typing = tag === 'SELECT' || tag === 'INPUT';
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // a focused button handles Space and Enter itself
    if ((e.key === ' ' || e.key === 'Enter') && (tag === 'BUTTON' || typing)) return;
    let handled = true;
    switch (e.key) {
      case ' ':
      case 'k':
        toggle();
        break;
      case 'ArrowLeft':
        if (typing) return;
        seekBy(-5);
        break;
      case 'ArrowRight':
        if (typing) return;
        seekBy(5);
        break;
      case 'j':
        seekBy(-10);
        break;
      case 'l':
        seekBy(10);
        break;
      case 'ArrowUp':
        if (typing) return;
        setVol((video.current?.volume ?? 1) + 0.1);
        break;
      case 'ArrowDown':
        if (typing) return;
        setVol((video.current?.volume ?? 1) - 0.1);
        break;
      case 'm':
        if (video.current) video.current.muted = !video.current.muted;
        break;
      case 'f':
        fullscreen();
        break;
      case 'c':
        setCaption((c) => (c || !cur.captions[0] ? '' : cur.captions[0].language));
        break;
      case '>':
        chooseRate(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(rate) + 1)] ?? rate);
        break;
      case '<':
        chooseRate(SPEEDS[Math.max(0, SPEEDS.indexOf(rate) - 1)] ?? rate);
        break;
      default:
        if (/^[0-9]$/.test(e.key) && video.current) {
          const total = Number.isFinite(video.current.duration)
            ? video.current.duration
            : cur.durationMs / 1000;
          video.current.currentTime = (Number(e.key) / 10) * total;
        } else handled = false;
    }
    if (handled) e.preventDefault();
  };

  const [x, y] = WATERMARK_SPOTS[spot] ?? [6, 8];
  const btn =
    'inline-flex min-h-11 min-w-11 items-center justify-center rounded px-2 text-sm text-white hover:bg-white/20 sm:min-h-9 sm:min-w-9';
  const select =
    'min-h-11 rounded border border-white/40 bg-black px-1 text-sm text-white sm:min-h-9';
  return (
    <section
      ref={box}
      aria-label={`Video player: ${title}`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the group takes the keyboard shortcuts
      tabIndex={0}
      onKeyDown={onKey}
      className="relative overflow-hidden rounded-md bg-black text-white focus:outline-2 focus:outline-offset-2 focus:outline-primary"
    >
      {/* biome-ignore lint/a11y/useMediaCaption: the captions are <track> elements, added when an instructor uploads them */}
      <video
        ref={video}
        poster={cur.posterUrl ?? undefined}
        playsInline
        preload="metadata"
        className="aspect-video w-full bg-black"
        onClick={toggle}
        onPlay={() => {
          setPlaying(true);
          emit('play');
        }}
        onPause={() => {
          setPlaying(false);
          if (!video.current?.ended) emit('pause');
          if (video.current) writePosition(videoId, video.current.currentTime);
        }}
        onEnded={() => emit('ended')}
        onSeeked={() => emit('seek')}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onCanPlay={() => setBuffering(false)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || cur.durationMs / 1000)}
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime;
          setTime(t);
          if (Math.abs(t - lastSaved.current) >= 5) {
            lastSaved.current = t;
            writePosition(videoId, t);
          }
        }}
        onVolumeChange={(e) => {
          setVolume(e.currentTarget.volume);
          setMuted(e.currentTarget.muted);
        }}
      >
        {cur.captions.map((c) => (
          <track
            key={`${c.language}-${c.url}`}
            kind="captions"
            srcLang={c.language}
            label={c.label}
            src={c.url}
          />
        ))}
      </video>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute select-none text-xs font-medium text-white/40 [text-shadow:0_0_3px_rgba(0,0,0,0.8)] sm:text-sm"
        style={{ left: `${x}%`, top: `${y}%` }}
      >
        {viewer.name} · {viewer.email}
      </div>

      {buffering && !error && (
        <p role="status" className="absolute left-3 top-3 rounded bg-black/70 px-2 py-1 text-xs">
          Loading…
        </p>
      )}
      {error && (
        <p role="alert" className="absolute inset-x-0 top-0 bg-black/80 p-3 text-sm">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1 bg-black/85 p-1">
        <button
          type="button"
          className={btn}
          onClick={toggle}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <span className="min-w-[5.5rem] text-xs tabular-nums">
          {formatTime(time)} / {formatTime(duration || cur.durationMs / 1000)}
        </span>
        <input
          type="range"
          aria-label="Seek"
          aria-valuetext={`${formatTime(time)} of ${formatTime(duration || cur.durationMs / 1000)}`}
          min={0}
          max={Math.max(1, Math.floor(duration || cur.durationMs / 1000))}
          step={1}
          value={Math.floor(time)}
          onChange={(e) => {
            if (video.current) video.current.currentTime = Number(e.target.value);
          }}
          className="h-6 min-w-[8rem] flex-1 basis-40 accent-white"
        />
        <button
          type="button"
          className={btn}
          aria-pressed={muted}
          aria-label={muted ? 'Unmute' : 'Mute'}
          onClick={() => {
            if (video.current) video.current.muted = !video.current.muted;
          }}
        >
          {muted || volume === 0 ? '🔇' : '🔊'}
        </button>
        <label className="text-xs">
          <span className="sr-only">Playback speed</span>
          <select
            className={select}
            value={rate}
            onChange={(e) => chooseRate(Number(e.target.value))}
          >
            {SPEEDS.map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
        </label>
        {levels.length > 1 && (
          <label className="text-xs">
            <span className="sr-only">Quality</span>
            <select
              className={select}
              value={level}
              onChange={(e) => chooseLevel(Number(e.target.value))}
            >
              <option value={-1}>Auto</option>
              {levels.map((l) => (
                <option key={l.index} value={l.index}>
                  {l.height}p
                </option>
              ))}
            </select>
          </label>
        )}
        {cur.captions.length > 0 && (
          <label className="text-xs">
            <span className="sr-only">Captions</span>
            <select className={select} value={caption} onChange={(e) => setCaption(e.target.value)}>
              <option value="">Captions off</option>
              {cur.captions.map((c) => (
                <option key={c.language} value={c.language}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className={btn} onClick={fullscreen} aria-label="Full screen">
          ⛶
        </button>
      </div>
    </section>
  );
}

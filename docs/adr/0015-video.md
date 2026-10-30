# ADR 0015: Video lessons (Step 7)

Status: accepted (Step 7). Builds on [ADR 0013](0013-courses-content-storage.md) (files, storage) and
[ADR 0010](0010-postgres-job-queue.md) (the job queue).

## Context

Instructors need to put recorded lectures into a course. Colleges differ in how many students watch and for how long, and the
production video path (a managed transcoder and a CDN) is a GCP-step decision that depends on prices we do not have yet.
So the application is built **behind a provider interface** ("ingest + deliver", because Bunny Stream, Cloudflare Stream,
Mux and Google's Transcoder API + Cloud CDN all do both) with a **local provider** that makes the whole feature work, and be
tested end to end, on a developer machine and in CI.

## Decision

### Providers

- `VideoProvider` (`core/video/provider.ts`): `createUpload`, `getStatus`, `createPlayback`, `deleteAsset`, and the chunked
  upload of the local one. `VIDEO_PROVIDER=local | gcp | bunny`.
- **`local`** — uploads through the existing local `StorageProvider`, ffmpeg in the worker, HLS served by this API with
  signed tokens. **Development and CI only.** `gcp` (Transcoder API + GCS + Cloud CDN signed cookies) and `bunny` (the shape
  of every video service) are stubs that answer 503 and carry the TODOs for the GCP step.
- **Licensing and production (decided by the owner).** ffmpeg (built with libx264, so GPL) is for local development and CI
  **only**. It is never shipped in a production image. Production uses a managed provider (GCP Transcoder or a video
  service), which carries the codec licensing. This is enforced, not just written down: `parseApiEnv` / `parseWorkerEnv`
  **refuse `VIDEO_PROVIDER=local` when `NODE_ENV=production`** (`assertVideoPolicy`, tested), and forgetting to choose a
  provider is the same refusal (the default is `local`). The local provider also needs `STORAGE_DRIVER=local`.
- **ffmpeg version** (recorded, pinned, checksum-verified): FFmpeg **n8.1.3-9-g29e619e767**, the BtbN GPL build of the
  2026-09-30 snapshot (`autobuild-2026-09-30-13-08`; month-end snapshots are kept, daily ones are not), the same build on the
  developer machine (Windows, `C:\Users\acer\bin`) and in CI (`.github/scripts/install-ffmpeg.sh`, SHA-256 pinned in the script
  and checked before anything is unpacked). Windows archive SHA-256
  `7b801cdd3a1a0bb54ae6f572187e68b4ed54f52086cfee133fab2180bfb429fa`, Linux
  `97ce978979194b5cf7e06a5e68020dbdaa7a4f3294c5452b6a1bc347100dbb79`. hls.js **1.7.3** (exact; 1.7.4 was inside the
  release-age window), the `hls.js/light` build.

### Data

`video_assets` (tenant-scoped, RLS forced; status `uploading | processing | ready | failed`, progress, duration, size, probe
facts, renditions with their sizes, storage keys, the reason of a failure, retention timestamps) and `video_captions` (up to
5 languages per video). A content item of kind `video` references one asset (`content_items.video_asset_id`, composite FK,
`RESTRICT`, checked by the kind constraint). **Copying an offering shares the asset**, like files; removing the last item
that uses a video restarts its purge grace period (trigger). Migration 0025.

### Upload

Resumable and chunked, through the API (the local driver has no direct-to-storage URL): `POST /offerings/:id/videos` (record
- chunk size), `PATCH .../upload` (one chunk, `Upload-Offset` header, raw bytes), `GET .../upload` (the resume point),
  `POST .../complete`. **The stored bytes are the truth about where the upload stands**, not a counter in the database: a chunk
  cut off half way leaves a partial file, `GET .../upload` returns its real size and the client resumes from there. A chunk must
  start exactly where the bytes end, never run past the announced size, one writer at a time. Every one of these is one database
  statement (4 round trips). Limits: `VIDEO_MAX_BYTES` (2 GB), `VIDEO_MAX_DURATION_SECONDS` (3 h), mp4 / mov / mkv / webm **verified
by the first bytes (at upload) and by ffprobe (at processing)**, not by the extension.

### Transcoding (worker, queue `video`, one at a time by default)

One ffmpeg run decodes once and writes every rendition as its own HLS output: **H.264 (capped CRF 23, `-preset veryfast`,
`maxrate`/`bufsize` 2x) + AAC, fragmented-MP4 segments of 6 s with an `init.mp4` per rendition**. Ladder: 360p (400 kbps),
480p (700 kbps), 720p (1.3 Mbps), named for the SHORT side so a portrait video is capped like a landscape one; **never
upscaled**, capped at 720; a smaller source gets one rendition at its own size. Key frames are forced at the same instants in
every rendition (`expr:gte(t,n_forced*6)`, scenecut off, constant frame rate, GOP = 6 s) so a player can switch at any segment
boundary (tested with ffprobe). The master playlist is written by us from what was produced (bandwidth, codecs, resolution).
Also a poster, five thumbnails, per-rendition sizes, and progress parsed from `-progress` (throttled writes).

- **fMP4 instead of MPEG-TS** (owner's decision): less overhead per segment means less egress, and it is what managed
  transcoders produce. Measured on the same encode: TS segments are 31-50 % larger on a lecture (docs/video-cost-model.md).
- **Untrusted input.** `-protocol_whitelist file` (no network), no shell, an explicit argument list, `-nostdin`, a hard timeout
  (`max(10 min, factor x duration)`), output only below the job's own directory (checked), a probe that rejects unexpected
  streams, absurd sizes (below 64 or above 4096 px, above 120 fps), a wrong duration, and a container that disagrees with the
  extension. Failures carry a reason a person can read (`unsupported_format`, `corrupt`, `no_video`, `too_long`,
  `bad_dimensions`, `unexpected_streams`) and are NOT retried; an ffmpeg problem that is not the input's fault is.
- **Shutdown.** On abort the ffmpeg process is killed and the job waits until it has really exited before it removes its
  directory (found by a test: on Windows a still-dying ffmpeg holds files open). The job is released (attempt not charged), the
  video stays `processing`, and the retry rebuilds everything from scratch: the output is built in the job's own directory and
  moved into place only when complete. `video.purge` also sweeps scratch directories of crashed workers.
- **Retention.** The original is deleted `VIDEO_SOURCE_RETENTION_DAYS` (30) after a successful transcode (`video.expire_sources`;
  re-transcoding later needs a new upload). Unreferenced and abandoned videos are purged after `VIDEO_UPLOAD_GRACE_HOURS` (24),
  rows first (definer function `video_purge`), then objects.

### Playback

`POST /offerings/:id/items/:itemId/playback` (`content.view`, `scope: 'offering'`, the same visibility rules as the outline in
the same statement; 404 for non-participants, locked and hidden items) returns a session: manifest URL, poster, captions.

- **The token is in the URL path with relative playlist URIs**, `/api/video/play/<token>/<assetId>/master.m3u8`, so every
  playlist, init segment and media segment resolves to the same token without rewriting anything (works with native HLS on
  Safari and is CDN friendly). HMAC-SHA256 over `{tenant, asset, user, expiry}`, domain-separated from every other signature,
  `VIDEO_PLAYBACK_TTL_SECONDS` (2 h). The asset id is also in the path: a token for one asset cannot fetch another's.
- **A token alone is not enough for the local provider: the session cookie must belong to the same user** (tenant host, same
  tenant). A leaked URL is useless to anyone else.
- **Session cache.** Checking a session on every 6-second segment request would hit the database for every viewer. A
  validated (session, token) pair is remembered in memory for `VIDEO_SESSION_CACHE_TTL_SECONDS` (default **60**), in a cache
  bounded by `VIDEO_SESSION_CACHE_MAX`. **A revoked session (sign-out, suspension) keeps playing for at most that long**; every
  other URL is checked on every request. Test: 20 consecutive segment requests of one session cost **1** statement; and
  after the TTL a signed-out session is refused (`video.budget.test.ts`).
- Served with the right Content-Types, `Accept-Ranges` / 206 / 416, `nosniff`, `Cache-Control: private`, **`Referrer-Policy:
  no-referrer`**, `Cross-Origin-Resource-Policy: same-origin`. Only an allow-list of paths (never the original). The token is
  **redacted from logs** (`/video/play/[redacted]/...`; test captures the logs and fails if a token appears).
- **The web server's CSP needs `media-src 'self' blob:`** (hls.js plays through a MediaSource) and the pages that play video
  send `Referrer-Policy: no-referrer` (`serve.mjs`; the production gateway must do the same, see README). Found by the E2E
  test: without it the video never starts.
- **In production the CDN validates the signed URLs / signed cookies and this API is not on the segment path.** The
  session cache, the per-request session check and the segment route exist only for the local provider.

### Player (frontend)

hls.js (the `light` build) in its **own lazy chunk (113 KB gzip)**, reachable only from the video item page and the builder's
preview (`pnpm bundle:check` fails otherwise, and was shown to fail when a normal page imports it). The page opens with the
poster and a Play button; hls.js is fetched on hover / focus / Play. Native HLS on Safari. Quality (auto + manual), speed
0.75-2x, captions, keyboard shortcuts, position remembered on the device, a moving watermark with the viewer's name and
address (a deterrent only: **a web page cannot prevent screen recording**), a renewed session when a link expires. Player
events (`play`, `pause`, `seek`, `ended`, 15 s `heartbeat`) go through `features/video/playerEvents.ts` for Step 8; nothing is
stored yet.

## Consequences

- A developer needs ffmpeg and ffprobe on the PATH to run the backend suite (the video tests fail loudly without them).
- The local provider is for development: it transcodes on the API host's CPU (measured in docs/video-cost-model.md) and
  serves video through Node. Production must use a managed provider before any real use; the interface, the data model, the
  player and the tests carry over.
- A fixed rendition ladder was chosen for lectures (low bit rates); sports, screen recordings of fast animation and similar
  content would need a different ladder.

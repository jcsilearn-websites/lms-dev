import type { ItemDto, VideoAsset } from '@lms/backend/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { moduleOf, OFFERING_ID, offering, outline } from './courses-fixtures';
import { renderApp } from './render';
import { API, memberMe, mockSignedIn, server } from './server';

// The video screens: the item page (player, processing, failed, locked) and the builder's video dialog
// (upload with resume, processing, captions). hls.js is replaced by a fake: jsdom has no media pipeline.

vi.mock('hls.js/light', () => ({
  default: class {
    static Events = { MANIFEST_PARSED: 'manifestParsed', ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    static isSupported = () => true;
    on() {}
    loadSource() {}
    attachMedia() {}
    destroy() {}
  },
}));

const base = `${API}/offerings/${OFFERING_ID}`;
const ITEM = 'a1000000-0000-7000-8000-000000000001';
const VIDEO = 'b1000000-0000-7000-8000-000000000001';

const videoItem = (over: Partial<ItemDto> = {}): ItemDto => ({
  id: ITEM,
  moduleId: 'c1000000-0000-7000-8000-000000000001',
  kind: 'video',
  title: 'Lecture 1',
  published: true,
  availableFrom: null,
  locked: false,
  url: null,
  file: null,
  video: { id: VIDEO, status: 'ready', progress: 100, durationMs: 754_000 },
  body: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const session = {
  manifestUrl: '/api/video/play/TOK/asset/master.m3u8',
  posterUrl: '/api/video/play/TOK/asset/poster.jpg',
  expiresAt: '2030-01-01T00:00:00.000Z',
  durationMs: 754_000,
  captions: [
    { language: 'en', label: 'English', url: '/api/video/play/TOK/asset/captions/en.vtt' },
  ],
  renditions: [{ name: '720p', height: 720 }],
};

describe('a video item page', () => {
  it('plays a ready video: asks for a playback session and shows the player with its title and captions', async () => {
    mockSignedIn(memberMe);
    let asked = 0;
    server.use(
      http.get(`${base}/items/${ITEM}`, () => HttpResponse.json(videoItem())),
      http.post(`${base}/items/${ITEM}/playback`, () => {
        asked++;
        return HttpResponse.json(session);
      }),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    // the page opens with the poster and a Play button: the player (hls.js) is not loaded yet
    const facade = await screen.findByRole('region', { name: 'Video player: Lecture 1' });
    expect(asked).toBe(1);
    expect(facade.querySelector('img')).toHaveAttribute('src', session.posterUrl);
    expect(facade.querySelector('video')).toBeNull();
    await user.click(within(facade).getByRole('button', { name: 'Play' }));
    const player = await screen.findByRole('combobox', { name: 'Captions' });
    const region = screen.getByRole('region', { name: 'Video player: Lecture 1' });
    expect(within(region).getByRole('slider', { name: 'Seek' })).toBeInTheDocument();
    expect(region.querySelector('video')).toHaveAttribute('poster', session.posterUrl);
    expect(player).toBeInTheDocument();
    // the viewer's name and address are on the picture (a deterrent against sharing)
    expect(region).toHaveTextContent('Mia Member · m@alpha.test');
    expect(screen.getByText('12 min 34 s')).toBeInTheDocument();
  });

  it('shows the progress while the video is being prepared, and looks again until it is ready', async () => {
    mockSignedIn(memberMe);
    let calls = 0;
    server.use(
      http.get(`${base}/items/${ITEM}`, () => {
        calls++;
        return HttpResponse.json(
          videoItem({
            video: {
              id: VIDEO,
              status: calls === 1 ? 'processing' : 'ready',
              progress: calls === 1 ? 42 : 100,
              durationMs: 60_000,
            },
          }),
        );
      }),
      http.post(`${base}/items/${ITEM}/playback`, () => HttpResponse.json(session)),
    );
    renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    expect(await screen.findByText(/being prepared… 42%/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Processing' })).toHaveAttribute('value', '42');
    expect(
      await screen.findByRole('region', { name: /Video player/ }, { timeout: 8000 }),
    ).toBeInTheDocument();
  }, 20_000);

  it('tells a learner a failed video could not be prepared (and not the technical reason)', async () => {
    mockSignedIn(memberMe);
    server.use(
      http.get(`${base}/items/${ITEM}`, () =>
        HttpResponse.json(
          videoItem({ video: { id: VIDEO, status: 'failed', progress: 0, durationMs: null } }),
        ),
      ),
    );
    renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be prepared');
  });

  it('shows only the opening date of a locked video, and asks for no playback session', async () => {
    mockSignedIn(memberMe);
    let asked = 0;
    server.use(
      http.get(`${base}/items/${ITEM}`, () =>
        HttpResponse.json(
          videoItem({ locked: true, video: null, availableFrom: '2030-03-01T09:00:00.000Z' }),
        ),
      ),
      http.post(`${base}/items/${ITEM}/playback`, () => {
        asked++;
        return HttpResponse.json(session);
      }),
    );
    renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    expect(await screen.findByText(/This opens on/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Video player/ })).toBeNull();
    expect(asked).toBe(0);
  });

  it('shows an error with a retry when the session cannot be started', async () => {
    mockSignedIn(memberMe);
    let n = 0;
    server.use(
      http.get(`${base}/items/${ITEM}`, () => HttpResponse.json(videoItem())),
      http.post(`${base}/items/${ITEM}/playback`, () =>
        ++n <= 2
          ? HttpResponse.json(
              { error: { code: 'internal_error', message: 'x', requestId: 'r' } },
              { status: 500 },
            )
          : HttpResponse.json(session),
      ),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    const retry = await screen.findByRole(
      'button',
      { name: /try again|retry/i },
      { timeout: 8000 },
    );
    await user.click(retry);
    expect(await screen.findByRole('region', { name: /Video player/ })).toBeInTheDocument();
  }, 20_000);
});

// ---------------------------------------------------------------------------------------------------
describe('the builder: adding a video', () => {
  const m1 = moduleOf(1, []);
  const mkAsset = (over: Partial<VideoAsset> = {}): VideoAsset => ({
    id: VIDEO,
    offeringId: OFFERING_ID,
    fileName: 'lecture.mp4',
    status: 'uploading',
    progress: 0,
    uploadOffset: 0,
    size: 300,
    durationMs: null,
    width: null,
    height: null,
    hasAudio: null,
    renditions: [],
    captions: [],
    error: null,
    sourceKept: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    readyAt: null,
    ...over,
  });

  it('uploads in chunks, shows the processing percentage, and adds the item once the video is ready', async () => {
    mockSignedIn(memberMe);
    localStorage.clear();
    const chunks: { offset: string | null; size: number }[] = [];
    let stored = 0;
    let polls = 0;
    let created: unknown;
    server.use(
      http.get(base, () =>
        HttpResponse.json(offering({ myParticipation: 'instructor', status: 'draft' })),
      ),
      http.get(`${base}/outline`, () => HttpResponse.json(outline([m1], true))),
      http.post(`${base}/videos`, () =>
        HttpResponse.json(
          { video: mkAsset(), upload: { protocol: 'chunked', chunkBytes: 128, maxBytes: 2e9 } },
          { status: 201 },
        ),
      ),
      http.patch(`${base}/videos/${VIDEO}/upload`, async ({ request }) => {
        const body = await request.arrayBuffer();
        expect(request.headers.get('x-requested-with')).toBe('lms');
        expect(request.headers.get('content-type')).toBe('application/offset+octet-stream');
        chunks.push({ offset: request.headers.get('upload-offset'), size: body.byteLength });
        stored += body.byteLength;
        return HttpResponse.json({ uploadOffset: stored, size: 300, status: 'uploading' });
      }),
      http.post(`${base}/videos/${VIDEO}/complete`, () =>
        HttpResponse.json(mkAsset({ status: 'processing', uploadOffset: 300 }), { status: 202 }),
      ),
      http.get(`${base}/videos/${VIDEO}`, () =>
        HttpResponse.json(
          ++polls < 2
            ? mkAsset({ status: 'processing', progress: 42, uploadOffset: 300 })
            : mkAsset({
                status: 'ready',
                progress: 100,
                durationMs: 90_000,
                renditions: [
                  { name: '360p', width: 640, height: 360, videoKbps: 400, bytes: 1000 },
                ],
              }),
        ),
      ),
      http.post(`${base}/modules/${m1.id}/items`, async ({ request }) => {
        created = await request.json();
        return HttpResponse.json(videoItem({ moduleId: m1.id }), { status: 201 });
      }),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/build`);
    await user.click(await screen.findByRole('button', { name: 'Add video' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add video' });
    // nothing can be saved before a video is ready
    expect(within(dialog).getByRole('button', { name: 'Add video' })).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Title'), 'Lecture 1');
    const file = new File([new Uint8Array(300)], 'lecture.mp4', { type: 'video/mp4' });
    await user.upload(within(dialog).getByLabelText('Video file'), file);

    await waitFor(() => expect(chunks).toHaveLength(3), { timeout: 8000 });
    expect(chunks).toEqual([
      { offset: '0', size: 128 },
      { offset: '128', size: 128 },
      { offset: '256', size: 44 },
    ]);
    expect(
      await within(dialog).findByText(/Processing 42%/, {}, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add video' })).toBeDisabled();
    expect(await within(dialog).findByText(/Ready/, {}, { timeout: 12_000 })).toBeInTheDocument();

    const add = within(dialog).getByRole('button', { name: 'Add video' });
    await waitFor(() => expect(add).toBeEnabled());
    await user.click(add);
    await waitFor(() => expect(created).toBeTruthy());
    expect(created).toMatchObject({
      kind: 'video',
      title: 'Lecture 1',
      videoId: VIDEO,
      published: false,
    });
    expect(localStorage.getItem('lms.video.upload')).toBeNull(); // nothing left to resume
  }, 40_000);

  it('says what went wrong when the server refuses the file, and lets the person choose another', async () => {
    mockSignedIn(memberMe);
    server.use(
      http.get(base, () =>
        HttpResponse.json(offering({ myParticipation: 'instructor', status: 'draft' })),
      ),
      http.get(`${base}/outline`, () => HttpResponse.json(outline([m1], true))),
      http.post(`${base}/videos`, () =>
        HttpResponse.json(
          {
            error: {
              code: 'video_too_large',
              message: 'A video can be at most 2 GB',
              requestId: 'r',
            },
          },
          { status: 413 },
        ),
      ),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/build`);
    await user.click(await screen.findByRole('button', { name: 'Add video' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add video' });
    await user.upload(
      within(dialog).getByLabelText('Video file'),
      new File([new Uint8Array(10)], 'big.mp4', { type: 'video/mp4' }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('at most 2 GB');
    expect(within(dialog).getByLabelText('Video file')).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Add video' })).toBeDisabled();
  });
});

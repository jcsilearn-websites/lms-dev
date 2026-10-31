import type { PlaybackSession } from '@lms/backend/contracts';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PlayerEvent, subscribeToPlayerEvents } from '../src/features/video/playerEvents';
import VideoPlayer, { formatTime } from '../src/features/video/VideoPlayer';

// The player's controls, keyboard, captions, remembered position, events and watermark. hls.js is replaced by a
// fake (jsdom has no media pipeline); what is tested is OUR code around it.

const hls = vi.hoisted(() => {
  type Handler = (event: string, data: unknown) => void;
  class FakeHls {
    static instances: FakeHls[] = [];
    static supported = true;
    static Events = { MANIFEST_PARSED: 'manifestParsed', ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    static isSupported = () => FakeHls.supported;
    handlers = new Map<string, Handler[]>();
    currentLevel = -1;
    loadSource = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();
    recoverMediaError = vi.fn();
    startLoad = vi.fn();
    constructor(readonly config: Record<string, unknown>) {
      FakeHls.instances.push(this);
    }
    on(event: string, fn: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    }
    emit(event: string, data: unknown) {
      for (const fn of this.handlers.get(event) ?? []) fn(event, data);
    }
  }
  return FakeHls;
});
vi.mock('hls.js/light', () => ({ default: hls }));

const SESSION: PlaybackSession = {
  manifestUrl: '/api/video/play/TOKEN1/asset/master.m3u8',
  posterUrl: '/api/video/play/TOKEN1/asset/poster.jpg',
  expiresAt: '2030-01-01T00:00:00.000Z',
  durationMs: 600_000,
  captions: [
    { language: 'en', label: 'English', url: '/api/video/play/TOKEN1/asset/captions/en.vtt' },
    { language: 'hi', label: 'Hindi', url: '/api/video/play/TOKEN1/asset/captions/hi.vtt' },
  ],
  renditions: [{ name: '720p', height: 720 }],
  resumeSeconds: null,
};
const VIDEO_ID = '33000000-0000-7000-8000-000000000001';
const ITEM_ID = '44000000-0000-7000-8000-000000000001';

// a media element that remembers what it is told
const state = new WeakMap<
  HTMLMediaElement,
  { time: number; paused: boolean; volume: number; muted: boolean; rate: number }
>();
const st = (el: HTMLMediaElement) => {
  const known = state.get(el);
  if (known) return known;
  const fresh = { time: 0, paused: true, volume: 1, muted: false, rate: 1 };
  state.set(el, fresh);
  return fresh;
};

beforeEach(() => {
  hls.instances.length = 0;
  hls.supported = true;
  localStorage.clear();
  const proto = HTMLMediaElement.prototype;
  vi.spyOn(proto, 'play').mockImplementation(function (this: HTMLMediaElement) {
    st(this).paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  vi.spyOn(proto, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    st(this).paused = true;
    this.dispatchEvent(new Event('pause'));
  });
  for (const [prop, key] of [
    ['currentTime', 'time'],
    ['paused', 'paused'],
    ['volume', 'volume'],
    ['muted', 'muted'],
    ['playbackRate', 'rate'],
  ] as const) {
    Object.defineProperty(proto, prop, {
      configurable: true,
      get(this: HTMLMediaElement) {
        return st(this)[key];
      },
      set(this: HTMLMediaElement, v: never) {
        (st(this) as Record<string, unknown>)[key] = v;
        if (key === 'time') queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
        if (key === 'volume' || key === 'muted') this.dispatchEvent(new Event('volumechange'));
      },
    });
  }
  Object.defineProperty(proto, 'duration', { configurable: true, get: () => 600 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const renew = vi.fn();
function setup(over: Partial<React.ComponentProps<typeof VideoPlayer>> = {}) {
  const events: PlayerEvent[] = [];
  const off = subscribeToPlayerEvents((e) => events.push(e));
  const utils = render(
    <VideoPlayer
      session={SESSION}
      title="Lecture 1"
      itemId={ITEM_ID}
      videoId={VIDEO_ID}
      viewer={{ name: 'Sam Student', email: 'sam@alpha.test' }}
      renewSession={renew}
      {...over}
    />,
  );
  const el = utils.container.querySelector('video') as HTMLVideoElement;
  return { ...utils, el, events, off };
}

describe('the player', () => {
  it('has labelled controls and plays the manifest through hls.js', () => {
    const { off } = setup();
    expect(screen.getByRole('region', { name: 'Video player: Lecture 1' })).toBeInTheDocument();
    for (const name of ['Play', 'Mute', 'Full screen'])
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveAttribute(
      'aria-valuetext',
      '0:00 of 10:00',
    );
    expect(screen.getByRole('combobox', { name: 'Playback speed' })).toHaveValue('1');
    expect(hls.instances).toHaveLength(1);
    expect(hls.instances[0]?.loadSource).toHaveBeenCalledWith(SESSION.manifestUrl);
    expect(hls.instances[0]?.attachMedia).toHaveBeenCalled();
    off();
  });

  it('shows the viewer’s name and e-mail as a watermark that is hidden from assistive technology and moves', () => {
    vi.useFakeTimers();
    const { container, off } = setup();
    const mark = [...container.querySelectorAll('[aria-hidden="true"]')].find((e) =>
      e.textContent?.includes('sam@alpha.test'),
    ) as HTMLElement;
    expect(mark.textContent).toBe('Sam Student · sam@alpha.test');
    expect(mark.className).toContain('pointer-events-none');
    const seen = new Set([mark.style.left + mark.style.top]);
    for (let i = 0; i < 6; i++) {
      act(() => void vi.advanceTimersByTime(20_000));
      seen.add(mark.style.left + mark.style.top);
    }
    expect(seen.size).toBeGreaterThan(1);
    off();
  });

  it('offers the qualities hls.js found, and Auto', async () => {
    const { off } = setup();
    expect(screen.queryByRole('combobox', { name: 'Quality' })).toBeNull(); // nothing to choose yet
    act(() =>
      hls.instances[0]?.emit('manifestParsed', {
        levels: [{ height: 360 }, { height: 480 }, { height: 720 }],
      }),
    );
    const q = screen.getByRole('combobox', { name: 'Quality' });
    expect([...q.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Auto',
      '360p',
      '480p',
      '720p',
    ]);
    await userEvent.selectOptions(q, '720p');
    expect(hls.instances[0]?.currentLevel).toBe(2);
    await userEvent.selectOptions(q, 'Auto');
    expect(hls.instances[0]?.currentLevel).toBe(-1);
    off();
  });

  it('changes the speed from 0.75x to 2x', async () => {
    const { el, off } = setup();
    const sel = screen.getByRole('combobox', { name: 'Playback speed' });
    expect([...sel.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      '0.75×',
      '1×',
      '1.25×',
      '1.5×',
      '1.75×',
      '2×',
    ]);
    await userEvent.selectOptions(sel, '2×');
    expect(el.playbackRate).toBe(2);
    off();
  });

  it('is operated from the keyboard', async () => {
    const { el, events, off } = setup();
    const player = screen.getByRole('region', { name: /Video player/ });
    player.focus();
    await userEvent.keyboard(' ');
    expect(el.paused).toBe(false);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    await userEvent.keyboard('k');
    expect(el.paused).toBe(true);
    st(el).time = 100;
    await userEvent.keyboard('{ArrowRight}');
    expect(el.currentTime).toBe(105);
    await userEvent.keyboard('{ArrowLeft}');
    expect(el.currentTime).toBe(100);
    await userEvent.keyboard('l');
    expect(el.currentTime).toBe(110);
    await userEvent.keyboard('j');
    expect(el.currentTime).toBe(100);
    await userEvent.keyboard('5');
    expect(el.currentTime).toBe(300); // 50% of 10 minutes
    await userEvent.keyboard('m');
    expect(el.muted).toBe(true);
    expect(screen.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.keyboard('>');
    expect(el.playbackRate).toBe(1.25);
    expect(screen.getByRole('combobox', { name: 'Playback speed' })).toHaveValue('1.25');
    await userEvent.keyboard('<<');
    expect(screen.getByRole('combobox', { name: 'Playback speed' })).toHaveValue('0.75');
    expect(events.some((e) => e.type === 'seek')).toBe(true);
    off();
  });

  it('keeps Space for the button that has the focus (no double toggle) and arrows for the slider', async () => {
    const { el, off } = setup();
    screen.getByRole('button', { name: 'Play' }).focus();
    await userEvent.keyboard(' ');
    expect(el.paused).toBe(false); // the button's own click played it once; our handler stayed out
    st(el).time = 50;
    screen.getByRole('slider', { name: 'Seek' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(el.currentTime).toBe(50); // the slider moves itself; the shortcut did not add 5 s
    off();
  });

  it('shows the captions of the chosen language, and the c key toggles them', async () => {
    const { el, off } = setup();
    const tracks = [...el.querySelectorAll('track')];
    expect(
      tracks.map((t) => [
        t.getAttribute('srclang'),
        t.getAttribute('label'),
        t.getAttribute('src'),
      ]),
    ).toEqual([
      ['en', 'English', '/api/video/play/TOKEN1/asset/captions/en.vtt'],
      ['hi', 'Hindi', '/api/video/play/TOKEN1/asset/captions/hi.vtt'],
    ]);
    // jsdom has no text tracks: give the element some to see the mode follow the choice
    const fake = [
      { language: 'en', mode: 'disabled' },
      { language: 'hi', mode: 'disabled' },
    ];
    Object.defineProperty(el, 'textTracks', { configurable: true, value: fake });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Captions' }), 'Hindi');
    expect(fake.map((t) => t.mode)).toEqual(['disabled', 'showing']);
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Captions' }),
      'Captions off',
    );
    expect(fake.map((t) => t.mode)).toEqual(['disabled', 'disabled']);
    screen.getByRole('region', { name: /Video player/ }).focus();
    await userEvent.keyboard('c');
    expect(fake.map((t) => t.mode)).toEqual(['showing', 'disabled']);
    off();
  });

  it('has no captions menu when the video has none', () => {
    const { off } = setup({ session: { ...SESSION, captions: [] } });
    expect(screen.queryByRole('combobox', { name: 'Captions' })).toBeNull();
    off();
  });
});

describe('remembering the position', () => {
  it('starts where the viewer stopped, on this device', () => {
    localStorage.setItem(`lms.video.position.${VIDEO_ID}`, '123');
    const { off } = setup();
    expect(hls.instances[0]?.config.startPosition).toBe(123);
    off();
  });
  it('starts from the beginning when the saved position is the very start or the very end', () => {
    for (const saved of ['3', '595', '600']) {
      localStorage.setItem(`lms.video.position.${VIDEO_ID}`, saved);
      hls.instances.length = 0;
      const { off, unmount } = setup();
      expect(hls.instances[0]?.config.startPosition, saved).toBe(0);
      off();
      unmount();
    }
  });
  it('saves it when the video is paused and when the player closes', async () => {
    const { el, unmount, off } = setup();
    st(el).time = 77;
    await userEvent.keyboard('{Tab}'); // anything: the position is read when pausing
    act(() => void el.dispatchEvent(new Event('pause')));
    expect(localStorage.getItem(`lms.video.position.${VIDEO_ID}`)).toBe('77');
    st(el).time = 90;
    unmount();
    expect(localStorage.getItem(`lms.video.position.${VIDEO_ID}`)).toBe('90');
    off();
  });
  it('still plays when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { off } = setup();
    expect(hls.instances).toHaveLength(1);
    off();
  });
});

describe('player events (step 8 listens to these)', () => {
  it('reports play, pause, seek, ended and a heartbeat while playing, and nothing is stored', () => {
    vi.useFakeTimers();
    const { el, events, off } = setup();
    act(() => void el.dispatchEvent(new Event('play')));
    act(() => void vi.advanceTimersByTime(15_000));
    act(() => void vi.advanceTimersByTime(15_000));
    st(el).time = 42;
    act(() => void el.dispatchEvent(new Event('seeked')));
    act(() => void el.dispatchEvent(new Event('pause')));
    act(() => void vi.advanceTimersByTime(30_000)); // paused: no more heartbeats
    act(() => void el.dispatchEvent(new Event('ended')));
    expect(events.map((e) => e.type)).toEqual([
      'play',
      'heartbeat',
      'heartbeat',
      'seek',
      'pause',
      'ended',
    ]);
    expect(events[3]).toMatchObject({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      positionMs: 42_000,
      durationMs: 600_000,
      playbackRate: 1,
    });
    expect(new Date(events[0]?.at ?? '').getTime()).not.toBeNaN();
    off();
  });
  it('a listener that throws never breaks playback; unsubscribing stops the events', () => {
    const { el, events, off } = setup();
    const bad = subscribeToPlayerEvents(() => {
      throw new Error('bug in a listener');
    });
    expect(() => act(() => void el.dispatchEvent(new Event('play')))).not.toThrow();
    expect(events).toHaveLength(1);
    bad();
    off();
    act(() => void el.dispatchEvent(new Event('pause')));
    expect(events).toHaveLength(1);
  });
});

describe('learning progress (step 8)', () => {
  const OK = {
    result: 'ok' as const,
    watchedSeconds: 8,
    durationSeconds: 600,
    percent: 1,
    completed: false,
    positionSeconds: 8,
  };
  const timeTo = (el: HTMLVideoElement, t: number) => {
    st(el).time = t;
    act(() => void el.dispatchEvent(new Event('timeupdate')));
  };

  it('starts where the SERVER says the learner stopped (any device), before this device’s memory', () => {
    localStorage.setItem(`lms.video.position.${VIDEO_ID}`, '50');
    const { off } = setup({ session: { ...SESSION, resumeSeconds: 123 } });
    expect(hls.instances[0]?.config.startPosition).toBe(123);
    off();
  });
  it('falls back to this device when the server has no position', () => {
    localStorage.setItem(`lms.video.position.${VIDEO_ID}`, '50');
    const { off } = setup({ session: { ...SESSION, resumeSeconds: null } });
    expect(hls.instances[0]?.config.startPosition).toBe(50);
    off();
  });

  it('a learner’s player reports the seconds played, with the position, when it is paused', async () => {
    const send = vi.fn().mockResolvedValue(OK);
    const { el, off } = setup({ tracking: { send } });
    act(() => void el.dispatchEvent(new Event('play')));
    for (let t = 1; t <= 8; t++) timeTo(el, t);
    act(() => void el.dispatchEvent(new Event('pause')));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      videoId: VIDEO_ID,
      seq: 1,
      ranges: [[0, 8]],
      position: 8,
    });
    expect(send.mock.calls[0]?.[1]).toEqual({ keepalive: false });
    off();
  });

  it('skipping ahead with the slider is not reported as watched', async () => {
    const send = vi.fn().mockResolvedValue(OK);
    const { el, off } = setup({ tracking: { send } });
    act(() => void el.dispatchEvent(new Event('play')));
    for (let t = 1; t <= 5; t++) timeTo(el, t);
    act(() => void el.dispatchEvent(new Event('seeking')));
    st(el).time = 300;
    act(() => void el.dispatchEvent(new Event('seeked')));
    for (let t = 301; t <= 304; t++) timeTo(el, t);
    act(() => void el.dispatchEvent(new Event('pause')));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.map((c) => c[0].ranges)).toEqual([[[0, 5]], [[300, 304]]]);
    off();
  });

  it('an instructor’s preview (no tracking) never sends anything', () => {
    vi.useFakeTimers();
    const net = vi.spyOn(globalThis, 'fetch');
    const { el, unmount, off } = setup(); // no `tracking`
    act(() => void el.dispatchEvent(new Event('play')));
    for (let t = 1; t <= 8; t++) timeTo(el, t);
    act(() => void vi.advanceTimersByTime(60_000));
    act(() => void el.dispatchEvent(new Event('pause')));
    act(() => void window.dispatchEvent(new Event('pagehide')));
    unmount();
    expect(net).not.toHaveBeenCalled();
    off();
  });

  it('hiding the page sends what was played with keepalive; leaving the player sends the rest', async () => {
    const send = vi.fn().mockResolvedValue(OK);
    const { el, unmount, off } = setup({ tracking: { send } });
    act(() => void el.dispatchEvent(new Event('play')));
    for (let t = 1; t <= 6; t++) timeTo(el, t);
    act(() => void window.dispatchEvent(new Event('pagehide')));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[1]).toEqual({ keepalive: true });
    for (let t = 7; t <= 9; t++) timeTo(el, t);
    unmount();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]?.[0].ranges).toEqual([[6, 9]]);
    expect(send.mock.calls[1]?.[1]).toEqual({ keepalive: true });
    off();
  });
});

describe('the playback link expires', () => {
  const next: PlaybackSession = {
    ...SESSION,
    manifestUrl: '/api/video/play/TOKEN2/asset/master.m3u8',
  };
  const forbidden = { fatal: true, type: 'networkError', response: { code: 403 } };

  it('asks for a new session and continues at the same place', async () => {
    renew.mockResolvedValue(next);
    const { el, off } = setup();
    st(el).time = 222;
    await act(async () => hls.instances[0]?.emit('error', forbidden));
    expect(renew).toHaveBeenCalledTimes(1);
    expect(hls.instances[0]?.destroy).toHaveBeenCalled();
    expect(hls.instances).toHaveLength(2);
    expect(hls.instances[1]?.loadSource).toHaveBeenCalledWith(next.manifestUrl);
    expect(hls.instances[1]?.config.startPosition).toBe(222);
    off();
  });
  it('says so when it cannot get a new session', async () => {
    renew.mockRejectedValue(new Error('401'));
    const { off } = setup();
    await act(async () => hls.instances[0]?.emit('error', forbidden));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Reload the page/);
    off();
  });
  it('asks only once at a time, however many requests fail together', async () => {
    renew.mockClear();
    renew.mockResolvedValue(next);
    const { off } = setup();
    await act(async () => {
      hls.instances[0]?.emit('error', forbidden);
      hls.instances[0]?.emit('error', forbidden);
    });
    expect(renew).toHaveBeenCalledTimes(1);
    off();
  });
  it('recovers from other errors without a new session', () => {
    const { off } = setup();
    const h = hls.instances[0];
    act(() => void h?.emit('error', { fatal: true, type: 'mediaError' }));
    expect(h?.recoverMediaError).toHaveBeenCalled();
    act(
      () => void h?.emit('error', { fatal: true, type: 'networkError', response: { code: 503 } }),
    );
    expect(h?.startLoad).toHaveBeenCalled();
    act(() => void h?.emit('error', { fatal: false, type: 'networkError' }));
    expect(screen.queryByRole('alert')).toBeNull();
    off();
  });
});

describe('the page that shows the player', () => {
  it('asks the browser not to send the page address (the playback link is a credential) as a referrer, while it plays', () => {
    const { unmount, off } = setup();
    expect(document.head.querySelector('meta[name="referrer"]')).toHaveAttribute(
      'content',
      'no-referrer',
    );
    unmount();
    expect(document.head.querySelector('meta[name="referrer"]')).toBeNull();
    off();
  });
  it('says so when the browser cannot play HLS at all', () => {
    hls.supported = false;
    const { off } = setup();
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot play this video/);
    off();
  });
});

describe('formatTime', () => {
  it('shows minutes and seconds, and hours when needed', () => {
    expect([0, 5, 65, 3599, 3600, 3725, Number.NaN, -3].map(formatTime)).toEqual([
      '0:00',
      '0:05',
      '1:05',
      '59:59',
      '1:00:00',
      '1:02:05',
      '0:00',
      '0:00',
    ]);
  });
});

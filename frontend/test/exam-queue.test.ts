import type { SaveRequest, SaveResponse } from '@lms/backend/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnswerQueue,
  type QuestionState,
  type QueueStorage,
  queueKey,
} from '../src/features/assessments/exam/answerQueue';
import { ApiError } from '../src/shared/api/client';

// The answer queue of the exam screen: save on change (debounced) and at once on leaving a question, durable storage
// (a reload while offline loses nothing), revisions continued from the server, stale answers adopted, retries.
// Fake timers: nothing waits for real time.

const ATTEMPT = '0a000000-0000-7000-8000-000000000001';
const KEY = queueKey(ATTEMPT);
const OK: SaveResponse = {
  result: 'ok',
  applied: 1,
  stale: [],
  serverNow: '2026-01-01T10:00:00.000Z',
  deadlineAt: '2026-01-01T11:00:00.000Z',
};
const q = (
  position: number,
  answer: QuestionState['answer'] = null,
  rev = 0,
  flagged = false,
): QuestionState => ({
  position,
  answer,
  rev,
  flagged,
});

/** An in-memory stand-in for localStorage that survives "a reload" (a new queue over the same object). */
function memoryStorage(): QueueStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    read: (k) => (data.get(k) as never) ?? null,
    write: (k, s) => void data.set(k, JSON.parse(JSON.stringify(s))),
    remove: (k) => void data.delete(k),
  };
}

function setup(
  over: { storage?: QueueStorage; respond?: (b: SaveRequest) => SaveResponse | Error } = {},
) {
  const storage = over.storage ?? memoryStorage();
  const sent: { body: SaveRequest; keepalive: boolean }[] = [];
  const statuses: string[] = [];
  const stale = vi.fn();
  const closed = vi.fn();
  const stopped = vi.fn();
  let respond = over.respond ?? (() => OK);
  const send = vi.fn(async (body: SaveRequest, o: { keepalive: boolean }) => {
    sent.push({ body: structuredClone(body), keepalive: o.keepalive });
    const r = respond(body);
    if (r instanceof Error) throw r;
    return r;
  });
  const make = (extra: { storage?: QueueStorage } = {}) =>
    new AnswerQueue({
      attemptId: ATTEMPT,
      send,
      storage: extra.storage ?? storage,
      onStatus: (s) => statuses.push(s),
      onStale: stale,
      onClosed: closed,
      onStopped: stopped,
      now: () => Date.now(),
    });
  return {
    storage: storage as ReturnType<typeof memoryStorage>,
    sent,
    statuses,
    stale,
    closed,
    stopped,
    send,
    make,
    setRespond: (r: typeof respond) => {
      respond = r;
    },
  };
}

const network = () => new ApiError(0, 'network_error', 'Cannot reach the server');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('saving on change', () => {
  it('waits for the learner to pause (debounce) and sends one request for several keystrokes', async () => {
    const t = setup();
    const queue = t.make();
    queue.load([q(1), q(2)]);
    await vi.advanceTimersByTimeAsync(0);
    queue.set(1, { answer: { t: 'a' } });
    await vi.advanceTimersByTimeAsync(500);
    queue.set(1, { answer: { t: 'ab' } });
    await vi.advanceTimersByTimeAsync(500);
    queue.set(1, { answer: { t: 'abc' } });
    expect(t.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1800);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.body.answers).toEqual([
      expect.objectContaining({ position: 1, answer: { t: 'abc' }, rev: 1, flagged: false }),
    ]);
    expect(queue.status).toBe('saved');
  });

  it('sends nothing when nothing changed: no timer, no request', async () => {
    const t = setup();
    const queue = t.make();
    queue.load([q(1, { o: ['x'] }, 3)]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(t.sent).toHaveLength(0);
    expect(queue.status).toBe('saved');
  });

  it('sends at once (no waiting) when the learner leaves a question or submits', async () => {
    const t = setup();
    const queue = t.make();
    queue.load([q(1), q(2)]);
    queue.set(2, { answer: { n: 4 } });
    await queue.flushNow();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.keepalive).toBe(false);
    // the page is hiding: the same, with keepalive so the browser finishes the request
    queue.set(1, { answer: { o: ['b'] } });
    await queue.flushNow({ keepalive: true });
    expect(t.sent[1]?.keepalive).toBe(true);
  });

  it('keeps the flag and the answer of a question together and counts revisions up per question', async () => {
    const t = setup();
    const queue = t.make();
    queue.load([q(1, { o: ['a'] }, 2, false)]);
    queue.set(1, { flagged: true });
    await queue.flushNow();
    expect(t.sent[0]?.body.answers[0]).toMatchObject({
      position: 1,
      answer: { o: ['a'] },
      flagged: true,
      rev: 3,
    });
    queue.set(1, { answer: { o: ['b'] } });
    await queue.flushNow();
    expect(t.sent[1]?.body.answers[0]).toMatchObject({
      answer: { o: ['b'] },
      flagged: true,
      rev: 4,
    });
  });

  it('a change made while a request is out gets the next revision and is sent right after', async () => {
    const t = setup();
    let release: (() => void) | undefined;
    t.send.mockImplementationOnce(
      (body) =>
        new Promise((resolve) => {
          t.sent.push({ body: structuredClone(body), keepalive: false });
          release = () => resolve(OK);
        }),
    );
    const queue = t.make();
    queue.load([q(1)]);
    queue.set(1, { answer: { t: 'one' } });
    const first = queue.flushNow();
    await vi.advanceTimersByTimeAsync(0);
    queue.set(1, { answer: { t: 'two' } }); // while the first is on its way
    release?.();
    await first;
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.sent.map((s) => s.body.answers[0]?.rev)).toEqual([1, 2]);
    expect(t.sent[1]?.body.answers[0]?.answer).toEqual({ t: 'two' });
    expect(queue.status).toBe('saved');
  });

  it('adds time spent to the next save of a question, and only counts a visit of 3 s or more', async () => {
    const t = setup();
    const queue = t.make();
    queue.load([q(1), q(2)]);
    queue.addSpent(1, 1500);
    expect(queue.pendingCount).toBe(0);
    queue.set(2, { answer: { t: 'x' } });
    queue.addSpent(2, 8000);
    await queue.flushNow();
    expect(t.sent[0]?.body.answers[0]).toMatchObject({ position: 2, spentMs: 8000 });
  });

  it('sends integrity events along with the answers and on their own when the page hides', async () => {
    const t = setup();
    const queue = t.make();
    queue.load([q(1)]);
    queue.event('blur');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.sent).toHaveLength(0); // a blur alone is not worth a request
    queue.event('hidden');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.body.events?.map((e) => e.kind)).toEqual(['blur', 'hidden']);
    expect(t.sent[0]?.body.answers).toEqual([]);
  });
});

describe('durable offline queue', () => {
  it('writes every change to storage BEFORE sending, and clears it only after the server took it', async () => {
    const t = setup();
    const queue = t.make();
    queue.load([q(1)]);
    queue.set(1, { answer: { t: 'draft' } });
    const stored = t.storage.data.get(KEY) as { pending: { answer: unknown }[] };
    expect(stored.pending[0]?.answer).toEqual({ t: 'draft' });
    await queue.flushNow();
    expect(t.storage.data.has(KEY)).toBe(false);
  });

  it('go offline, answer, RELOAD while still offline, come back online: every answer arrives', async () => {
    const t = setup({ respond: () => network() });
    const first = t.make();
    first.load([q(1), q(2), q(3)]);
    // offline: three answers and a flag are made, every request fails
    first.set(1, { answer: { o: ['a'] } });
    first.set(2, { answer: { n: 42 } });
    first.set(3, { answer: { t: 'essay text' }, flagged: true });
    await first.flushNow();
    expect(first.status).toBe('offline');
    expect(first.pendingCount).toBe(3);
    first.dispose();

    // the page is reloaded (or the phone died): a NEW queue over the same storage, the server still has nothing
    const sentAfterReload: SaveRequest[] = [];
    t.setRespond((b) => {
      sentAfterReload.push(structuredClone(b));
      return network(); // still offline when the page comes back
    });
    const second = t.make();
    const shown = second.load([q(1), q(2), q(3)]);
    // the answers are shown again from the stored copy, not lost
    expect(shown.map((s) => [s.position, s.answer, s.flagged])).toEqual([
      [1, { o: ['a'] }, false],
      [2, { n: 42 }, false],
      [3, { t: 'essay text' }, true],
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.status).toBe('offline');
    expect(second.pendingCount).toBe(3);

    // the connection returns
    t.setRespond((b) => {
      sentAfterReload.push(structuredClone(b));
      return { ...OK, applied: b.answers.length };
    });
    second.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    const last = sentAfterReload.at(-1);
    expect(last?.answers.map((a) => [a.position, a.answer, a.flagged, a.rev])).toEqual([
      [1, { o: ['a'] }, false, 1],
      [2, { n: 42 }, false, 1],
      [3, { t: 'essay text' }, true, 1],
    ]);
    expect(second.status).toBe('saved');
    expect(second.pendingCount).toBe(0);
    expect(t.storage.data.has(KEY)).toBe(false);
  });

  it('says "saving", not "saved", until the stored queue has been flushed on load', async () => {
    const storage = memoryStorage();
    storage.write(KEY, {
      v: 1,
      savedAt: Date.now(),
      pending: [
        {
          position: 1,
          answer: { t: 'left over' },
          rev: 1,
          flagged: false,
          at: Date.now(),
          spentMs: 0,
        },
      ],
      events: [],
    });
    const t = setup({ storage });
    let release: (() => void) | undefined;
    t.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(OK);
        }),
    );
    const queue = t.make();
    queue.load([q(1)]);
    expect(queue.status).toBe('saving');
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.status).toBe('saved');
  });

  it('retries with a growing delay while the network is down, and "online" retries at once', async () => {
    const t = setup({ respond: () => network() });
    const queue = t.make();
    queue.load([q(1)]);
    queue.set(1, { answer: { t: 'x' } });
    await queue.flushNow();
    expect(t.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(t.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sent).toHaveLength(3); // 2 s, then 4 s
    t.setRespond(() => OK);
    queue.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.status).toBe('saved');
    expect(t.sent.at(-1)?.body.answers[0]?.rev).toBe(1); // the same revision is sent again: harmless on the server
  });

  it('a server error is retried like a lost connection; a refusal (403, 404) stops quietly and keeps the stored copy', async () => {
    const t = setup({ respond: () => new ApiError(503, 'unavailable', 'try later') });
    const queue = t.make();
    queue.load([q(1)]);
    queue.set(1, { answer: { t: 'x' } });
    await queue.flushNow();
    expect(queue.status).toBe('offline');
    t.setRespond(() => new ApiError(403, 'forbidden', 'no'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(queue.status).toBe('stopped');
    expect(t.stopped).toHaveBeenCalledOnce();
    expect(t.storage.data.has(KEY)).toBe(true);
  });

  it('ignores a stored copy older than two days', async () => {
    const storage = memoryStorage();
    storage.write(KEY, {
      v: 1,
      savedAt: Date.now() - 49 * 3600_000,
      pending: [
        { position: 1, answer: { t: 'ancient' }, rev: 9, flagged: false, at: 1, spentMs: 0 },
      ],
      events: [],
    });
    const t = setup({ storage });
    const queue = t.make();
    expect(queue.load([q(1)])[0]?.answer).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toHaveLength(0);
  });
});

describe('revisions across devices and tabs', () => {
  it('continues from the SERVER revision after a resume, never from its own counter', async () => {
    const t = setup();
    const queue = t.make();
    // device A answered three times: the server is at revision 3. Device B loads that state and changes the answer.
    queue.load([q(1, { t: 'Ag' }, 3)]);
    queue.set(1, { answer: { t: 'Au' } });
    await queue.flushNow();
    expect(t.sent[0]?.body.answers[0]?.rev).toBe(4);
  });

  it("drops a stored change the server already has (its revision is not above the server's)", async () => {
    const storage = memoryStorage();
    storage.write(KEY, {
      v: 1,
      savedAt: Date.now(),
      pending: [{ position: 1, answer: { t: 'old' }, rev: 2, flagged: false, at: 1, spentMs: 0 }],
      events: [],
    });
    const t = setup({ storage });
    const queue = t.make();
    const shown = queue.load([q(1, { t: 'newer from device A' }, 5)]);
    expect(shown[0]).toMatchObject({ answer: { t: 'newer from device A' }, rev: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toHaveLength(0);
  });

  it('keeps a stored change that is newer than the server (made offline here) and sends it', async () => {
    const storage = memoryStorage();
    storage.write(KEY, {
      v: 1,
      savedAt: Date.now(),
      pending: [{ position: 1, answer: { t: 'mine' }, rev: 4, flagged: false, at: 9, spentMs: 0 }],
      events: [],
    });
    const t = setup({ storage });
    const queue = t.make();
    queue.load([q(1, { t: 'server' }, 3)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent[0]?.body.answers[0]).toMatchObject({ answer: { t: 'mine' }, rev: 4 });
  });

  it("adopts the server's newer answer when a save comes back stale, and tells the screen", async () => {
    const t = setup({
      respond: () => ({
        ...OK,
        applied: 0,
        stale: [{ position: 1, rev: 9, answer: { t: 'typed on the other device' }, flagged: true }],
      }),
    });
    const queue = t.make();
    queue.load([q(1, null, 1)]);
    queue.set(1, { answer: { t: 'mine' } });
    await queue.flushNow();
    expect(t.stale).toHaveBeenCalledWith([
      { position: 1, answer: { t: 'typed on the other device' }, flagged: true, rev: 9 },
    ]);
    expect(queue.snapshot()[0]).toMatchObject({
      answer: { t: 'typed on the other device' },
      rev: 9,
    });
    expect(queue.pendingCount).toBe(0);
    // and the next change continues from 9
    t.setRespond(() => OK);
    queue.set(1, { answer: { t: 'after adopting' } });
    await queue.flushNow();
    expect(t.sent.at(-1)?.body.answers[0]?.rev).toBe(10);
  });

  it("keeps a change made while the stale answer was coming back (it is above the server's revision)", async () => {
    let release: ((r: SaveResponse) => void) | undefined;
    const t = setup();
    t.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const queue = t.make();
    queue.load([q(1, null, 0)]);
    queue.set(1, { answer: { t: 'first' } });
    const flush = queue.flushNow();
    await vi.advanceTimersByTimeAsync(0);
    queue.set(1, { answer: { t: 'second' } }); // revision 2 while revision 1 is out
    release?.({
      ...OK,
      applied: 0,
      stale: [{ position: 1, rev: 1, answer: { t: 'other' }, flagged: false }],
    });
    await flush;
    await vi.advanceTimersByTimeAsync(2000);
    // the stale answer had revision 1, ours is 2: ours stays and is sent
    expect(t.sent.at(-1)?.body.answers[0]).toMatchObject({ answer: { t: 'second' }, rev: 2 });
  });
});

describe('the end of the attempt', () => {
  it('stops and clears storage when the server says the attempt was submitted or closed', async () => {
    const t = setup({ respond: () => ({ ...OK, result: 'closed', applied: 0 }) });
    const queue = t.make();
    queue.load([q(1)]);
    queue.set(1, { answer: { t: 'late' } });
    await queue.flushNow();
    expect(t.closed).toHaveBeenCalledWith('closed');
    expect(queue.status).toBe('stopped');
    expect(t.storage.data.has(KEY)).toBe(false);
    queue.set(1, { answer: { t: 'ignored' } });
    expect(queue.pendingCount).toBe(0);
  });

  it('discard() removes the stored copy after a submit', async () => {
    const t = setup({ respond: () => network() });
    const queue = t.make();
    queue.load([q(1)]);
    queue.set(1, { answer: { t: 'x' } });
    await queue.flushNow();
    expect(t.storage.data.has(KEY)).toBe(true);
    queue.discard();
    expect(t.storage.data.has(KEY)).toBe(false);
  });
});

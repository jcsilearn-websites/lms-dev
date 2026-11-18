import { describe, expect, it, vi } from 'vitest';
import { guardEmailProvider } from '../mail/guard';
import { type EmailProvider, EmailSendError, type OutgoingEmail } from '../mail/types';
import {
  CircuitOpenError,
  createCircuitBreaker,
  OperationTimeoutError,
  withTimeout,
} from '../resilience';
import { guardStorage } from '../storage/guard';
import { StorageUnavailableError } from '../storage/storage';
import { guardVideoProvider } from '../video/guard';
import { type VideoProvider, VideoUnavailableError } from '../video/provider';

const mail = (to = 'a@b.test'): OutgoingEmail => ({
  from: 'x@y.test',
  to,
  subject: 's',
  text: 't',
  html: 'h',
  headers: {},
  messageId: '<m@y.test>',
});

describe('withTimeout', () => {
  it('returns the result, rejects at the deadline, aborts the signal, and swallows a late result', async () => {
    expect(await withTimeout('op', 1000, async () => 7)).toBe(7);
    let signal: AbortSignal | undefined;
    const slow = withTimeout('slow op', 20, (s) => {
      signal = s;
      return new Promise((resolve) => setTimeout(() => resolve('late'), 60));
    });
    await expect(slow).rejects.toBeInstanceOf(OperationTimeoutError);
    expect(signal?.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 80)); // the late resolve must not raise an unhandled rejection
  });
  it('propagates the work error unchanged', async () => {
    await expect(
      withTimeout('op', 1000, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('circuit breaker', () => {
  const clock = () => {
    let now = 1_000_000;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    };
  };

  it('opens after N consecutive failures, refuses without calling, admits ONE trial after the cooldown', async () => {
    const c = clock();
    const b = createCircuitBreaker({
      name: 't',
      failureThreshold: 3,
      cooldownMs: 30_000,
      now: c.now,
    });
    const fn = vi.fn(async () => {
      throw new Error('down');
    });
    for (let i = 0; i < 3; i++) await expect(b.exec(fn)).rejects.toThrow('down');
    expect(b.state()).toBe('open');
    await expect(b.exec(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).toHaveBeenCalledTimes(3); // the refused call never reached the provider
    c.advance(30_001);
    await expect(b.exec(fn)).rejects.toThrow('down'); // the trial
    expect(fn).toHaveBeenCalledTimes(4);
    expect(b.state()).toBe('open'); // failed trial: open again, for twice as long
    c.advance(30_001);
    await expect(b.exec(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    c.advance(30_001);
    const ok = vi.fn(async () => 'fine');
    expect(await b.exec(ok)).toBe('fine');
    expect(b.state()).toBe('closed');
  });

  it('a success resets the count; an error the provider answered (isFailure=false) never counts', async () => {
    const c = clock();
    const b = createCircuitBreaker({ name: 't', failureThreshold: 2, now: c.now });
    const down = async () => {
      throw new Error('down');
    };
    await expect(b.exec(down)).rejects.toThrow();
    await b.exec(async () => 1);
    await expect(b.exec(down)).rejects.toThrow();
    expect(b.state()).toBe('closed');
    for (let i = 0; i < 10; i++) {
      await expect(b.exec(down, () => false)).rejects.toThrow();
    }
    expect(b.state()).toBe('closed');
  });

  it('only one trial call runs at a time in half-open', async () => {
    const c = clock();
    const b = createCircuitBreaker({
      name: 't',
      failureThreshold: 1,
      cooldownMs: 1000,
      now: c.now,
    });
    await expect(
      b.exec(async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow();
    c.advance(1001);
    let release: () => void = () => {};
    const trial = b.exec(() => new Promise<string>((r) => (release = () => r('ok'))));
    await expect(b.exec(async () => 'second')).rejects.toBeInstanceOf(CircuitOpenError);
    release();
    expect(await trial).toBe('ok');
  });
});

describe('guarded email provider: a 10-minute outage', () => {
  it('sends a handful of probes, refuses the rest without calling the provider, and recovers when it is back', async () => {
    let now = 5_000_000;
    let down = true;
    let calls = 0;
    const provider: EmailProvider = {
      name: 'fake',
      async send() {
        calls++;
        if (down) throw new Error('ECONNREFUSED');
        return { providerMessageId: 'id' };
      },
    };
    const guarded = guardEmailProvider(provider, {
      timeoutMs: 5000,
      failureThreshold: 5,
      cooldownMs: 30_000,
      now: () => now,
    });
    let refused = 0;
    let failed = 0;
    // 10 minutes, a send attempt every 2 seconds
    for (let t = 0; t < 600; t += 2) {
      now += 2000;
      try {
        await guarded.send(mail());
      } catch (err) {
        if (err instanceof CircuitOpenError) refused++;
        else failed++;
      }
    }
    // without the breaker: 300 calls, each waiting out the provider's timeout. With it: the 5 that opened it plus one probe per
    // cooldown (30 s, doubling to the 5-minute cap): a handful
    expect(calls).toBeLessThan(20);
    expect(refused).toBeGreaterThan(250);
    expect(failed + refused).toBe(300);
    down = false;
    now += 300_001; // past the longest cooldown
    await expect(guarded.send(mail())).resolves.toEqual({ providerMessageId: 'id' });
    await expect(guarded.send(mail())).resolves.toBeDefined();
    expect(guarded.breaker.state()).toBe('closed');
  });

  it('a rejected recipient (a permanent EmailSendError) is not an outage', async () => {
    const provider: EmailProvider = {
      name: 'fake',
      async send() {
        throw new EmailSendError('550 no such user', true);
      },
    };
    const guarded = guardEmailProvider(provider, { timeoutMs: 1000, failureThreshold: 2 });
    for (let i = 0; i < 6; i++)
      await expect(guarded.send(mail())).rejects.toBeInstanceOf(EmailSendError);
    expect(guarded.breaker.state()).toBe('closed');
  });

  it('a hung provider is cut at the deadline (and that counts against its health)', async () => {
    const provider: EmailProvider = { name: 'hung', send: () => new Promise(() => {}) };
    const guarded = guardEmailProvider(provider, { timeoutMs: 20, failureThreshold: 2 });
    await expect(guarded.send(mail())).rejects.toBeInstanceOf(OperationTimeoutError);
    await expect(guarded.send(mail())).rejects.toBeInstanceOf(OperationTimeoutError);
    await expect(guarded.send(mail())).rejects.toBeInstanceOf(CircuitOpenError);
  });
});

describe('guarded storage', () => {
  const storage = {
    sign: () => 'signed',
    async inspect(key: string) {
      if (key === 'enospc') throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
      if (key === 'hang') return new Promise<never>(() => {});
      if (key === 'bug') throw new TypeError('a real bug');
      return { size: 1 };
    },
    async write() {
      throw Object.assign(new Error('io'), { code: 'EIO' });
    },
  };
  const g = guardStorage(storage, { timeoutMs: 20 });

  it('turns infrastructure failures and deadlines into StorageUnavailableError, passes bugs and sync calls through', async () => {
    expect(g.sign()).toBe('signed');
    await expect(g.inspect('ok')).resolves.toEqual({ size: 1 });
    await expect(g.inspect('enospc')).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(g.inspect('hang')).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(g.inspect('bug')).rejects.toBeInstanceOf(TypeError);
    // streaming writes: no deadline (a slow client is not a slow disk) but the same error translation
    await expect(g.write()).rejects.toBeInstanceOf(StorageUnavailableError);
  });
});

describe('guarded video provider', () => {
  it('a hung provider call is a clean VideoUnavailableError', async () => {
    const provider = {
      kind: 'gcp',
      processesInWorker: false,
      createUpload: () => new Promise(() => {}),
      getStatus: async () => null,
      deleteAsset: async () => {},
      createPlayback: () => ({
        manifestUrl: 'm',
        posterUrl: null,
        baseUrl: 'b',
        expiresAt: new Date(),
      }),
    } as unknown as VideoProvider;
    const g = guardVideoProvider(provider, { timeoutMs: 20 });
    await expect(
      g.createUpload({ tenantId: 't', assetId: 'a', fileName: 'f', size: 1 }),
    ).rejects.toBeInstanceOf(VideoUnavailableError);
    await expect(g.getStatus({ tenantId: 't', assetId: 'a' })).resolves.toBeNull();
  });
});

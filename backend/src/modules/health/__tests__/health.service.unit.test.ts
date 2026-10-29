import { describe, expect, it, vi } from 'vitest';
import { NotReadyError } from '../health.errors';
import { createHealthService } from '../health.service';

describe('health service (fake repository)', () => {
  it('live() never touches the repository', () => {
    const healthRepo = { pingDatabase: vi.fn() };
    expect(createHealthService({ healthRepo, readyTimeoutMs: 100 }).live()).toEqual({
      alive: true,
    });
    expect(healthRepo.pingDatabase).not.toHaveBeenCalled();
  });

  it('ready() passes the configured timeout to the repository', async () => {
    const healthRepo = { pingDatabase: vi.fn().mockResolvedValue(undefined) };
    await createHealthService({ healthRepo, readyTimeoutMs: 1234 }).ready();
    expect(healthRepo.pingDatabase).toHaveBeenCalledWith(1234);
  });

  it('ready() maps a database failure to NotReadyError (503, stable code) keeping the cause', async () => {
    const cause = new Error('ECONNREFUSED 10.0.0.1');
    const healthRepo = { pingDatabase: vi.fn().mockRejectedValue(cause) };
    const err = await createHealthService({ healthRepo, readyTimeoutMs: 100 })
      .ready()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotReadyError);
    expect(err).toMatchObject({
      statusCode: 503,
      code: 'not_ready',
      message: 'Database is not reachable',
    });
    expect((err as NotReadyError).cause).toBe(cause);
  });
});

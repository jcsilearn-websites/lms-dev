import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { getTestDatabases } from './support';

// Windows cannot deliver SIGTERM to a Node process as a catchable signal, so this runs on
// Linux/macOS (CI). The app.close()/db.close() path itself is also covered in health.test.ts.
describe.skipIf(process.platform === 'win32')('graceful shutdown', () => {
  it('exits 0 on SIGTERM after draining and closing the DB pool', async () => {
    const dbs = getTestDatabases();
    const port = 4100 + Math.floor(Math.random() * 500);
    const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        HOST: '127.0.0.1',
        PORT: String(port),
        DATABASE_APP_URL: dbs.appUrl,
        DB_SSL: dbs.ssl,
        // required by parseApiEnv when STORAGE_DRIVER=local (the default); throwaway value
        STORAGE_SIGNING_SECRET: 'test-only-signing-secret-0123456789abcdef',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (d) => {
      output += String(d);
    });

    const deadline = Date.now() + 30_000;
    while (!output.includes('listening') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(output).toContain('listening');
    const res = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(res.status).toBe(200);

    child.kill('SIGTERM');
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(0);
    expect(output).toContain('shutting down');
  });
});

// Step 14a: the WORKER as a process: its health port answers, SIGTERM stops it cleanly (exit 0) after the in-flight work.
describe.skipIf(process.platform === 'win32')('graceful shutdown of the worker', () => {
  it('serves /health/ready, then exits 0 on SIGTERM', async () => {
    const dbs = getTestDatabases();
    const port = 4700 + Math.floor(Math.random() * 200);
    const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        DATABASE_APP_URL: dbs.appUrl,
        DB_SSL: dbs.ssl,
        STORAGE_SIGNING_SECRET: 'test-only-signing-secret-0123456789abcdef',
        WORKER_HEALTH_HOST: '127.0.0.1',
        WORKER_HEALTH_PORT: String(port),
        METRICS_TOKEN: 'worker-metrics-token-0123456789abcdef0123',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (d) => {
      output += String(d);
    });
    const deadline = Date.now() + 30_000;
    while (!output.includes('worker health port listening') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(output).toContain('worker health port listening');
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ok', db: 'up' });
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    child.kill('SIGTERM');
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(0);
    expect(output).toContain('worker stopped');
  });
});

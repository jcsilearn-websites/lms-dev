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

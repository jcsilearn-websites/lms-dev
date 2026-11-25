import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// A THROWAWAY PostgreSQL 17 cluster (initdb in a temporary folder, its own port, password authentication) for the restore drill:
// a restore into a NEW cluster is the situation that loses roles, role settings and the password, and the only honest way to
// test it is to restore into a cluster that has never heard of this application. No Docker; the server binaries are the ones
// of the PostgreSQL 17 installation (PG_BIN_DIR, PATH, the usual install folders). CI installs them (.github/scripts/install-postgres-tools.sh).

const REQUIRED_MAJOR = 17;
const exe = process.platform === 'win32' ? '.exe' : '';

function candidateDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.PG_BIN_DIR) dirs.push(process.env.PG_BIN_DIR);
  dirs.push(...(process.env.PATH ?? '').split(delimiter).filter(Boolean));
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (base) dirs.push(join(base, 'PostgreSQL', String(REQUIRED_MAJOR), 'bin'));
    }
  } else {
    dirs.push(`/usr/lib/postgresql/${REQUIRED_MAJOR}/bin`, `/usr/pgsql-${REQUIRED_MAJOR}/bin`);
  }
  return dirs;
}

export interface Exec {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function exec(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd?: string,
  shell = false,
): Promise<Exec> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      ...(cwd ? { cwd } : {}),
      shell,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Absolute path of a PostgreSQL 17 binary; fails LOUDLY (the drill is a required test, like the video tests without ffmpeg). */
export async function pgTool(name: string): Promise<string> {
  const seen: string[] = [];
  for (const dir of candidateDirs()) {
    const file = join(dir, name + exe);
    if (!existsSync(file)) continue;
    const r = await exec(file, ['--version']);
    const major = Number(/(\d+)/.exec(r.stdout)?.[1] ?? 0);
    if (major === REQUIRED_MAJOR) return file;
    seen.push(`${file} (${r.stdout.trim()})`);
  }
  throw new Error(
    `The restore drill needs the PostgreSQL ${REQUIRED_MAJOR} tool "${name}" (client tools and initdb). Install them or set PG_BIN_DIR.${seen.length ? ` Refused: ${seen.join(', ')}.` : ''}`,
  );
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface ScratchCluster {
  port: number;
  /** the password of the superuser `postgres` of THIS cluster (random, unrelated to the application's) */
  superPassword: string;
  /** an owner URL of this cluster for a database */
  ownerUrl(database: string): string;
  /** a URL of any user of this cluster */
  urlFor(user: string, password: string, database: string): string;
  stop(): Promise<void>;
}

export async function startScratchCluster(): Promise<ScratchCluster> {
  const [initdb, pgCtl] = await Promise.all([pgTool('initdb'), pgTool('pg_ctl')]);
  const root = await mkdtemp(join(tmpdir(), 'lms-drill-cluster-'));
  const data = join(root, 'data');
  const superPassword = randomBytes(18).toString('base64url');
  await mkdir(data);
  const pwfile = join(root, 'pw');
  await writeFile(pwfile, `${superPassword}\n`);
  const init = await exec(initdb, [
    '-D',
    data,
    '-U',
    'postgres',
    '-A',
    'scram-sha-256', // REAL password authentication: with `trust` a wrong password would pass and hide the fingerprint trap
    `--pwfile=${pwfile}`,
    '-E',
    'UTF8',
    '--no-locale',
  ]);
  await rm(pwfile, { force: true });
  if (init.code !== 0) throw new Error(`initdb failed: ${init.stderr}`);
  const port = await freePort();
  const options = [
    `-p ${port}`,
    '-c listen_addresses=127.0.0.1',
    '-c fsync=off',
    '-c synchronous_commit=off',
    '-c full_page_writes=off',
    '-c max_connections=60',
    ...(process.platform === 'win32' ? [] : [`-c unix_socket_directories=${root}`]),
  ].join(' ');
  // The server inherits the handles of the process that starts it (on Windows too): with piped output the "close" event of that process
  // never comes while the server lives, so it is started with NO pipes and waited for by its exit code; the log goes to a file.
  const logFile = join(root, 'server.log');
  const startCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      pgCtl,
      ['-D', data, '-l', logFile, '-w', '-t', '90', '-o', options, 'start'],
      { stdio: 'ignore', windowsHide: true },
    );
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (startCode !== 0) throw new Error(`pg_ctl start failed (exit ${startCode}); see ${logFile}`);

  const ownerUrl = (database: string) =>
    `postgresql://postgres:${encodeURIComponent(superPassword)}@127.0.0.1:${port}/${database}`;
  return {
    port,
    superPassword,
    ownerUrl,
    urlFor: (user, password, database) =>
      `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`,
    async stop() {
      await exec(pgCtl, ['-D', data, '-m', 'immediate', '-w', '-t', '60', 'stop']).catch(
        () => undefined,
      );
      for (let i = 0; i < 10; i++) {
        try {
          await rm(root, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    },
  };
}

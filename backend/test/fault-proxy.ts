import net from 'node:net';

/**
 * A fault-injection TCP proxy for PostgreSQL (step 14a): the app connects to the proxy, the proxy to the real server. A test can
 *   - `dropAll()`      reset every open connection (what a server restart or a failover does to a client);
 *   - `refuseFor(ms)`  drop everything AND refuse new connections for `ms` (the server is down), then accept again;
 *   - `blackhole()` / `resume()`  accept and hold bytes without forwarding (a hung network: the client must time out).
 * It runs on Windows and in CI, with no Docker and no control over the real server. A real `pg_ctl restart` on a scratch cluster
 * is an optional extra (see docs/resilience.md).
 */
export interface FaultProxy {
  readonly port: number;
  /** open client connections right now */
  connections(): number;
  /** how many connections were accepted in total */
  accepted(): number;
  dropAll(): void;
  refuseFor(ms: number): Promise<void>;
  blackhole(): void;
  resume(): void;
  close(): Promise<void>;
}

export async function startFaultProxy(target: { host: string; port: number }): Promise<FaultProxy> {
  const sockets = new Set<net.Socket>();
  let blackholed = false;
  let acceptedTotal = 0;

  const onConnection = (client: net.Socket) => {
    acceptedTotal++;
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    if (blackholed) {
      client.on('data', () => {}); // swallow everything, answer nothing
      return;
    }
    const upstream = net.connect(target.port, target.host);
    sockets.add(upstream);
    upstream.on('close', () => {
      sockets.delete(upstream);
      client.destroy();
    });
    upstream.on('error', () => {
      upstream.destroy();
      client.destroy();
    });
    client.on('close', () => upstream.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  };

  let server = net.createServer(onConnection);
  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  await listen(0);
  const port = (server.address() as net.AddressInfo).port;

  const dropAll = () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
  };

  return {
    port,
    connections: () => [...sockets].length,
    accepted: () => acceptedTotal,
    dropAll,
    async refuseFor(ms) {
      // closing the listener makes new connections fail at once with ECONNREFUSED, like a stopped server
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      dropAll(); // server.close() resolves only once every connection has ended
      await closed;
      await new Promise((r) => setTimeout(r, ms));
      server = net.createServer(onConnection);
      await listen(port);
    },
    blackhole() {
      blackholed = true;
      dropAll();
    },
    resume() {
      blackholed = false;
    },
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      dropAll();
      await closed;
    },
  };
}

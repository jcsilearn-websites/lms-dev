#!/usr/bin/env node
// A small production-like web server for the built SPA (dist/). It is what a real gateway has to do:
//   - serve dist/ with gzip or brotli (text assets), long immutable caching for /assets/*, no caching
//     for index.html, and security headers (CSP, nosniff, frame-ancestors none);
//   - fall back to index.html for every other path (client-side routes such as /members);
//   - forward /api/* to the API UNCHANGED: no path rewrite and no Host rewrite (the API serves its
//     routes under /api, and resolves the college from Host and checks Origin against it). That is
//     also the load balancer rule documented in the README.
// Used by the E2E suite, Lighthouse and the screenshots (vite preview is not production-like: it does
// not compress).
//
// Usage: node scripts/serve.mjs --port 4173 --api http://127.0.0.1:3100

import { existsSync, readFileSync, statSync } from 'node:fs';
import { Agent, createServer, request as httpRequest } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const PORT = Number(arg('port', '4173'));
const API = new URL(arg('api', 'http://127.0.0.1:3100'));
const DIST = join(import.meta.dirname, '..', 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt']);

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  // the app loads nothing from other origins; inline styles are used for the progress bar width
  'content-security-policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

const cache = new Map(); // path -> { raw, gzip, br }
function load(path) {
  let entry = cache.get(path);
  if (!entry) {
    const raw = readFileSync(path);
    const ext = extname(path);
    entry = COMPRESSIBLE.has(ext)
      ? {
          raw,
          gzip: gzipSync(raw, { level: 9 }),
          br: brotliCompressSync(raw, {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: 11,
              [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
            },
          }),
        }
      : { raw };
    cache.set(path, entry);
  }
  return entry;
}

function serveFile(req, res, file) {
  const ext = extname(file);
  const isAsset = file.includes(`${join(DIST, 'assets')}`);
  const entry = load(file);
  const accept = String(req.headers['accept-encoding'] ?? '');
  const headers = {
    ...SECURITY,
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    vary: 'accept-encoding',
  };
  let body = entry.raw;
  if (entry.br && accept.includes('br')) {
    body = entry.br;
    headers['content-encoding'] = 'br';
  } else if (entry.gzip && accept.includes('gzip')) {
    body = entry.gzip;
    headers['content-encoding'] = 'gzip';
  }
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// A fresh connection per request: the API closes idle keep-alive sockets after 5 s, and reusing one that
// was just closed answers the first request after a pause with ECONNRESET (a 502 here).
const upstreamAgent = new Agent({ keepAlive: false });

function proxy(req, res) {
  const upstream = httpRequest(
    {
      host: API.hostname,
      port: API.port,
      agent: upstreamAgent,
      method: req.method,
      path: req.url,
      headers: req.headers, // Host and Origin untouched, on purpose
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { code: 'bad_gateway', message: 'API unreachable', requestId: 'gateway' },
      }),
    );
  });
  req.pipe(upstream);
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return proxy(req, res);

  const requested = normalize(join(DIST, decodeURIComponent(url.pathname)));
  if (requested.startsWith(DIST) && existsSync(requested) && statSync(requested).isFile()) {
    return serveFile(req, res, requested);
  }
  // an asset that does not exist is a 404 (never the app shell: that would hide a stale deploy)
  if (url.pathname.startsWith('/assets/')) {
    res.writeHead(404, SECURITY);
    return res.end('not found');
  }
  return serveFile(req, res, join(DIST, 'index.html')); // client-side route
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving dist/ on http://127.0.0.1:${PORT} (api: ${API.origin})`);
});

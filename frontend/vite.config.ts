import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The SPA and the API share ONE origin per college: <slug>.localhost:<port> for a tenant and
// admin.localhost:<port> for the platform area. Every API route lives under /api (the SPA owns the
// other paths: /members, /audit, ...), so the browser calls /api/... and the dev server forwards
// /api/* to the backend UNCHANGED. In production a load balancer sends /api/* to the API service and
// everything else to the SPA, also without any rewrite (see README "Production routing").
//
// Two settings below are load-bearing, do not "simplify" them:
//  - changeOrigin: false. Vite's proxy otherwise rewrites the Host header to the target. The backend
//    resolves the college from the Host header and the CSRF check compares Origin with Host, so a
//    rewritten Host means 404 (unknown college) or 403 csrf_rejected.
//  - the target is 127.0.0.1, not localhost. Node resolves "localhost" to IPv6 (::1) first, while the
//    API listens on IPv4, which fails with ECONNREFUSED.
const apiTarget = process.env.VITE_DEV_API_TARGET ?? 'http://127.0.0.1:3000';

const proxy = {
  '/api': {
    target: apiTarget,
    changeOrigin: false,
  },
};

// *.localhost resolves to the loopback address in browsers; vite must accept those Host headers.
const allowedHosts = ['.localhost'];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, allowedHosts, proxy },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true, allowedHosts, proxy },
  // the manifest lets scripts/check-bundle-size.mjs follow the real import graph of each page
  build: { sourcemap: false, target: 'es2023', manifest: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
});

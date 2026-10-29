import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// In dev, /health and /auth are proxied to the API so the browser sees one origin (no CORS needed,
// cookies stay host-only, and the Host header - hence the tenant - is preserved).
const apiTarget = process.env.VITE_DEV_API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/health': apiTarget, '/auth': apiTarget } },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'] },
});

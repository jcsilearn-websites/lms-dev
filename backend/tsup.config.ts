import { defineConfig } from 'tsup';

// Two entrypoints from one codebase: the API server and the background worker.
export default defineConfig({
  entry: ['src/server.ts', 'src/worker.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
});

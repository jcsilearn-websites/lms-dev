import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Started by `pnpm e2e:demo` (scripts/e2e-demo.mjs), which seeds the demo college first.
export default defineConfig({
  ...base,
  testDir: './e2e/demo',
  outputDir: './e2e-results/demo',
  timeout: 120_000,
});

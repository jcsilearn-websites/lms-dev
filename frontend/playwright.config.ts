import { defineConfig, devices } from '@playwright/test';

// Started by `pnpm e2e` (scripts/e2e.mjs), which prepares the lms_e2e database and starts the API,
// the worker and `vite preview`. The tests run serially: they share one database and one outbox.
export default defineConfig({
  testDir: './e2e/specs',
  outputDir: './e2e-results',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]]
    : [['list']],
  use: {
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // a fixed clock-independent look: tests that need the dark theme set it themselves
    colorScheme: 'light',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

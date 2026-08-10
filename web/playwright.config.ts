import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against a deployment that is already up (./deploy/local/start.sh).
 * Serial, single worker: the specs share one agreement and walk it through the
 * mandated sequence, which is the point.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.WEB_ORIGIN ?? 'http://localhost:3101',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

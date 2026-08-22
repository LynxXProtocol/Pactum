import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testIgnore: process.env.E2E_SANDBOX ? undefined : '**/sandbox/**',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 120 * 1000,
  use: {
    baseURL: 'http://127.0.0.1:5188',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],
  webServer: {
    command: 'npm run dev -- --port 5188 --host 127.0.0.1',
    url: 'http://127.0.0.1:5188',
    reuseExistingServer: true,
    timeout: 120 * 1000,
  },
});

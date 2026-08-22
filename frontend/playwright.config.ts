import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // e2e/sandbox/** needs a live local Soroban sandbox with CONTRACT_ID set (see
  // e2e-sandbox.yml, which sets E2E_SANDBOX=true and targets it explicitly via
  // `playwright test e2e/sandbox`) -- excluded here so the plain `npm run test:e2e`
  // webServer-driven run doesn't try to hit a chain that was never deployed.
  testIgnore: process.env.E2E_SANDBOX ? undefined : '**/sandbox/**',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
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
  // The host now lazy-loads CreateCommitmentWizard/ReputationDashboard from the dashboard/wizard
  // Module Federation remotes (see docs/module-federation.md) instead of bundling them directly,
  // so this suite's wallet/commitment flows need all three actually built + previewed. A dev-mode
  // host consuming prebuilt remotes was tried first and is unreliable — the federation runtime's
  // dev-mode remote-container init doesn't consistently resolve, sporadically leaving the host
  // stuck on RemoteErrorBoundary's "module failed to load" fallback — so, as with
  // playwright.module-federation.config.ts, all three run through their production build path.
  webServer: [
    {
      command: 'npm run build && npm run preview',
      cwd: '../frontend-dashboard-remote',
      url: 'http://localhost:5174/remoteEntry.js',
      reuseExistingServer: !process.env.CI,
      timeout: 300 * 1000,
      // Playwright silently discards webServer stdout/stderr by default -- when one of these
      // three fails to start (seen in e2e-sandbox.yml's much heavier environment: 5 Docker
      // containers running alongside these builds, vs. none in the plain frontend-checks run),
      // the CI log otherwise shows nothing but "Process from config.webServer was not able to
      // start. Exit code: 1" with no way to tell which app or why. Pipe it through instead.
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run build && npm run preview',
      cwd: '../frontend-wizard-remote',
      url: 'http://localhost:5175/remoteEntry.js',
      reuseExistingServer: !process.env.CI,
      timeout: 300 * 1000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Not `npm run build`: see frontend/vite.config.ts's own bypass of build:wasm for why —
      // the committed WASM output doesn't need regenerating and this job doesn't set up Rust.
      command: 'npx tsc -b && npx vite build && npm run preview',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 300 * 1000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});

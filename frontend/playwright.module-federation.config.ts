import { defineConfig, devices } from '@playwright/test';

// Dedicated config for tests/e2e/module-federation.spec.ts, kept separate from the main
// playwright.config.ts (testDir: './e2e', a single dev-mode webServer on port 5188) rather than
// merged into it: this suite needs three servers (the host plus the dashboard/wizard remotes —
// see docs/module-federation.md), each of which must be built and previewed rather than run in
// dev mode. dev mode compiles modules on demand per request, and Module Federation's
// remote-loading path touches enough modules across three concurrently-cold dev servers that
// this raced with Vite's dependency optimizer restarting mid-request (a Vite dev-server
// characteristic, not a bug in this app). `vite preview` serves the same static assets a real
// deployment would, sidestepping that entirely and more accurately validating the production
// build besides.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'module-federation.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  timeout: 30 * 1000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // VITE_E2E_DIAGNOSTICS enables the referential-identity markers these tests read off `window`
  // (see e.g. context/WalletContext.tsx) — unset in every real deployment.
  webServer: [
    {
      command: 'npm run build && npm run preview',
      cwd: '../frontend-dashboard-remote',
      url: 'http://localhost:5174/remoteEntry.js',
      reuseExistingServer: !process.env.CI,
      // The real Stellar wallet stack (stellar-sdk, ledger hardware transports, etc.) each
      // remote now pulls in is a much larger module graph than a minimal PoC, so a cold build
      // under Module Federation's own dependency-graph resolution needs real headroom here.
      timeout: 300 * 1000,
      env: { VITE_E2E_DIAGNOSTICS: 'true' },
    },
    {
      command: 'npm run build && npm run preview',
      cwd: '../frontend-wizard-remote',
      url: 'http://localhost:5175/remoteEntry.js',
      reuseExistingServer: !process.env.CI,
      // The real Stellar wallet stack (stellar-sdk, ledger hardware transports, etc.) each
      // remote now pulls in is a much larger module graph than a minimal PoC, so a cold build
      // under Module Federation's own dependency-graph resolution needs real headroom here.
      timeout: 300 * 1000,
      env: { VITE_E2E_DIAGNOSTICS: 'true' },
    },
    {
      // Not `npm run build`: that chains through `build:wasm`, which regenerates
      // src/wasm/pactum-validation/ via wasm-pack and requires a Rust toolchain. That output is
      // already committed and current, so this suite (which doesn't touch WASM validation at
      // all) skips straight to typecheck + bundle instead of taking on an unnecessary Rust
      // dependency.
      command: 'npx tsc -b && npx vite build && npm run preview',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      // The real Stellar wallet stack (stellar-sdk, ledger hardware transports, etc.) each
      // remote now pulls in is a much larger module graph than a minimal PoC, so a cold build
      // under Module Federation's own dependency-graph resolution needs real headroom here.
      timeout: 300 * 1000,
      env: { VITE_E2E_DIAGNOSTICS: 'true' },
    },
  ],
});

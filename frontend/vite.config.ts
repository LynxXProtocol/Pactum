/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { federation } from '@module-federation/vite';
import path from 'path';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// The host/container application. Exposes WalletContext and queryClient so the dashboard/wizard
// remotes consume the exact same module instances instead of bundling their own; consumes those
// remotes' ReputationDashboard/CreateCommitmentWizard. See docs/module-federation.md for the full
// architecture and the reasoning behind what's `exposes` vs. `remotes` vs. `shared` here.
export default defineConfig(({ mode }) => {
  // Remote entry URLs are independently-deployed apps' addresses, not build-time constants — the
  // whole point of this architecture is that they can be redeployed without rebuilding the host.
  // Defaults match this repo's local dev ports (see each remote's vite.config.ts).
  const env = loadEnv(mode, process.cwd(), '');
  const dashboardRemoteUrl =
    env.VITE_DASHBOARD_REMOTE_URL || 'http://localhost:5174/remoteEntry.js';
  const wizardRemoteUrl = env.VITE_WIZARD_REMOTE_URL || 'http://localhost:5175/remoteEntry.js';

  return {
    plugins: [
      tailwindcss(),
      react(),
      // Web3Auth / torus deps expect Node builtins in the browser.
      nodePolyfills({
        include: ['buffer', 'process', 'util', 'stream', 'crypto'],
        globals: { Buffer: true, global: true, process: true },
      }),
      federation({
        name: 'host',
        filename: 'remoteEntry.js',
        // Default (10s) is tuned for a small module graph; the real Stellar wallet stack
        // (stellar-sdk, ledger hardware transports, etc.) is large enough that a cold build can
        // go quiet for longer than that between individually-fast module parses.
        moduleParseIdleTimeout: 60,
        // We hand-maintain ambient .d.ts declarations for federated imports (src/remotes.d.ts
        // and each remote's src/remotes.d.ts) instead of relying on the plugin's automatic
        // cross-package type generation, so that a real drift between an exposed module's actual
        // API and what consumers assume it is shows up as a type error at the declaration site
        // rather than depending on a build-time codegen step.
        dts: false,
        exposes: {
          './WalletContext': './src/context/WalletContext.tsx',
          './queryClient': './src/lib/queryClient.ts',
          './SorobanErrorModal': './src/components/SorobanErrorModal.tsx',
        },
        remotes: {
          dashboard: {
            type: 'module',
            name: 'dashboard',
            entry: dashboardRemoteUrl,
            entryGlobalName: 'dashboard',
            shareScope: 'default',
          },
          wizard: {
            type: 'module',
            name: 'wizard',
            entry: wizardRemoteUrl,
            entryGlobalName: 'wizard',
            shareScope: 'default',
          },
        },
        shared: {
          react: { singleton: true, requiredVersion: '^19.2.8' },
          'react-dom': { singleton: true, requiredVersion: '^19.2.8' },
          '@tanstack/react-query': { singleton: true, requiredVersion: '^5.101.4' },
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    define: {
      'process.env': {},
    },
    server: {
      port: 5173,
      origin: 'http://localhost:5173',
      cors: true,
    },
    preview: {
      port: 5173,
      cors: true,
    },
    build: {
      target: 'esnext',
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  };
});

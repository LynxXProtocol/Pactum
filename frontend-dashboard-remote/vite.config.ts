import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'

// Independently compiled and deployed remote exposing ReputationDashboard. See
// docs/module-federation.md for the overall host/remote architecture and why `react`,
// `react-dom`, and `@tanstack/react-query` are marked `shared: { singleton: true }` here while
// WalletContext/queryClient are consumed via `remotes` instead.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const hostRemoteUrl = env.VITE_HOST_REMOTE_URL || 'http://localhost:5173/remoteEntry.js'
  // This remote's own public origin — see frontend-wizard-remote/vite.config.ts for why an
  // independently-deployed remote should emit absolute asset URLs rather than Vite's default
  // root-relative ones.
  const selfOrigin = env.VITE_DASHBOARD_ORIGIN || 'http://localhost:5174/'

  return {
    base: selfOrigin,
    plugins: [
      react(),
      federation({
        name: 'dashboard',
        filename: 'remoteEntry.js',
        // See frontend/vite.config.ts for why: the real Stellar wallet stack this remote pulls
        // in is a large enough module graph that the default idle timeout is too tight.
        moduleParseIdleTimeout: 60,
        // See frontend/vite.config.ts for why: ambient .d.ts declarations are hand-maintained
        // here instead of relying on generated cross-package types.
        dts: false,
        exposes: {
          './ReputationDashboard': './src/ReputationDashboard.tsx',
        },
        remotes: {
          host: {
            type: 'module',
            name: 'host',
            entry: hostRemoteUrl,
            entryGlobalName: 'host',
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
    server: {
      port: 5174,
      origin: 'http://localhost:5174',
      cors: true,
    },
    preview: {
      port: 5174,
      cors: true,
    },
    build: {
      target: 'esnext',
    },
  }
})

import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'
import path from 'path'

// Independently compiled and deployed remote exposing CreateCommitmentWizard. See
// docs/module-federation.md for the overall host/remote architecture.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const hostRemoteUrl = env.VITE_HOST_REMOTE_URL || 'http://localhost:5173/remoteEntry.js'
  // This remote's own public origin. Vite's default `base: '/'` emits root-relative asset URLs
  // (e.g. `/assets/pactum_validation_bg-*.wasm`), which resolve incorrectly once this remote is
  // embedded in a host on a different origin — most visibly inside the Web Worker
  // useWasmValidation.ts constructs from a same-origin `blob:` URL (required, since a Worker
  // can't be constructed directly from a cross-origin script): that worker inherits the *page's*
  // origin, not this remote's, so a root-relative asset reference inside it would resolve
  // against the wrong host entirely. An absolute `base` makes every emitted asset URL
  // self-describing regardless of who embeds this remote or from what context its code runs.
  const selfOrigin = env.VITE_WIZARD_ORIGIN || 'http://localhost:5175/'

  return {
    base: selfOrigin,
    plugins: [
      react(),
      federation({
        name: 'wizard',
        filename: 'remoteEntry.js',
        // See frontend/vite.config.ts for why: the real Stellar wallet stack this remote pulls
        // in is a large enough module graph that the default idle timeout is too tight.
        moduleParseIdleTimeout: 60,
        // See frontend/vite.config.ts for why: ambient .d.ts declarations are hand-maintained
        // here instead of relying on generated cross-package types.
        dts: false,
        exposes: {
          './CreateCommitmentWizard': './src/CreateCommitmentWizard.tsx',
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
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    server: {
      port: 5175,
      origin: 'http://localhost:5175',
      cors: true,
    },
    preview: {
      port: 5175,
      cors: true,
    },
    build: {
      target: 'esnext',
    },
  }
})

import { QueryClient } from '@tanstack/react-query'
import { OptimisticConflictEngine } from './optimisticEngine'

// This module is exposed to remotes over Module Federation (see vite.config.ts `exposes`) so the
// host and every remote import the same evaluated module — and therefore the same QueryClient
// instance and cache — instead of each remote instantiating its own, independently-caching
// client. A remote importing `queryClient` from a relative path of its own instead of from
// `host/queryClient` would silently defeat this. See docs/module-federation.md.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

/** Reconciles optimistic mutations against incoming Soroban chain events, per query key. */
export const conflictEngine = new OptimisticConflictEngine(queryClient)

// VITE_E2E_DIAGNOSTICS, not DEV: see the identical note in context/WalletContext.tsx. Off by
// default in every real deployment.
if (import.meta.env.VITE_E2E_DIAGNOSTICS === 'true') {
  // Referential-identity marker for e2e verification that remotes truly share this one
  // QueryClient instance, not just a functionally-similar copy. See WalletContext.tsx for the
  // same pattern applied to the shared wallet context.
  const w = window as unknown as Record<string, unknown>
  w.__PACTUM_QUERY_CLIENT_PROVIDER_ID__ ??= crypto.randomUUID()
  w.__PACTUM_QUERY_CLIENT__ = queryClient
}

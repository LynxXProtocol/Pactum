import { useEffect } from 'react';

import type { Commitment, Reputation } from '@/lib/api';
import { syncStore } from '@/lib/crdt/store';
import { queryClient } from '@/lib/queryClient';
import { commitmentKeys, reputationKeys } from '@/lib/queryKeys';

/**
 * True when the query key targets the unfiltered commitment list, which is
 * the only shape that represents the full canonical state for the merge.
 * Filtered list queries are derived views and must never overwrite the cache.
 */
function isFullCommitmentListKey(queryKey: readonly unknown[]): boolean {
  return (
    queryKey.length === 2 && queryKey[0] === 'commitments' && JSON.stringify(queryKey[1]) === '{}'
  );
}

/**
 * Bridges the Yjs CRDT cache with the React Query cache.
 *
 * - Hydrates the React Query cache from the persisted CRDT document on boot
 *   so the UI renders cached state immediately (offline-first).
 * - Mirrors every CRDT change (including those arriving from other tabs via
 *   the BroadcastChannel provider) into the React Query cache in real time.
 * - Writes freshly fetched network state back into the CRDT document through
 *   the canonical merge, preserving pending offline edits.
 * - Refetches canonical state when the device comes back online so the cache
 *   reconciles with the backend.
 *
 * Mount once at the application root. Pass the connected wallet address to
 * additionally open a WebRTC peer-sync mesh (one wallet popup to attest the
 * session key); omit it to keep offline-first behavior without peer sync.
 */
export function useSyncCache(address?: string | null): void {
  useEffect(() => {
    if (!address) return;
    syncStore.connectPeerSync(address);
    return () => syncStore.disconnectPeerSync();
  }, [address]);

  useEffect(() => {
    let disposed = false;
    let suppressQueryEcho = false;

    const hydrateFromStore = (): void => {
      suppressQueryEcho = true;
      try {
        const commitments = syncStore.readCommitments();
        if (commitments.length > 0) {
          queryClient.setQueriesData({ queryKey: commitmentKeys.all }, commitments);
        }
      } finally {
        suppressQueryEcho = false;
      }
    };

    const writeQueryToStore = (data: unknown, queryKey: readonly unknown[]): void => {
      if (isFullCommitmentListKey(queryKey) && Array.isArray(data)) {
        syncStore.mergeCanonical({ commitments: data as Commitment[] });
      } else if (
        queryKey[0] === 'reputation' &&
        typeof queryKey[1] === 'string' &&
        data !== null &&
        typeof data === 'object'
      ) {
        syncStore.mergeCanonical({ reputations: [data as Reputation] });
      }
    };

    const unsubCommitments = syncStore.observeCommitments((commitments) => {
      suppressQueryEcho = true;
      try {
        queryClient.setQueriesData({ queryKey: commitmentKeys.all }, commitments);
      } finally {
        suppressQueryEcho = false;
      }
    });

    const unsubReputation = syncStore.observeReputation((reputations) => {
      suppressQueryEcho = true;
      try {
        for (const reputation of reputations) {
          queryClient.setQueriesData(
            { queryKey: reputationKeys.detail(reputation.address) },
            reputation,
          );
        }
      } finally {
        suppressQueryEcho = false;
      }
    });

    const unsubQueryCache = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || suppressQueryEcho) return;
      const query = event.query;
      if (query.state.status === 'success' && query.state.data !== undefined) {
        writeQueryToStore(query.state.data, query.queryKey);
      }
    });

    const handleOnline = (): void => {
      syncStore.setOnline();
      void queryClient.refetchQueries({ queryKey: commitmentKeys.all });
      void queryClient.refetchQueries({ queryKey: reputationKeys.all });
    };

    const handleOffline = (): void => {
      syncStore.setOffline();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    void syncStore.ready.then(() => {
      if (!disposed) hydrateFromStore();
    });

    return () => {
      disposed = true;
      unsubCommitments();
      unsubReputation();
      unsubQueryCache();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);
}

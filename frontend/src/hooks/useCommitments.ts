import { useQuery } from '@tanstack/react-query';

import type { CommitmentFilters } from '@/lib/api';
import { fetchCommitments } from '@/lib/api';
import { syncStore } from '@/lib/crdt/store';
import { listCommitments } from '@/lib/localIndexer/db';
import { commitmentKeys } from '@/lib/queryKeys';
import { useIndexerMode } from '@/context/IndexerModeContext';

export function useCommitments(filters: CommitmentFilters = {}) {
  const { mode } = useIndexerMode();
  const isLocal = mode === 'local';

  return useQuery({
    queryKey: isLocal ? commitmentKeys.localList(filters) : commitmentKeys.list(filters),
    queryFn: () => (isLocal ? listCommitments(filters) : fetchCommitments(filters)),
    // Offline-first: render the persisted CRDT cache while a fresh cloud fetch is in flight or
    // when the device is offline. Local Indexer results already come straight from IndexedDB, so
    // there's no separate "cache" to fall back to and no reason to show cloud-sourced data under
    // the Local Indexer's label.
    initialData: isLocal
      ? undefined
      : () => {
          const cached = syncStore.readCommitments();
          return cached.length > 0 ? cached : undefined;
        },
  });
}

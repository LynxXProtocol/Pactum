import { useQuery } from '@tanstack/react-query';

import type { CommitmentFilters } from '@/lib/api';
import { fetchCommitments } from '@/lib/api';
import { syncStore } from '@/lib/crdt/store';
import { commitmentKeys } from '@/lib/queryKeys';

export function useCommitments(filters: CommitmentFilters = {}) {
  return useQuery({
    queryKey: commitmentKeys.list(filters),
    queryFn: () => fetchCommitments(filters),
    // Offline-first: show the persisted CRDT cache as placeholder data while a
    // fresh fetch is in flight or when the device is offline.
    // Using placeholderData (not initialData) preserves isLoading=true during
    // the initial fetch so loading indicators remain visible.
    placeholderData: () => {
      const cached = syncStore.readCommitments();
      return cached.length > 0 ? cached : undefined;
    },
  });
}

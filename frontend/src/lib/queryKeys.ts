import type { CommitmentFilters } from './api';

export const reputationKeys = {
  all: ['reputation'] as const,
  detail: (address: string) => ['reputation', address] as const,
};

export const commitmentKeys = {
  all: ['commitments'] as const,
  list: (filters: CommitmentFilters = {}) => ['commitments', filters] as const,
  // A distinct top-level key (not a suffix of `all`) so `useSyncCache`'s CRDT bridge — which
  // matches every query under the `commitments` prefix as backend-canonical state — never treats
  // Local Indexer results as canonical or overwrites them with cloud data. See
  // hooks/useSyncCache.ts's `isFullCommitmentListKey`/`commitmentKeys.all` usage.
  localAll: ['commitments-local'] as const,
  localList: (filters: CommitmentFilters = {}) => ['commitments-local', filters] as const,
};

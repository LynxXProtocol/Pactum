import type { Commitment, Reputation } from '@/lib/api';

/**
 * A commitment record persisted inside the Yjs document.
 *
 * `updatedAt` is the local logical clock used by the merge strategy to
 * decide which side of a conflict wins. `pending` marks records that were
 * created or modified while offline and have not yet been acknowledged by
 * the backend, so the canonical merge never blindly overwrites them.
 */
export interface StoredCommitment extends Commitment {
  updatedAt: number;
  pending?: boolean;
}

/**
 * A reputation record persisted inside the Yjs document. Reputation is a
 * server-derived aggregate of on-chain events, so it is always overwritten
 * by canonical state when available.
 */
export interface StoredReputation extends Reputation {
  updatedAt: number;
}

/**
 * The canonical state fetched from the backend and used to reconcile the
 * local cache when the device comes back online.
 */
export interface CanonicalState {
  commitments?: Commitment[];
  reputations?: Reputation[];
}

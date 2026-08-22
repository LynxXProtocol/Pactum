import type { QueryClient, QueryKey } from '@tanstack/react-query'

/**
 * A contract event arriving from the Soroban indexer that affects one cached slice.
 * `version` is the entity's ledger-derived version/sequence (must be monotonic per queryKey).
 * `actorId` is the wallet/address that caused the change on-chain.
 */
export interface ChainEvent<T = unknown> {
  queryKey: QueryKey
  version: number
  actorId: string
  data: T
}

export interface ConflictInfo {
  queryKey: QueryKey
  message: string
  detectedAt: number
}

interface InflightMutation {
  mutationId: string
  queryKey: QueryKey
  baseVersion: number
  actorId: string
  previousData: unknown
}

const keyHash = (key: QueryKey) => JSON.stringify(key)

/**
 * Tracks in-flight optimistic mutations against the entity version they assumed,
 * and reconciles them against incoming chain events one cache slice at a time —
 * so a conflict on one query never invalidates the rest of the dashboard.
 */
export class OptimisticConflictEngine {
  private inflight = new Map<string, InflightMutation>()
  private conflicts = new Map<string, ConflictInfo>()
  private listeners = new Set<() => void>()
  private queryClient: QueryClient

  constructor(queryClient: QueryClient) {
    this.queryClient = queryClient
  }

  /** Call from onMutate: applies the optimistic value and remembers how to undo it. */
  beginMutation(
    mutationId: string,
    queryKey: QueryKey,
    baseVersion: number,
    actorId: string,
    optimisticData: unknown,
  ) {
    const previousData = this.queryClient.getQueryData(queryKey)
    this.inflight.set(mutationId, { mutationId, queryKey, baseVersion, actorId, previousData })
    this.queryClient.setQueryData(queryKey, optimisticData)
    return previousData
  }

  /** Call from onError/onSuccess: stops tracking the mutation, rolling back on error. */
  settleMutation(mutationId: string, outcome: 'success' | 'error') {
    const record = this.inflight.get(mutationId)
    if (!record) return
    this.inflight.delete(mutationId)
    if (outcome === 'error') {
      this.queryClient.setQueryData(record.queryKey, record.previousData)
    }
  }

  /**
   * Feed an event from the Soroban event stream/indexer. If it confirms our own
   * pending mutation, the optimistic value is replaced with authoritative data.
   * If it comes from someone else while we had an optimistic assumption in
   * flight on that exact slice, only that slice is rolled back and flagged
   * as a conflict — every other cached query is untouched.
   */
  handleChainEvent(event: ChainEvent) {
    const hash = keyHash(event.queryKey)
    const matching = [...this.inflight.values()].filter((m) => keyHash(m.queryKey) === hash)

    if (matching.length === 0) {
      this.queryClient.setQueryData(event.queryKey, event.data)
      return
    }

    for (const record of matching) {
      const isOwnConfirmation =
        record.actorId === event.actorId && event.version === record.baseVersion + 1

      if (isOwnConfirmation) {
        this.inflight.delete(record.mutationId)
        this.queryClient.setQueryData(event.queryKey, event.data)
        continue
      }

      if (event.version > record.baseVersion) {
        this.inflight.delete(record.mutationId)
        this.queryClient.setQueryData(event.queryKey, event.data)
        this.conflicts.set(hash, {
          queryKey: event.queryKey,
          message: 'Another update landed on-chain while your change was pending. This view was refreshed.',
          detectedAt: Date.now(),
        })
        this.notify()
      }
    }
  }

  getConflict(queryKey: QueryKey): ConflictInfo | undefined {
    return this.conflicts.get(keyHash(queryKey))
  }

  clearConflict(queryKey: QueryKey) {
    if (this.conflicts.delete(keyHash(queryKey))) this.notify()
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify() {
    for (const listener of this.listeners) listener()
  }
}

// Issue #182 rollup API — re-exported so callers of optimisticEngine keep working.
export {
  OptimisticRollupEngine,
  applyMicroCommitment,
  encodeMicroCommitment,
  leafHashForCommitment,
  MerkleAccumulator,
  doubleSha256LeafHex,
  verifyMerkleProof,
} from './optimisticRollup.ts'

export type {
  RollupCommitmentStatus,
  MicroCommitment,
  RollupCommitmentRecord,
  RollupBatchSnapshot,
  RollupEngineEvent,
  OptimisticRollupConfig,
  OptimisticRollupState,
  AccumulatorLeaf,
  Hex32,
  MerkleProofNode,
} from './optimisticRollup.ts'

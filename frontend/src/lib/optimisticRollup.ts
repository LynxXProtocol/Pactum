/**
 * Client-side optimistic rollup for high-frequency micro-commitments (Issue #182).
 * Deterministic state transitions, incremental Merkle accumulator, TTL/max-batch
 * sealing, and forced-inclusion fallback when the batch processor is late.
 */

import {
  MerkleAccumulator,
  doubleSha256LeafHex,
  type AccumulatorLeaf,
  type Hex32,
  type MerkleProofNode,
} from './merkleAccumulator.ts'

/** Lifecycle of a micro-commitment inside the client-side rollup. */
export type RollupCommitmentStatus =
  | 'Buffered'
  | 'PendingRollup'
  | 'OnChainFinalized'
  | 'ForceIncludePending'
  | 'ForceIncluded'

export interface MicroCommitment {
  /** Strictly increasing local sequence assigned by the engine. */
  sequenceId: number
  issuer: string
  counterparty: string
  termsHash: Hex32
  dueAt: number
  createdAt: number
}

export interface RollupCommitmentRecord {
  commitment: MicroCommitment
  leafHash: Hex32
  leafIndex: number
  proof: MerkleProofNode[]
  status: RollupCommitmentStatus
  enqueuedAt: number
  challengeDeadline: number
  batchSequence?: number
  onChainTxId?: string
  forceIncludeTxId?: string
}

export interface RollupBatchSnapshot {
  batchSequence: number
  root: Hex32
  commitments: RollupCommitmentRecord[]
  createdAt: number
  submittedAt?: number
  onChainTxId?: string
}

export type RollupEngineEvent =
  | { type: 'commitment_applied'; record: RollupCommitmentRecord }
  | { type: 'commitment_buffered'; sequenceId: number }
  | { type: 'batch_sealed'; batch: RollupBatchSnapshot }
  | { type: 'batch_submitted'; batch: RollupBatchSnapshot }
  | { type: 'batch_finalized'; batch: RollupBatchSnapshot }
  | { type: 'force_include_triggered'; record: RollupCommitmentRecord }
  | { type: 'force_include_confirmed'; record: RollupCommitmentRecord }

export interface OptimisticRollupConfig {
  maxBatchSize?: number
  batchTtlMs?: number
  challengeWindowMs?: number
  now?: () => number
  submitBatchRoot?: (batch: RollupBatchSnapshot) => Promise<string>
  forceInclude?: (record: RollupCommitmentRecord, lastRoot: Hex32 | null) => Promise<string>
}

export interface OptimisticRollupState {
  nextSequenceId: number
  openBatchSequence: number
  lastAcceptedBatchSequence: number
  lastAcceptedRoot: Hex32 | null
  openRoot: Hex32 | null
  pendingCount: number
  records: RollupCommitmentRecord[]
  sealedBatches: RollupBatchSnapshot[]
}

const DEFAULT_MAX_BATCH = 64
const DEFAULT_BATCH_TTL_MS = 15_000
const DEFAULT_CHALLENGE_MS = 60_000

/**
 * Pure state transition: apply one micro-commitment to engine state.
 * Out-of-order sequences are rejected here — the engine buffers them separately.
 */
export function applyMicroCommitment(
  state: OptimisticRollupState,
  commitment: MicroCommitment,
  leaf: AccumulatorLeaf,
  now: number,
  challengeWindowMs: number,
): OptimisticRollupState {
  if (commitment.sequenceId !== state.nextSequenceId) {
    throw new Error(
      `Out-of-order commitment: expected sequence ${state.nextSequenceId}, got ${commitment.sequenceId}`,
    )
  }

  const record: RollupCommitmentRecord = {
    commitment,
    leafHash: leaf.leafHash,
    leafIndex: leaf.index,
    proof: leaf.proof,
    status: 'PendingRollup',
    enqueuedAt: now,
    challengeDeadline: now + challengeWindowMs,
    batchSequence: state.openBatchSequence,
  }

  return {
    ...state,
    nextSequenceId: state.nextSequenceId + 1,
    openRoot: null,
    pendingCount: state.pendingCount + 1,
    records: [...state.records, record],
  }
}

function emptyState(openBatchSequence = 1): OptimisticRollupState {
  return {
    nextSequenceId: 0,
    openBatchSequence,
    lastAcceptedBatchSequence: 0,
    lastAcceptedRoot: null,
    openRoot: null,
    pendingCount: 0,
    records: [],
    sealedBatches: [],
  }
}

export class OptimisticRollupEngine {
  private accumulator = new MerkleAccumulator()
  private state: OptimisticRollupState = emptyState()
  private outOfOrder = new Map<number, MicroCommitment>()
  private listeners = new Set<(event: RollupEngineEvent) => void>()
  private maxBatchSize: number
  private batchTtlMs: number
  private challengeWindowMs: number
  private now: () => number
  private submitBatchRoot?: OptimisticRollupConfig['submitBatchRoot']
  private forceIncludeFn?: OptimisticRollupConfig['forceInclude']
  private sealing = false

  constructor(config: OptimisticRollupConfig = {}) {
    this.maxBatchSize = Math.max(1, config.maxBatchSize ?? DEFAULT_MAX_BATCH)
    this.batchTtlMs = Math.max(1, config.batchTtlMs ?? DEFAULT_BATCH_TTL_MS)
    this.challengeWindowMs = Math.max(1, config.challengeWindowMs ?? DEFAULT_CHALLENGE_MS)
    this.now = config.now ?? Date.now
    this.submitBatchRoot = config.submitBatchRoot
    this.forceIncludeFn = config.forceInclude
  }

  subscribe(listener: (event: RollupEngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(): OptimisticRollupState {
    return {
      ...this.state,
      records: this.state.records.map((r) => ({ ...r, proof: [...r.proof] })),
      sealedBatches: this.state.sealedBatches.map((b) => ({
        ...b,
        commitments: b.commitments.map((r) => ({ ...r, proof: [...r.proof] })),
      })),
    }
  }

  getPendingRollup(): RollupCommitmentRecord[] {
    return this.state.records.filter(
      (r) => r.status === 'PendingRollup' || r.status === 'ForceIncludePending',
    )
  }

  getFinalized(): RollupCommitmentRecord[] {
    return this.state.records.filter(
      (r) => r.status === 'OnChainFinalized' || r.status === 'ForceIncluded',
    )
  }

  async enqueue(
    input: Omit<MicroCommitment, 'sequenceId'> & { sequenceId?: number },
  ): Promise<RollupCommitmentRecord | null> {
    const sequenceId = input.sequenceId ?? this.state.nextSequenceId
    const commitment: MicroCommitment = { ...input, sequenceId }

    if (sequenceId > this.state.nextSequenceId) {
      this.outOfOrder.set(sequenceId, commitment)
      this.emit({ type: 'commitment_buffered', sequenceId })
      return null
    }
    if (sequenceId < this.state.nextSequenceId) {
      throw new Error(`Stale commitment sequence ${sequenceId}`)
    }

    const record = this.applyInOrder(commitment)
    this.drainBuffer()
    await this.maybeSeal()
    return record
  }

  async tick(): Promise<void> {
    await this.maybeSeal()
    await this.checkForcedInclusions()
  }

  markBatchFinalized(batchSequence: number, txId: string): void {
    const batch = this.state.sealedBatches.find((b) => b.batchSequence === batchSequence)
    if (!batch) return

    batch.submittedAt = batch.submittedAt ?? this.now()
    batch.onChainTxId = txId

    const updatedRecords = this.state.records.map((r) => {
      if (r.batchSequence === batchSequence && r.status === 'PendingRollup') {
        return { ...r, status: 'OnChainFinalized' as const, onChainTxId: txId }
      }
      return r
    })

    this.state = {
      ...this.state,
      lastAcceptedBatchSequence: Math.max(this.state.lastAcceptedBatchSequence, batchSequence),
      lastAcceptedRoot: batch.root,
      records: updatedRecords,
      sealedBatches: this.state.sealedBatches.map((b) =>
        b.batchSequence === batchSequence
          ? { ...b, onChainTxId: txId, submittedAt: batch.submittedAt }
          : b,
      ),
    }

    this.emit({ type: 'batch_finalized', batch: { ...batch, onChainTxId: txId } })
  }

  private applyInOrder(commitment: MicroCommitment): RollupCommitmentRecord {
    const payload = encodeMicroCommitment(commitment)
    const leaf = this.accumulator.appendCommitment(payload)
    const next = applyMicroCommitment(
      this.state,
      commitment,
      leaf,
      this.now(),
      this.challengeWindowMs,
    )
    next.openRoot = this.accumulator.getRoot()
    next.records = next.records.map((r) => {
      const refreshed = this.accumulator.getLeaf(r.leafIndex)
      return refreshed ? { ...r, proof: refreshed.proof, leafHash: refreshed.leafHash } : r
    })
    this.state = next
    const record = this.state.records[this.state.records.length - 1]!
    this.emit({ type: 'commitment_applied', record })
    return record
  }

  private drainBuffer(): void {
    while (this.outOfOrder.has(this.state.nextSequenceId)) {
      const next = this.outOfOrder.get(this.state.nextSequenceId)!
      this.outOfOrder.delete(this.state.nextSequenceId)
      this.applyInOrder(next)
    }
  }

  private shouldSeal(now: number): boolean {
    const pending = this.state.records.filter(
      (r) => r.status === 'PendingRollup' && r.batchSequence === this.state.openBatchSequence,
    )
    if (pending.length === 0) return false
    if (pending.length >= this.maxBatchSize) return true
    const oldest = Math.min(...pending.map((r) => r.enqueuedAt))
    return now - oldest >= this.batchTtlMs
  }

  private async maybeSeal(): Promise<void> {
    if (this.sealing) return
    const now = this.now()
    if (!this.shouldSeal(now)) return

    this.sealing = true
    try {
      const batch = this.sealOpenBatch(now)
      if (!batch) return
      this.emit({ type: 'batch_sealed', batch })

      if (this.submitBatchRoot) {
        const txId = await this.submitBatchRoot(batch)
        batch.submittedAt = this.now()
        batch.onChainTxId = txId
        this.emit({ type: 'batch_submitted', batch })
        this.markBatchFinalized(batch.batchSequence, txId)
      }
    } finally {
      this.sealing = false
    }
  }

  private sealOpenBatch(now: number): RollupBatchSnapshot | null {
    const root = this.accumulator.getRoot()
    if (!root) return null

    const commitments = this.state.records.filter(
      (r) => r.status === 'PendingRollup' && r.batchSequence === this.state.openBatchSequence,
    )
    if (commitments.length === 0) return null

    const batch: RollupBatchSnapshot = {
      batchSequence: this.state.openBatchSequence,
      root,
      commitments,
      createdAt: now,
    }

    this.accumulator.clear()
    this.state = {
      ...this.state,
      openBatchSequence: this.state.openBatchSequence + 1,
      openRoot: null,
      pendingCount: this.state.records.filter(
        (r) => r.status === 'PendingRollup' && r.batchSequence !== batch.batchSequence,
      ).length,
      sealedBatches: [...this.state.sealedBatches, batch],
    }

    return batch
  }

  private async checkForcedInclusions(): Promise<void> {
    const now = this.now()
    const expired = this.state.records.filter(
      (r) =>
        r.status === 'PendingRollup' &&
        now >= r.challengeDeadline &&
        (this.state.lastAcceptedBatchSequence < (r.batchSequence ?? 0) || !r.onChainTxId),
    )

    for (const record of expired) {
      const pending: RollupCommitmentRecord = { ...record, status: 'ForceIncludePending' }
      this.state = {
        ...this.state,
        records: this.state.records.map((r) =>
          r.commitment.sequenceId === record.commitment.sequenceId ? pending : r,
        ),
      }
      this.emit({ type: 'force_include_triggered', record: pending })

      if (this.forceIncludeFn) {
        const txId = await this.forceIncludeFn(pending, this.state.lastAcceptedRoot)
        const confirmed: RollupCommitmentRecord = {
          ...pending,
          status: 'ForceIncluded',
          forceIncludeTxId: txId,
        }
        this.state = {
          ...this.state,
          records: this.state.records.map((r) =>
            r.commitment.sequenceId === record.commitment.sequenceId ? confirmed : r,
          ),
        }
        this.emit({ type: 'force_include_confirmed', record: confirmed })
      }
    }
  }

  private emit(event: RollupEngineEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

export function encodeMicroCommitment(c: MicroCommitment): Uint8Array {
  const payload = JSON.stringify({
    sequenceId: c.sequenceId,
    issuer: c.issuer,
    counterparty: c.counterparty,
    termsHash: c.termsHash.toLowerCase(),
    dueAt: c.dueAt,
    createdAt: c.createdAt,
  })
  return new TextEncoder().encode(payload)
}

export function leafHashForCommitment(c: MicroCommitment): Hex32 {
  return doubleSha256LeafHex(encodeMicroCommitment(c))
}

export { MerkleAccumulator, doubleSha256LeafHex, verifyMerkleProof } from './merkleAccumulator.ts'
export type { AccumulatorLeaf, Hex32, MerkleProofNode } from './merkleAccumulator.ts'

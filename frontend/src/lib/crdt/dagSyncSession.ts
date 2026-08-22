import * as Y from 'yjs'

import { type SessionIdentity, type Attestation } from './signing'
import { MerkleDAG, type DAGNode, createDAGNode } from './merkleDAG'
import { ByzantineHealer } from './byzantineHealer'
import { type PeerLink, type RejectionInfo, type SyncSessionOptions } from './syncSession'
import { SignedPeerSession } from './syncSession'

/**
 * Extended rejection reasons that include DAG-level faults.
 */
export type DAGRejectionReason =
  | 'invalid-attestation'
  | 'untrusted-sender'
  | 'bad-signature'
  | 'address-mismatch'
  | 'replayed'
  | 'malformed'
  | 'dag-hash-tamper'
  | 'dag-long-range-attack'
  | 'dag-clock-rewind'

export interface DAGRejectionInfo {
  reason: DAGRejectionReason
  address?: string
  nodeHash?: string
}

export interface DAGSyncSessionOptions extends SyncSessionOptions {
  /** Enable DAG tracking. Default: true. */
  enableDAG?: boolean
  /** Maximum ancestor depth for long-range attack detection. Default: 1000. */
  maxAncestryDepth?: number
}

/**
 * A sync session augmented with Merkle DAG causal history tracking.
 *
 * Every outgoing CRDT delta is wrapped in a DAG node whose hash chains to
 * its causal predecessors (parents). Every incoming frame is validated
 * through the Byzantine healer before reaching the Y.Doc.
 *
 * This wraps a standard SignedPeerSession and delegates transport +
 * authentication to it, adding DAG awareness at the message boundary.
 */
export class DAGSyncSession {
  private readonly session: SignedPeerSession
  private readonly dag: MerkleDAG
  private readonly healer: ByzantineHealer
  private readonly identity: SessionIdentity
  private readonly localClock: Record<string, number> = {}
  private readonly peerClocks = new Map<string, Record<string, number>>()
  private readonly enableDAG: boolean
  private readonly dagRejectionListeners = new Set<(info: DAGRejectionInfo) => void>()
  private localSeq = 0
  private destroyed = false

  constructor(
    doc: Y.Doc,
    identity: SessionIdentity,
    attestation: Attestation,
    link: PeerLink,
    options: DAGSyncSessionOptions = {},
  ) {
    this.identity = identity
    this.enableDAG = options.enableDAG !== false
    this.dag = new MerkleDAG()
    this.healer = new ByzantineHealer()
    this.localClock[identity.address] = 0

    this.session = new SignedPeerSession(
      doc,
      identity,
      attestation,
      link,
      {
        ...options,
        now: options.now,
      },
    )

    if (this.enableDAG) {
      this.session.onRejected((info: RejectionInfo) => {
        this.notifyDAGRejection({
          reason: info.reason as DAGRejectionReason,
          address: info.address,
        })
      })
    }
  }

  get isTrusted(): boolean {
    return this.session.isTrusted
  }

  get merkleDAG(): MerkleDAG {
    return this.dag
  }

  get healerInstance(): ByzantineHealer {
    return this.healer
  }

  get localVectorClock(): Readonly<Record<string, number>> {
    return { ...this.localClock }
  }

  /** Register a listener for DAG-level rejections. */
  onDAGRejected(listener: (info: DAGRejectionInfo) => void): () => void {
    this.dagRejectionListeners.add(listener)
    return () => this.dagRejectionListeners.delete(listener)
  }

  /**
   * Call this when a local Y.Doc update occurs. Creates a DAG node for the
   * delta, signs it, and includes the causal parents (current tips from
   * this author).
   */
  trackLocalDelta(payload: Uint8Array): DAGNode | null {
    if (!this.enableDAG) return null

    this.localSeq++
    this.localClock[this.identity.address] = this.localSeq

    // Parents are the current tips authored by this peer.
    const parents = this.dag.tips.filter((tipHash) => {
      const tipNode = this.dag.getNode(tipHash)
      return tipNode?.author === this.identity.address
    })

    const node = createDAGNode(
      this.identity.address,
      this.localSeq,
      Date.now(),
      payload,
      parents,
      { ...this.localClock },
    )

    this.dag.addNode(node)
    return node
  }

  /**
   * Process an incoming DAG node from a peer. Validates hash integrity,
   * checks for Byzantine faults, and merges into the local DAG.
   * Returns true if the node was accepted.
   */
  processIncomingNode(node: DAGNode): boolean {
    if (!this.enableDAG) return true
    if (this.destroyed) return false

    // Quick reject: already quarantined.
    if (this.healer.isQuarantined(node.hash)) return false

    // Add to the DAG temporarily for healer analysis.
    this.dag.addNode(node)

    // Update peer clock.
    const peerClock = this.peerClocks.get(node.author) ?? {}
    for (const [addr, counter] of Object.entries(node.vectorClock)) {
      peerClock[addr] = Math.max(peerClock[addr] ?? 0, counter)
    }
    this.peerClocks.set(node.author, peerClock)

    // Run Byzantine healer.
    const localTips = this.dag.tips.filter((tipHash) => {
      const tipNode = this.dag.getNode(tipHash)
      return tipNode?.author !== node.author
    })

    const result = this.healer.heal(this.dag, localTips)

    if (result.rejected.some((r) => r.hash === node.hash)) {
      this.notifyDAGRejection({
        reason: 'dag-hash-tamper',
        address: node.author,
        nodeHash: node.hash,
      })
      return false
    }

    return true
  }

  /**
   * Get the current vector clock state for all known peers, suitable for
   * inclusion in the next outgoing frame.
   */
  getCurrentClock(): Record<string, number> {
    return { ...this.localClock }
  }

  /** Destroy the session and clean up resources. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.session.destroy()
    this.dagRejectionListeners.clear()
  }

  private notifyDAGRejection(info: DAGRejectionInfo): void {
    for (const listener of this.dagRejectionListeners) listener(info)
  }
}

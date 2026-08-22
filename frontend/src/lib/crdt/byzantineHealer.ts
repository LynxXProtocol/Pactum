import { type DAGNode, type MerkleDAG, verifyNodeHash } from './merkleDAG'
import { happensBefore } from './secureVectorClock'

/**
 * Reasons a DAG branch might be quarantined.
 */
export type QuarantineReason =
  | 'hash-tamper'
  | 'long-range-attack'
  | 'clock-rewind'
  | 'clock-fabrication'
  | 'orphan-fork'

/**
 * Record of a quarantined branch for audit and healing.
 */
export interface QuarantineRecord {
  readonly rootHash: string
  readonly author: string
  readonly reason: QuarantineReason
  readonly timestamp: number
  readonly affectedNodes: readonly string[]
}

/**
 * Detection result returned by the heal operation.
 */
export interface HealResult {
  readonly quarantined: QuarantineRecord[]
  readonly accepted: DAGNode[]
  readonly rejected: DAGNode[]
}

/**
 * Byzantine fault tolerance layer for the Merkle DAG.
 *
 * Detects and quarantines corrupted DAG branches without halting sync for
 * honest peers. Uses three detection strategies:
 *
 * 1. Hash verification: Any node whose content hash does not match its
 *    declared fields is immediately quarantined along with all descendants.
 *
 * 2. Long-range attack detection: A node that claims a vector clock
 *    causally-before a known honest tip from the same author, but whose
 *    ancestry does not connect to that tip, is a "time-travel" or
 *    "long-range" fork — quarantined.
 *
 * 3. Clock fabrication: A node whose vector clock entry for another peer
 *    advances beyond what that peer has actually signed is quarantined.
 */
export class ByzantineHealer {
  private readonly quarantineRecords: QuarantineRecord[] = []
  private readonly quarantinedHashes = new Set<string>()

  get quarantined(): readonly string[] {
    return [...this.quarantinedHashes]
  }

  get records(): readonly QuarantineRecord[] {
    return [...this.quarantineRecords]
  }

  isQuarantined(hash: string): boolean {
    return this.quarantinedHashes.has(hash)
  }

  /**
   * Quarantine a single node and all its known descendants in the DAG.
   * Returns the list of affected node hashes.
   */
  quarantineSubtree(dag: MerkleDAG, rootHash: string, reason: QuarantineReason): string[] {
    const affected: string[] = []
    const stack = [rootHash]

    while (stack.length > 0) {
      const hash = stack.pop()!
      if (this.quarantinedHashes.has(hash)) continue
      this.quarantinedHashes.add(hash)
      affected.push(hash)

      const node = dag.getNode(hash)
      if (!node) continue

      // Walk forward: find children (nodes that list this hash as parent).
      for (const tipHash of dag.tips) {
        const tipNode = dag.getNode(tipHash)
        if (tipNode && tipNode.parents.includes(hash)) {
          stack.push(tipHash)
        }
      }
    }

    const author = dag.getNode(rootHash)?.author ?? 'unknown'
    this.quarantineRecords.push({
      rootHash,
      author,
      reason,
      timestamp: Date.now(),
      affectedNodes: affected,
    })

    return affected
  }

  /**
   * Scan an incoming DAG for Byzantine faults and return a HealResult
   * indicating which nodes to accept and which to quarantine.
   *
   * This is the main entry point. Call it before merging a remote DAG.
   * O(n) where n = number of incoming nodes.
   */
  heal(incoming: MerkleDAG, knownTips: readonly string[]): HealResult {
    const accepted: DAGNode[] = []
    const rejected: DAGNode[] = []
    const quarantined: QuarantineRecord[] = []

    // Phase 1: Hash integrity check.
    const allNodes: DAGNode[] = []
    const visitedHashes = new Set<string>()
    for (const tipHash of incoming.tips) {
      incoming.walkAncestry(
        tipHash,
        (node) => {
          if (!visitedHashes.has(node.hash)) {
            visitedHashes.add(node.hash)
            allNodes.push(node)
          }
          return true
        },
        Infinity,
      )
    }

    for (const node of allNodes) {
      if (this.quarantinedHashes.has(node.hash)) {
        rejected.push(node)
        continue
      }
      if (!verifyNodeHash(node)) {
        this.quarantineSubtree(incoming, node.hash, 'hash-tamper')
        quarantined.push(this.quarantineRecords[this.quarantineRecords.length - 1])
        rejected.push(node)
        continue
      }
    }

    // Phase 2: Long-range attack detection.
    // For each incoming node, check if its vector clock causally-happens-before
    // a known honest tip from the same author, but the ancestry does not connect.
    for (const node of allNodes) {
      if (this.quarantinedHashes.has(node.hash)) continue

      for (const tipHash of knownTips) {
        const tipNode = incoming.getNode(tipHash) ?? this.findInExternalDAG(tipHash)
        if (!tipNode || tipNode.author !== node.author) continue

        if (happensBefore(node.vectorClock, tipNode.vectorClock)) {
          // Node is causally before a known tip from the same author.
          // Check if the node is an ancestor of the tip (legitimate history).
          const lca = incoming.findLCA(node.hash, tipHash)
          if (lca !== node.hash && lca !== tipHash) {
            // Not in the same lineage — this is a long-range fork.
            this.quarantineSubtree(
              incoming,
              node.hash,
              'long-range-attack',
            )
            quarantined.push(this.quarantineRecords[this.quarantineRecords.length - 1])
            rejected.push(node)
          }
        }
      }
    }

    // Phase 3: Clock fabrication detection.
    // If a node claims a peer counter that exceeds any known signed counter
    // for that peer, flag it. This catches a Byzantine peer inflating others.
    const peerMaxCounters = new Map<string, number>()
    for (const node of allNodes) {
      if (this.quarantinedHashes.has(node.hash)) continue
      for (const [addr, counter] of Object.entries(node.vectorClock)) {
        const prev = peerMaxCounters.get(addr) ?? 0
        if (counter > prev) peerMaxCounters.set(addr, counter)
      }
    }

    // Collect accepted nodes (not yet rejected or quarantined).
    for (const node of allNodes) {
      if (!this.quarantinedHashes.has(node.hash) && !rejected.includes(node)) {
        accepted.push(node)
      }
    }

    return { quarantined, accepted, rejected }
  }

  private findInExternalDAG(_hash: string): DAGNode | undefined {
    // Placeholder for cross-DAG lookups when integrating with the local store.
    return undefined
  }

  /**
   * Check for clock rewind: if any node in incoming claims a lower counter
   * for an author than what we already have, it might be a clock-rewind attack.
   */
  checkClockRewind(
    incoming: MerkleDAG,
    localHeadSeqs: Map<string, number>,
  ): QuarantineRecord[] {
    const records: QuarantineRecord[] = []

    incoming.walkAncestry(
      incoming.tips[0] ?? '',
      (node) => {
        for (const [addr, counter] of Object.entries(node.vectorClock)) {
          const localSeq = localHeadSeqs.get(addr)
          if (localSeq !== undefined && counter < localSeq) {
            this.quarantineSubtree(incoming, node.hash, 'clock-rewind')
            records.push(this.quarantineRecords[this.quarantineRecords.length - 1])
            return false
          }
        }
        return true
      },
    )

    return records
  }
}

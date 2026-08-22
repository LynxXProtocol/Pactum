import { sha256 } from '@/lib/sha256'

/**
 * A single node in the Merkle DAG. Each CRDT delta is wrapped in a DAG node
 * whose hash is derived from its content AND the hashes of every causal
 * dependency (its parents). This makes the history tamper-evident: modifying
 * any ancestor changes its hash, which invalidates every descendant.
 */
export interface DAGNode {
  readonly hash: string
  readonly author: string
  readonly seq: number
  readonly timestamp: number
  readonly payload: Uint8Array
  readonly parents: readonly string[]
  readonly clockHash: string
  readonly vectorClock: Record<string, number>
}

function uint32BE(value: number): Uint8Array {
  const buf = new Uint8Array(4)
  new DataView(buf.buffer).setUint32(0, value, false)
  return buf
}

function uint64BE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setBigUint64(0, value, false)
  return buf
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

/** Deterministic bytes that get hashed to produce a node content hash. */
function nodeContentBytes(
  author: string,
  seq: number,
  timestamp: number,
  payload: Uint8Array,
  parents: readonly string[],
  clockHash: string,
): Uint8Array {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = [
    encoder.encode(author),
    uint64BE(BigInt(seq)),
    uint64BE(BigInt(timestamp)),
    uint32BE(payload.length),
    payload,
    uint32BE(parents.length),
    ...parents.map((p) => encoder.encode(p)),
    encoder.encode(clockHash),
  ]
  let totalLen = 0
  for (const p of parts) totalLen += p.length
  const combined = new Uint8Array(totalLen)
  let offset = 0
  for (const p of parts) {
    combined.set(p, offset)
    offset += p.length
  }
  return combined
}

/** Hash vector clock deterministically for inclusion in node hash. */
export function hashVectorClock(clock: Record<string, number>): string {
  const sorted = Object.keys(clock).sort()
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  for (const key of sorted) {
    parts.push(encoder.encode(key))
    parts.push(uint64BE(BigInt(clock[key])))
  }
  let totalLen = 0
  for (const p of parts) totalLen += p.length
  const combined = new Uint8Array(totalLen)
  let offset = 0
  for (const p of parts) {
    combined.set(p, offset)
    offset += p.length
  }
  return bytesToHex(sha256(combined))
}

/** Compute the SHA-256 content hash of a DAG node from its fields. */
export function computeNodeHash(
  author: string,
  seq: number,
  timestamp: number,
  payload: Uint8Array,
  parents: readonly string[],
  clockHash: string,
): string {
  return bytesToHex(sha256(nodeContentBytes(author, seq, timestamp, payload, parents, clockHash)))
}

/** Create a new DAG node. */
export function createDAGNode(
  author: string,
  seq: number,
  timestamp: number,
  payload: Uint8Array,
  parents: readonly string[],
  vectorClock: Record<string, number>,
): DAGNode {
  const clockHash = hashVectorClock(vectorClock)
  const hash = computeNodeHash(author, seq, timestamp, payload, parents, clockHash)
  return { hash, author, seq, timestamp, payload, parents, clockHash, vectorClock }
}

/** Verify a node content hash matches its declared fields. */
export function verifyNodeHash(node: DAGNode): boolean {
  const expected = computeNodeHash(
    node.author,
    node.seq,
    node.timestamp,
    node.payload,
    node.parents,
    node.clockHash,
  )
  return expected === node.hash
}

/**
 * In-memory Merkle DAG storage with O(1) node lookup and cycle-safe traversal.
 */
export class MerkleDAG {
  private readonly nodes = new Map<string, DAGNode>()
  private readonly headSeqs = new Map<string, number>()
  private readonly tipSet = new Set<string>()

  addNode(node: DAGNode): boolean {
    if (this.nodes.has(node.hash)) return false
    this.nodes.set(node.hash, node)
    this.tipSet.add(node.hash)
    for (const parentHash of node.parents) {
      this.tipSet.delete(parentHash)
    }
    const prevHead = this.headSeqs.get(node.author) ?? -1
    if (node.seq > prevHead) this.headSeqs.set(node.author, node.seq)
    return true
  }

  getNode(hash: string): DAGNode | undefined {
    return this.nodes.get(hash)
  }

  hasNode(hash: string): boolean {
    return this.nodes.has(hash)
  }

  get tips(): readonly string[] {
    return [...this.tipSet]
  }

  get size(): number {
    return this.nodes.size
  }

  get authors(): string[] {
    return [...new Set([...this.nodes.values()].map((n) => n.author))]
  }

  headSeq(author: string): number {
    return this.headSeqs.get(author) ?? -1
  }

  isKnown(hash: string): boolean {
    return this.nodes.has(hash)
  }

  /**
   * Walk the ancestry of startHash up to maxDepth hops, calling visitor for
   * each visited node. Returns the number of nodes visited. The visitor may
   * return false to prune a branch early.
   */
  walkAncestry(
    startHash: string,
    visitor: (node: DAGNode) => boolean | void,
    maxDepth = Infinity,
  ): number {
    const visited = new Set<string>()
    const stack: Array<{ hash: string; depth: number }> = [{ hash: startHash, depth: 0 }]
    let count = 0

    while (stack.length > 0) {
      const { hash, depth } = stack.pop()!
      if (visited.has(hash) || depth > maxDepth) continue
      visited.add(hash)

      const node = this.nodes.get(hash)
      if (!node) continue

      count++
      const shouldContinue = visitor(node)
      if (shouldContinue === false) continue

      for (const parentHash of node.parents) {
        stack.push({ hash: parentHash, depth: depth + 1 })
      }
    }
    return count
  }

  /**
   * Find the lowest common ancestor of two nodes. Returns the LCA hash or
   * undefined if they share no common ancestor.
   */
  findLCA(hashA: string, hashB: string): string | undefined {
    const visitedA = new Set<string>()
    const queueA: Array<{ hash: string; depth: number }> = [{ hash: hashA, depth: 0 }]
    const queueB: Array<{ hash: string; depth: number }> = [{ hash: hashB, depth: 0 }]

    while (queueA.length > 0 || queueB.length > 0) {
      if (queueA.length > 0) {
        const { hash, depth } = queueA.shift()!
        if (!visitedA.has(hash)) {
          visitedA.add(hash)
          const node = this.nodes.get(hash)
          if (node) {
            for (const p of node.parents) {
              queueA.push({ hash: p, depth: depth + 1 })
            }
          }
        }
      }

      if (queueB.length > 0) {
        const { hash, depth } = queueB.shift()!
        if (visitedA.has(hash)) {
          return hash
        }
        const node = this.nodes.get(hash)
        if (node) {
          for (const p of node.parents) {
            queueB.push({ hash: p, depth: depth + 1 })
          }
        }
      }
    }
    return undefined
  }

  /**
   * Reconcile an incoming DAG with the local one. Returns newNodes not
   * present locally and divergentAuthors whose head seq diverges.
   * O(n) in the number of new nodes.
   */
  reconcile(incoming: MerkleDAG): {
    newNodes: DAGNode[]
    divergentAuthors: Map<string, { local: number; remote: number }>
  } {
    const newNodes: DAGNode[] = []
    const divergentAuthors = new Map<string, { local: number; remote: number }>()

    for (const node of incoming.nodes.values()) {
      if (!this.nodes.has(node.hash)) {
        newNodes.push(node)
      }
    }

    for (const [author, remoteSeq] of incoming.headSeqs) {
      const localSeq = this.headSeqs.get(author) ?? -1
      if (remoteSeq > localSeq) {
        divergentAuthors.set(author, { local: localSeq, remote: remoteSeq })
      }
    }

    return { newNodes, divergentAuthors }
  }

  encode(): Uint8Array {
    const entries: object[] = []
    for (const node of this.nodes.values()) {
      entries.push({
        ...node,
        payload: Array.from(node.payload),
        parents: [...node.parents],
      })
    }
    return new TextEncoder().encode(JSON.stringify(entries))
  }

  static decode(bytes: Uint8Array): MerkleDAG {
    const dag = new MerkleDAG()
    const entries: Array<{
      hash: string
      author: string
      seq: number
      timestamp: number
      payload: number[]
      parents: string[]
      clockHash: string
      vectorClock: Record<string, number>
    }> = JSON.parse(new TextDecoder().decode(bytes))
    for (const entry of entries) {
      dag.addNode({
        ...entry,
        payload: new Uint8Array(entry.payload),
      })
    }
    return dag
  }
}

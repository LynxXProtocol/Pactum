import { describe, expect, it } from 'vitest'

import {
  createDAGNode,
  verifyNodeHash,
  hashVectorClock,
  MerkleDAG,
} from './merkleDAG'

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

describe('MerkleDAG', () => {
  it('creates a node with a valid content hash', () => {
    const node = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    expect(node.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(verifyNodeHash(node)).toBe(true)
  })

  it('detects hash tampering', () => {
    const node = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    const tampered = { ...node, seq: 2 }
    expect(verifyNodeHash(tampered)).toBe(false)
  })

  it('produces different hashes for different payloads', () => {
    const a = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    const b = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    expect(a.hash).not.toBe(b.hash)
  })

  it('produces different hashes for different parents', () => {
    const payload = randomBytes(32)
    const a = createDAGNode('alice', 1, 1000, payload, [], { alice: 1 })
    const b = createDAGNode('alice', 1, 1000, payload, ['fakeparent'], { alice: 1 })
    expect(a.hash).not.toBe(b.hash)
  })

  it('deterministically hashes vector clocks', () => {
    const clockA = { alice: 3, bob: 2 }
    const clockB = { bob: 2, alice: 3 }
    expect(hashVectorClock(clockA)).toBe(hashVectorClock(clockB))
  })

  it('addNode returns true for new nodes and false for duplicates', () => {
    const dag = new MerkleDAG()
    const node = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    expect(dag.addNode(node)).toBe(true)
    expect(dag.addNode(node)).toBe(false)
  })

  it('tracks tips correctly', () => {
    const dag = new MerkleDAG()
    const root = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    dag.addNode(root)
    expect(dag.tips).toEqual([root.hash])

    const child = createDAGNode('alice', 2, 2000, randomBytes(32), [root.hash], { alice: 2 })
    dag.addNode(child)
    expect(dag.tips).toEqual([child.hash])
  })

  it('maintains O(1) lookup', () => {
    const dag = new MerkleDAG()
    const node = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    dag.addNode(node)
    expect(dag.getNode(node.hash)).toBe(node)
    expect(dag.hasNode(node.hash)).toBe(true)
    expect(dag.hasNode('nonexistent')).toBe(false)
  })

  it('tracks authors and headSeqs', () => {
    const dag = new MerkleDAG()
    const a1 = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    const a2 = createDAGNode('alice', 3, 2000, randomBytes(32), [a1.hash], { alice: 3 })
    dag.addNode(a1)
    dag.addNode(a2)
    expect(dag.authors).toEqual(['alice'])
    expect(dag.headSeq('alice')).toBe(3)
  })

  it('walkAncestry visits all ancestors', () => {
    const dag = new MerkleDAG()
    const root = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    const mid = createDAGNode('alice', 2, 2000, randomBytes(32), [root.hash], { alice: 2 })
    const tip = createDAGNode('alice', 3, 3000, randomBytes(32), [mid.hash], { alice: 3 })
    dag.addNode(root)
    dag.addNode(mid)
    dag.addNode(tip)

    const visited: string[] = []
    const count = dag.walkAncestry(tip.hash, (node) => {
      visited.push(node.hash)
    })
    expect(count).toBe(3)
    expect(visited).toContain(root.hash)
    expect(visited).toContain(mid.hash)
    expect(visited).toContain(tip.hash)
  })

  it('walkAncestry respects maxDepth', () => {
    const dag = new MerkleDAG()
    const root = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    const mid = createDAGNode('alice', 2, 2000, randomBytes(32), [root.hash], { alice: 2 })
    const tip = createDAGNode('alice', 3, 3000, randomBytes(32), [mid.hash], { alice: 3 })
    dag.addNode(root)
    dag.addNode(mid)
    dag.addNode(tip)

    const count = dag.walkAncestry(tip.hash, () => {}, 1)
    expect(count).toBe(2)
  })

  it('walkAncestry prunes when visitor returns false', () => {
    const dag = new MerkleDAG()
    const root = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    const mid = createDAGNode('alice', 2, 2000, randomBytes(32), [root.hash], { alice: 2 })
    const tip = createDAGNode('alice', 3, 3000, randomBytes(32), [mid.hash], { alice: 3 })
    dag.addNode(root)
    dag.addNode(mid)
    dag.addNode(tip)

    const visited: string[] = []
    dag.walkAncestry(tip.hash, (node) => {
      visited.push(node.hash)
      if (node.hash === mid.hash) return false
    })
    expect(visited).not.toContain(root.hash)
  })

  it('findLCA returns the lowest common ancestor', () => {
    const dag = new MerkleDAG()
    const root = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    const a2 = createDAGNode('alice', 2, 2000, randomBytes(32), [root.hash], { alice: 2 })
    const b2 = createDAGNode('bob', 1, 2000, randomBytes(32), [root.hash], { bob: 1 })
    dag.addNode(root)
    dag.addNode(a2)
    dag.addNode(b2)

    expect(dag.findLCA(a2.hash, b2.hash)).toBe(root.hash)
  })

  it('findLCA returns undefined for disjoint histories', () => {
    const dag = new MerkleDAG()
    const a = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    const b = createDAGNode('bob', 1, 1000, randomBytes(32), [], { bob: 1 })
    dag.addNode(a)
    dag.addNode(b)
    expect(dag.findLCA(a.hash, b.hash)).toBeUndefined()
  })

  it('reconcile detects new nodes and divergent authors', () => {
    const local = new MerkleDAG()
    const remote = new MerkleDAG()

    const root = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    local.addNode(root)
    remote.addNode(root)

    const remoteOnly = createDAGNode('bob', 1, 2000, randomBytes(32), [], { bob: 1 })
    remote.addNode(remoteOnly)

    const result = local.reconcile(remote)
    expect(result.newNodes.length).toBe(1)
    expect(result.newNodes[0].hash).toBe(remoteOnly.hash)
  })

  it('encode and decode round-trip preserves nodes', () => {
    const dag = new MerkleDAG()
    const a = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    const b = createDAGNode('bob', 1, 2000, randomBytes(32), [a.hash], { alice: 1, bob: 1 })
    dag.addNode(a)
    dag.addNode(b)

    const encoded = dag.encode()
    const decoded = MerkleDAG.decode(encoded)

    expect(decoded.size).toBe(2)
    expect(decoded.getNode(a.hash)?.author).toBe('alice')
    expect(decoded.getNode(b.hash)?.author).toBe('bob')
  })

  it('is known works correctly', () => {
    const dag = new MerkleDAG()
    const node = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    dag.addNode(node)
    expect(dag.isKnown(node.hash)).toBe(true)
    expect(dag.isKnown('nope')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'

import { createDAGNode, MerkleDAG } from './merkleDAG'
import { ByzantineHealer } from './byzantineHealer'

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

function makeChain(
  author: string,
  count: number,
  startClock = 1,
): ReturnType<typeof createDAGNode>[] {
  const nodes: ReturnType<typeof createDAGNode>[] = []
  let prevHash = ''
  for (let i = 0; i < count; i++) {
    const seq = startClock + i
    const clock: Record<string, number> = { [author]: seq }
    const node = createDAGNode(author, seq, Date.now() + i * 1000, randomBytes(32), prevHash ? [prevHash] : [], clock)
    nodes.push(node)
    prevHash = node.hash
  }
  return nodes
}

describe('ByzantineHealer', () => {
  it('accepts a valid chain of nodes', () => {
    const healer = new ByzantineHealer()
    const dag = new MerkleDAG()
    const chain = makeChain('alice', 3)
    for (const node of chain) dag.addNode(node)

    const result = healer.heal(dag, [])
    expect(result.rejected.length).toBe(0)
    expect(result.accepted.length).toBe(3)
    expect(result.quarantined.length).toBe(0)
  })

  it('detects and quarantines a node with a tampered hash', () => {
    const healer = new ByzantineHealer()
    const dag = new MerkleDAG()
    const chain = makeChain('alice', 2)
    for (const node of chain) dag.addNode(node)

    // Create a node with a bad hash.
    const badNode = createDAGNode('bob', 1, Date.now(), randomBytes(32), [], { bob: 1 })
    const tampered = { ...badNode, seq: 999 } // hash won't match
    dag.addNode(tampered)

    const result = healer.heal(dag, [])
    expect(result.rejected.some((n) => n.hash === tampered.hash)).toBe(true)
    expect(result.quarantined.some((q) => q.reason === 'hash-tamper')).toBe(true)
  })

  it('quarantines a subtree when a parent is tampered', () => {
    const healer = new ByzantineHealer()
    const dag = new MerkleDAG()

    const root = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    const child = createDAGNode('alice', 2, 2000, randomBytes(32), [root.hash], { alice: 2 })
    dag.addNode(root)
    dag.addNode(child)

    // Quarantine the root.
    const affected = healer.quarantineSubtree(dag, root.hash, 'hash-tamper')
    expect(affected).toContain(root.hash)
    expect(affected).toContain(child.hash)
    expect(healer.isQuarantined(root.hash)).toBe(true)
    expect(healer.isQuarantined(child.hash)).toBe(true)
  })

  it('skip already quarantined nodes during heal', () => {
    const healer = new ByzantineHealer()
    const dag = new MerkleDAG()
    const chain = makeChain('alice', 2)
    for (const node of chain) dag.addNode(node)

    // Pre-quarantine the first node.
    healer.quarantineSubtree(dag, chain[0].hash, 'hash-tamper')

    const result = healer.heal(dag, [])
    expect(result.rejected.length).toBeGreaterThanOrEqual(1)
  })

  it('checkClockRewind detects clock-rewind attacks', () => {
    const healer = new ByzantineHealer()
    const dag = new MerkleDAG()

    const node = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1, bob: 5 })
    dag.addNode(node)

    // Local knows bob is at seq 10.
    const localHeadSeqs = new Map([['bob', 10]])
    const records = healer.checkClockRewind(dag, localHeadSeqs)
    expect(records.length).toBe(1)
    expect(records[0].reason).toBe('clock-rewind')
  })

  it('returns records of all quarantines', () => {
    const healer = new ByzantineHealer()
    const dag = new MerkleDAG()

    const a = createDAGNode('alice', 1, 1000, randomBytes(32), [], { alice: 1 })
    const b = createDAGNode('bob', 1, 2000, randomBytes(32), [], { bob: 1 })
    dag.addNode(a)
    dag.addNode(b)

    healer.quarantineSubtree(dag, a.hash, 'long-range-attack')
    healer.quarantineSubtree(dag, b.hash, 'clock-rewind')

    expect(healer.records.length).toBe(2)
    expect(healer.quarantined.length).toBe(2)
  })
})

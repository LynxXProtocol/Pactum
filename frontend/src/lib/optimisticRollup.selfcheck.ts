import assert from 'node:assert/strict'
import {
  OptimisticRollupEngine,
  applyMicroCommitment,
  encodeMicroCommitment,
  leafHashForCommitment,
  verifyMerkleProof,
  MerkleAccumulator,
  type MicroCommitment,
} from './optimisticRollup.ts'

{
  const acc = new MerkleAccumulator()
  acc.appendCommitment(new TextEncoder().encode('a'))
  acc.appendCommitment(new TextEncoder().encode('b'))
  const root = acc.getRoot()
  assert.ok(root)
  const a2 = acc.getLeaf(0)!
  const b2 = acc.getLeaf(1)!
  assert.equal(verifyMerkleProof(a2.leafHash, a2.proof, root!), true)
  assert.equal(verifyMerkleProof(b2.leafHash, b2.proof, root!), true)
}

{
  let sealed = 0
  const engine = new OptimisticRollupEngine({
    maxBatchSize: 2,
    batchTtlMs: 60_000,
    challengeWindowMs: 60_000,
    submitBatchRoot: async () => {
      sealed += 1
      return `tx-${sealed}`
    },
  })

  const base = {
    issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    counterparty: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    termsHash: '0x' + '11'.repeat(32),
    dueAt: 1_700_000_000,
    createdAt: 1_700_000_000,
  }

  const r0 = await engine.enqueue(base)
  assert.ok(r0)
  assert.equal(r0!.status, 'PendingRollup')
  assert.equal(engine.getState().pendingCount, 1)

  await engine.enqueue({ ...base, sequenceId: 2, termsHash: '0x' + '22'.repeat(32) })
  assert.equal(engine.getState().nextSequenceId, 1)

  const r1 = await engine.enqueue({ ...base, termsHash: '0x' + '33'.repeat(32) })
  assert.ok(r1)
  assert.equal(sealed, 1)
  assert.equal(engine.getFinalized().length >= 2, true)
}

{
  const c: MicroCommitment = {
    sequenceId: 0,
    issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    counterparty: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    termsHash: '0x' + 'aa'.repeat(32),
    dueAt: 1,
    createdAt: 1,
  }
  const leafHex = leafHashForCommitment(c)
  assert.match(leafHex, /^0x[0-9a-f]{64}$/)
  assert.ok(encodeMicroCommitment(c).length > 0)

  const acc = new MerkleAccumulator()
  const leaf = acc.appendLeafHash(leafHex)
  const state0 = {
    nextSequenceId: 0,
    openBatchSequence: 1,
    lastAcceptedBatchSequence: 0,
    lastAcceptedRoot: null,
    openRoot: null,
    pendingCount: 0,
    records: [],
    sealedBatches: [],
  }
  const next = applyMicroCommitment(state0, c, leaf, 1000, 5000)
  assert.equal(next.nextSequenceId, 1)
  assert.equal(next.records[0]!.status, 'PendingRollup')
  assert.equal(next.records[0]!.challengeDeadline, 6000)
}

console.log('optimisticRollup.selfcheck: ok')

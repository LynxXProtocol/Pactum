import assert from 'node:assert/strict'
import { QueryClient } from '@tanstack/react-query'
import { OptimisticConflictEngine } from './optimisticEngine.ts'

const key = ['proposal', 'p1']
const otherKey = ['proposal', 'p2']

function freshEngine() {
  const qc = new QueryClient()
  qc.setQueryData(key, { votes: 10 })
  qc.setQueryData(otherKey, { votes: 5 })
  return { qc, engine: new OptimisticConflictEngine(qc) }
}

// Own mutation confirmed by matching chain event: optimistic value is replaced, no conflict.
{
  const { qc, engine } = freshEngine()
  engine.beginMutation('m1', key, 10, 'alice', { votes: 11 })
  engine.handleChainEvent({ queryKey: key, version: 11, actorId: 'alice', data: { votes: 11, confirmed: true } })
  assert.deepEqual(qc.getQueryData(key), { votes: 11, confirmed: true })
  assert.equal(engine.getConflict(key), undefined)
}

// Someone else's event lands while our mutation is inflight: rollback only this slice + flag conflict.
{
  const { qc, engine } = freshEngine()
  engine.beginMutation('m2', key, 10, 'alice', { votes: 11 })
  engine.handleChainEvent({ queryKey: otherKey, version: 6, actorId: 'bob', data: { votes: 6 } })
  assert.deepEqual(qc.getQueryData(key), { votes: 11 }, 'unrelated event must not touch our slice')

  engine.handleChainEvent({ queryKey: key, version: 11, actorId: 'bob', data: { votes: 11, byBob: true } })
  assert.deepEqual(qc.getQueryData(key), { votes: 11, byBob: true }, 'conflicting slice rolls back to chain truth')
  assert.deepEqual(qc.getQueryData(otherKey), { votes: 6 }, 'other slices stay untouched')
  assert.ok(engine.getConflict(key), 'conflict must be flagged')
  engine.clearConflict(key)
  assert.equal(engine.getConflict(key), undefined)
}

// Mutation errors out client-side: rollback to previous data, no conflict.
{
  const { qc, engine } = freshEngine()
  engine.beginMutation('m3', key, 10, 'alice', { votes: 11 })
  engine.settleMutation('m3', 'error')
  assert.deepEqual(qc.getQueryData(key), { votes: 10 })
  assert.equal(engine.getConflict(key), undefined)
}

console.log('optimisticEngine.selfcheck: ok')

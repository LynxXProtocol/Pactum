import React, { useMemo, useState } from 'react'
import { Layers, CheckCircle2, Clock, AlertTriangle, Hash } from 'lucide-react'
import { useOptimisticRollup } from '../hooks/useOptimisticRollup'
import type { RollupCommitmentRecord } from '../lib/optimisticRollup'

function shorten(hex: string, n = 6): string {
  if (hex.length <= n * 2 + 2) return hex
  return `${hex.slice(0, n + 2)}…${hex.slice(-n)}`
}

function statusLabel(status: RollupCommitmentRecord['status']): string {
  switch (status) {
    case 'PendingRollup':
      return 'Pending rollup'
    case 'OnChainFinalized':
      return 'On-chain finalized'
    case 'ForceIncludePending':
      return 'Force-include pending'
    case 'ForceIncluded':
      return 'Force-included'
    case 'Buffered':
      return 'Buffered'
    default:
      return status
  }
}

function statusClass(status: RollupCommitmentRecord['status']): string {
  switch (status) {
    case 'OnChainFinalized':
    case 'ForceIncluded':
      return 'rollup-badge finalized'
    case 'ForceIncludePending':
      return 'rollup-badge force'
    case 'PendingRollup':
      return 'rollup-badge pending'
    default:
      return 'rollup-badge'
  }
}

/**
 * Shows the live optimistic-rollup queue: open batch size, root, ETA, and
 * per-commitment PendingRollup vs OnChainFinalized (plus forced-inclusion).
 */
export const RollupStatusPanel: React.FC<{ demoMode?: boolean }> = ({ demoMode = true }) => {
  const [seeded, setSeeded] = useState(false)
  const { state, pending, finalized, enqueue, tick } = useOptimisticRollup(
    demoMode
      ? {
          maxBatchSize: 8,
          batchTtlMs: 12_000,
          challengeWindowMs: 30_000,
          submitBatchRoot: async (batch) => `demo-batch-${batch.batchSequence}`,
          forceInclude: async (record) => `demo-force-${record.commitment.sequenceId}`,
        }
      : { maxBatchSize: 64, batchTtlMs: 15_000, challengeWindowMs: 60_000 },
    1_000,
  )

  const etaMs = useMemo(() => {
    if (pending.length === 0) return null
    const oldest = Math.min(...pending.map((r) => r.enqueuedAt))
    const remaining = Math.max(0, 12_000 - (Date.now() - oldest))
    return remaining
  }, [pending])

  const seedDemo = () => {
    const now = Math.floor(Date.now() / 1000)
    void (async () => {
      for (let i = 0; i < 3; i++) {
        await enqueue({
          issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          counterparty: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          termsHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
          dueAt: now + 86400,
          createdAt: now,
        })
      }
      setSeeded(true)
    })()
  }

  return (
    <div className="rollup-panel card" style={{ marginBottom: 16 }}>
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Layers size={18} />
        <div className="card-title">Optimistic Rollup</div>
        <span className="rollup-meta">batch #{state.openBatchSequence}</span>
      </div>
      <div className="card-body">
        <div className="rollup-stats">
          <div className="rollup-stat">
            <Clock size={14} />
            <span>
              Pending: <strong>{pending.length}</strong>
              {etaMs !== null ? ` · seal in ~${Math.ceil(etaMs / 1000)}s` : ''}
            </span>
          </div>
          <div className="rollup-stat">
            <CheckCircle2 size={14} />
            <span>
              Finalized: <strong>{finalized.length}</strong>
            </span>
          </div>
          <div className="rollup-stat">
            <Hash size={14} />
            <span title={state.openRoot ?? undefined}>
              Open root: <code>{state.openRoot ? shorten(state.openRoot) : '—'}</code>
            </span>
          </div>
          <div className="rollup-stat">
            <Hash size={14} />
            <span title={state.lastAcceptedRoot ?? undefined}>
              On-chain root: <code>{state.lastAcceptedRoot ? shorten(state.lastAcceptedRoot) : '—'}</code>
            </span>
          </div>
        </div>

        {demoMode && (
          <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
            <button className="btn btn-secondary" type="button" onClick={seedDemo}>
              {seeded ? 'Enqueue more micro-commitments' : 'Enqueue demo micro-commitments'}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => void tick()}>
              Tick seal / challenge
            </button>
          </div>
        )}

        <div className="rollup-list">
          {[...pending, ...finalized].slice(-12).reverse().map((r) => (
            <div key={r.commitment.sequenceId} className="rollup-row">
              <span className={statusClass(r.status)}>
                {r.status === 'ForceIncludePending' ? <AlertTriangle size={12} /> : null}
                {statusLabel(r.status)}
              </span>
              <span className="rollup-seq">#{r.commitment.sequenceId}</span>
              <code className="rollup-leaf" title={r.leafHash}>
                {shorten(r.leafHash)}
              </code>
              {r.onChainTxId ? (
                <span className="rollup-tx" title={r.onChainTxId}>
                  tx {shorten(r.onChainTxId, 4)}
                </span>
              ) : null}
              {r.forceIncludeTxId ? (
                <span className="rollup-tx force" title={r.forceIncludeTxId}>
                  force {shorten(r.forceIncludeTxId, 4)}
                </span>
              ) : null}
            </div>
          ))}
          {pending.length === 0 && finalized.length === 0 ? (
            <div className="rollup-empty">No micro-commitments in the rollup queue yet.</div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default RollupStatusPanel

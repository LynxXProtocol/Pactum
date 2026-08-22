import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  OptimisticRollupEngine,
  type OptimisticRollupConfig,
  type OptimisticRollupState,
  type RollupCommitmentRecord,
  type RollupEngineEvent,
} from '../lib/optimisticRollup'

export interface UseOptimisticRollupResult {
  state: OptimisticRollupState
  pending: RollupCommitmentRecord[]
  finalized: RollupCommitmentRecord[]
  enqueue: OptimisticRollupEngine['enqueue']
  tick: () => Promise<void>
  markBatchFinalized: (batchSequence: number, txId: string) => void
  engine: OptimisticRollupEngine
  lastEvent: RollupEngineEvent | null
}

/**
 * React binding for the optimistic rollup engine.
 * Subscribes to engine events and polls TTL / challenge windows on an interval.
 */
export function useOptimisticRollup(
  config: OptimisticRollupConfig = {},
  pollIntervalMs = 1_000,
): UseOptimisticRollupResult {
  const engineRef = useRef<OptimisticRollupEngine | null>(null)
  if (!engineRef.current) {
    engineRef.current = new OptimisticRollupEngine(config)
  }
  const engine = engineRef.current

  const lastEventRef = useRef<RollupEngineEvent | null>(null)
  const versionRef = useRef(0)
  const listenersRef = useRef(new Set<() => void>())

  useEffect(() => {
    return engine.subscribe((event) => {
      lastEventRef.current = event
      versionRef.current += 1
      for (const l of listenersRef.current) l()
    })
  }, [engine])

  useEffect(() => {
    const id = setInterval(() => {
      void engine.tick()
    }, pollIntervalMs)
    return () => clearInterval(id)
  }, [engine, pollIntervalMs])

  const subscribe = useCallback((onStoreChange: () => void) => {
    listenersRef.current.add(onStoreChange)
    return () => listenersRef.current.delete(onStoreChange)
  }, [])

  const getSnapshot = useCallback(() => versionRef.current, [])
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const state = engine.getState()
  const pending = useMemo(() => engine.getPendingRollup(), [state])
  const finalized = useMemo(() => engine.getFinalized(), [state])

  return {
    state,
    pending,
    finalized,
    enqueue: engine.enqueue.bind(engine),
    tick: () => engine.tick(),
    markBatchFinalized: engine.markBatchFinalized.bind(engine),
    engine,
    lastEvent: lastEventRef.current,
  }
}

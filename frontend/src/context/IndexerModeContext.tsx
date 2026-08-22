import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { indexerWorkerClient } from '../lib/indexerWorkerClient';
import { queryClient } from '../lib/queryClient';
import { commitmentKeys } from '../lib/queryKeys';
import {
  DEFAULT_CONTRACT_ID,
  DEFAULT_NETWORK_PASSPHRASE,
  DEFAULT_SOROBAN_RPC_URL,
} from '../lib/soroban';
import type { IndexerWorkerStatus } from '../workers/indexer.worker.ts';

export type IndexerMode = 'cloud' | 'local';
export type IndexerSyncState = 'idle' | 'syncing' | 'synced' | 'error';

interface IndexerModeContextValue {
  mode: IndexerMode;
  setMode: (mode: IndexerMode) => void;
  syncState: IndexerSyncState;
  lastPolledAt: number | null;
  lastError: string | null;
  /** True once a poll has had to reset its start point because RPC no longer retains the previous cursor's history. */
  retentionGapDetected: boolean;
}

const IndexerModeContext = createContext<IndexerModeContextValue | null>(null);
const STORAGE_KEY = 'pactum-indexer-mode';

const POLL_INTERVAL_MS = Number(import.meta.env.VITE_LOCAL_INDEXER_POLL_INTERVAL_MS) || 15_000;
// ~1 day of Soroban ledgers at ~5s/ledger — how far back a freshly-enabled Local Indexer looks
// when it has no stored cursor yet. Bounded by whatever the RPC provider actually retains.
const LOOKBACK_LEDGERS = Number(import.meta.env.VITE_LOCAL_INDEXER_LOOKBACK_LEDGERS) || 17_280;

function loadPersistedMode(): IndexerMode {
  if (typeof localStorage === 'undefined') return 'cloud';
  return localStorage.getItem(STORAGE_KEY) === 'local' ? 'local' : 'cloud';
}

export function IndexerModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<IndexerMode>(loadPersistedMode);
  const [syncState, setSyncState] = useState<IndexerSyncState>('idle');
  const [lastPolledAt, setLastPolledAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [retentionGapDetected, setRetentionGapDetected] = useState(false);

  useEffect(
    () =>
      indexerWorkerClient.onStatus((status: IndexerWorkerStatus) => {
        if (status.state === 'syncing') {
          setSyncState('syncing');
        } else if (status.state === 'synced') {
          setSyncState('synced');
          setLastPolledAt(status.lastPolledAt);
          setLastError(null);
          setRetentionGapDetected(status.retentionGapDetected);
          // The worker writes straight to IndexedDB, invisible to TanStack Query's cache — without
          // this, a local-mode query that resolved empty (or stale) before this poll landed would
          // never re-read the store on its own.
          if (status.changed) {
            void queryClient.invalidateQueries({ queryKey: commitmentKeys.localAll });
          }
        } else {
          setSyncState('error');
          setLastError(status.error);
        }
      }),
    [],
  );

  useEffect(() => {
    if (mode !== 'local') {
      indexerWorkerClient.stop();
      setSyncState('idle');
      return;
    }

    setSyncState('syncing');
    indexerWorkerClient.start({
      rpcUrl: import.meta.env.VITE_SOROBAN_RPC_URL || DEFAULT_SOROBAN_RPC_URL,
      contractId: import.meta.env.VITE_PACTUM_CONTRACT_ID || DEFAULT_CONTRACT_ID,
      networkPassphrase:
        import.meta.env.VITE_STELLAR_NETWORK_PASSPHRASE || DEFAULT_NETWORK_PASSPHRASE,
      pollIntervalMs: POLL_INTERVAL_MS,
      lookbackLedgers: LOOKBACK_LEDGERS,
    });

    return () => indexerWorkerClient.stop();
  }, [mode]);

  const setMode = (next: IndexerMode) => {
    if (next === 'cloud') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
    setModeState(next);
  };

  const value = useMemo(
    () => ({ mode, setMode, syncState, lastPolledAt, lastError, retentionGapDetected }),
    [mode, syncState, lastPolledAt, lastError, retentionGapDetected],
  );

  return <IndexerModeContext.Provider value={value}>{children}</IndexerModeContext.Provider>;
}

export function useIndexerMode() {
  const context = useContext(IndexerModeContext);
  if (!context) throw new Error('useIndexerMode must be used inside IndexerModeProvider');
  return context;
}

const STATUS_LABEL: Record<IndexerSyncState, string> = {
  idle: 'Starting…',
  syncing: 'Syncing…',
  synced: 'Synced',
  error: 'Error',
};

export function IndexerModeToggle() {
  const { mode, setMode, syncState, retentionGapDetected } = useIndexerMode();

  return (
    <div className="indexer-mode-toggle">
      <label
        className="indexer-mode-toggle-label"
        title="Local Indexer polls Soroban RPC directly from this browser and bypasses the backend entirely. Coverage is bounded by the RPC provider's event retention window — switch back to Cloud Indexer for full history."
      >
        <span className="sr-only">Commitment data source</span>
        <select value={mode} onChange={(event) => setMode(event.target.value as IndexerMode)}>
          <option value="cloud">Cloud Indexer</option>
          <option value="local">Local Indexer (browser-only)</option>
        </select>
      </label>
      {mode === 'local' && (
        <span className={`indexer-mode-status indexer-mode-status--${syncState}`}>
          {STATUS_LABEL[syncState]}
          {syncState === 'synced' && retentionGapDetected ? ' (partial history)' : ''}
        </span>
      )}
    </div>
  );
}

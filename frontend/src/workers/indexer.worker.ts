/// <reference lib="webworker" />

import { pollOnce, type LocalIndexerRpcClient } from '../lib/localIndexer/poller';
import { createSorobanIndexerRpcClient } from '../lib/localIndexer/rpcClient';

export interface IndexerWorkerConfig {
  rpcUrl: string;
  contractId: string;
  networkPassphrase: string;
  pollIntervalMs: number;
  lookbackLedgers: number;
}

export type IndexerWorkerRequest =
  { type: 'start'; config: IndexerWorkerConfig } | { type: 'stop' };

export type IndexerWorkerStatus =
  | { type: 'status'; state: 'syncing' }
  | {
      type: 'status';
      state: 'synced';
      lastPolledAt: number;
      changed: boolean;
      retentionGapDetected: boolean;
    }
  | { type: 'status'; state: 'error'; error: string };

let intervalId: ReturnType<typeof setInterval> | null = null;
let polling = false;

function stop(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

async function tick(client: LocalIndexerRpcClient, config: IndexerWorkerConfig): Promise<void> {
  // A poll that's still in flight when the next interval fires is skipped rather than
  // overlapped — RPC calls (especially the per-`created`-event `get_commitment` reads) can
  // occasionally outlast a short poll interval.
  if (polling) return;
  polling = true;

  self.postMessage({ type: 'status', state: 'syncing' } satisfies IndexerWorkerStatus);

  try {
    const result = await pollOnce(client, {
      contractId: config.contractId,
      lookbackLedgers: config.lookbackLedgers,
    });
    self.postMessage({
      type: 'status',
      state: 'synced',
      lastPolledAt: Date.now(),
      changed: result.eventsProcessed > 0,
      retentionGapDetected: result.retentionGapDetected,
    } satisfies IndexerWorkerStatus);
  } catch (err) {
    self.postMessage({
      type: 'status',
      state: 'error',
      error: err instanceof Error ? err.message : String(err),
    } satisfies IndexerWorkerStatus);
  } finally {
    polling = false;
  }
}

function start(config: IndexerWorkerConfig): void {
  stop();
  const client = createSorobanIndexerRpcClient(config);
  void tick(client, config);
  intervalId = setInterval(() => void tick(client, config), config.pollIntervalMs);
}

// Self message handler for Web Worker execution.
if (typeof self !== 'undefined' && typeof (self as any).postMessage === 'function') {
  self.onmessage = (event: MessageEvent<IndexerWorkerRequest>) => {
    if (event.data.type === 'start') start(event.data.config);
    else stop();
  };
}

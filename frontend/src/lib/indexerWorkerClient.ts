import type {
  IndexerWorkerConfig,
  IndexerWorkerRequest,
  IndexerWorkerStatus,
} from '../workers/indexer.worker.ts';

export type IndexerStatusListener = (status: IndexerWorkerStatus) => void;

/**
 * Main-thread wrapper around `indexer.worker.ts`, modeled on `cryptoWorkerClient.ts`'s
 * lazy-init/terminate shape. Unlike the crypto worker's request/response RPC, this one is
 * push-based: `start`/`stop` just toggle the worker's internal poll loop, and `onStatus`
 * subscribes to the stream of `{state: 'syncing' | 'synced' | 'error'}` messages it emits.
 */
export class IndexerWorkerClient {
  private worker: Worker | null = null;
  private listeners = new Set<IndexerStatusListener>();
  private isWorkerSupported = typeof window !== 'undefined' && typeof window.Worker !== 'undefined';
  private running = false;

  private ensureWorker(): Worker | null {
    if (this.worker || !this.isWorkerSupported) return this.worker;

    try {
      this.worker = new Worker(new URL('../workers/indexer.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (event: MessageEvent<IndexerWorkerStatus>) => {
        for (const listener of this.listeners) listener(event.data);
      };
      this.worker.onerror = (err) => {
        console.warn('[IndexerWorkerClient] Worker error, stopping local indexing.', err);
        this.stop();
        for (const listener of this.listeners) {
          listener({ type: 'status', state: 'error', error: 'Local Indexer worker crashed.' });
        }
      };
    } catch (err) {
      console.warn('[IndexerWorkerClient] Could not initialize worker.', err);
      this.worker = null;
    }

    return this.worker;
  }

  start(config: IndexerWorkerConfig): void {
    const worker = this.ensureWorker();
    if (!worker) {
      for (const listener of this.listeners) {
        listener({
          type: 'status',
          state: 'error',
          error: 'Web Workers are not supported in this browser.',
        });
      }
      return;
    }

    this.running = true;
    const request: IndexerWorkerRequest = { type: 'start', config };
    worker.postMessage(request);
  }

  stop(): void {
    this.running = false;
    if (!this.worker) return;
    const request: IndexerWorkerRequest = { type: 'stop' };
    this.worker.postMessage(request);
  }

  get isRunning(): boolean {
    return this.running;
  }

  onStatus(listener: IndexerStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {
    this.running = false;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.listeners.clear();
  }
}

export const indexerWorkerClient = new IndexerWorkerClient();

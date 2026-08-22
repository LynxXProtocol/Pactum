import { PactumBatchedStateProof, ScoreData } from '../schemas/stateProof';
import { StateProofGenerator } from './stateProofGenerator';
import { DurableProofQueue } from './durableQueue';

export const DEFAULT_MAX_BATCH_SIZE = 32;
export const DEFAULT_BATCH_TTL_MS = 10_000;

export interface ProofBatchEngineOptions {
  generator: StateProofGenerator;
  maxBatchSize?: number;
  batchTtlMs?: number;
  persistPath?: string;
  now?: () => number;
  onBatchReady?: (batch: PactumBatchedStateProof) => void | Promise<void>;
}

/**
 * Buffers commitment state proofs and flushes on whichever threshold trips first:
 * `maxBatchSize` (throughput) or `batchTtlMs` (latency bound).
 */
export class ProofBatchEngine {
  private generator: StateProofGenerator;
  private queue: DurableProofQueue;
  private maxBatchSize: number;
  private batchTtlMs: number;
  private now: () => number;
  private onBatchReady?: (batch: PactumBatchedStateProof) => void | Promise<void>;
  private flushing = false;
  private restored = false;

  constructor(options: ProofBatchEngineOptions) {
    this.generator = options.generator;
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE);
    this.batchTtlMs = Math.max(1, options.batchTtlMs ?? DEFAULT_BATCH_TTL_MS);
    this.now = options.now ?? Date.now;
    this.onBatchReady = options.onBatchReady;
    this.queue = new DurableProofQueue(options.persistPath);
  }

  public async restore(): Promise<void> {
    if (this.restored) return;
    await this.queue.restore();
    this.restored = true;
  }

  public size(): number {
    return this.queue.size();
  }

  public getMaxBatchSize(): number {
    return this.maxBatchSize;
  }

  public getBatchTtlMs(): number {
    return this.batchTtlMs;
  }

  /**
   * Buffer a state transition. Flushes immediately when the batch is full.
   */
  public async enqueue(stellarAddress: string, scoreData: ScoreData): Promise<PactumBatchedStateProof | null> {
    await this.restore();
    this.generator.setScoreData(stellarAddress, scoreData);
    await this.queue.enqueue(stellarAddress, scoreData, this.now());
    if (this.queue.size() >= this.maxBatchSize) {
      return this.flush();
    }
    return null;
  }

  public shouldFlush(now: number = this.now()): boolean {
    if (this.queue.size() === 0) return false;
    if (this.queue.size() >= this.maxBatchSize) return true;
    const oldest = this.queue.oldestEnqueuedAt();
    if (oldest === undefined) return false;
    return now - oldest >= this.batchTtlMs;
  }

  public async flushIfDue(): Promise<PactumBatchedStateProof | null> {
    await this.restore();
    if (!this.shouldFlush()) return null;
    return this.flush();
  }

  public async flush(): Promise<PactumBatchedStateProof | null> {
    if (this.flushing) return null;
    await this.restore();
    if (this.queue.size() === 0) return null;

    this.flushing = true;
    const items = await this.queue.drain();
    try {
      const batch = await this.generator.generateBatchProof(
        items.map((item) => ({
          stellarAddress: item.stellarAddress,
          scoreData: item.scoreData,
        }))
      );
      if (this.onBatchReady) {
        await this.onBatchReady(batch);
      }
      return batch;
    } catch (err) {
      await this.queue.replace(items);
      throw err;
    } finally {
      this.flushing = false;
    }
  }
}

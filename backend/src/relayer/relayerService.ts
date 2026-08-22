import { StateProofGenerator, ProofGeneratorConfig, TrustScoreEntryRecord } from './stateProofGenerator';
import { PactumBatchedStateProof, PactumStateProof, ScoreData } from '../schemas/stateProof';
import { DEFAULT_BATCH_TTL_MS, DEFAULT_MAX_BATCH_SIZE, ProofBatchEngine } from './proofBatchEngine';

export interface RelayerServiceOptions extends ProofGeneratorConfig {
  pollIntervalMs?: number;
  autoStart?: boolean;
  maxBatchSize?: number;
  batchTtlMs?: number;
  persistPath?: string;
  onBatchReady?: (batch: PactumBatchedStateProof) => void | Promise<void>;
}

export class RelayerService {
  private generator: StateProofGenerator;
  private proofCache: Map<string, PactumStateProof> = new Map();
  private pollIntervalMs: number;
  private isRunning: boolean = false;
  private intervalTimer?: NodeJS.Timeout;
  private batchEngine: ProofBatchEngine;
  private latestBatch: PactumBatchedStateProof | null = null;

  constructor(options: RelayerServiceOptions) {
    this.generator = new StateProofGenerator({
      rpcUrl: options.rpcUrl,
      contractId: options.contractId,
      networkPassphrase: options.networkPassphrase,
    });
    this.pollIntervalMs = options.pollIntervalMs || 1000;
    this.batchEngine = new ProofBatchEngine({
      generator: this.generator,
      maxBatchSize: options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      batchTtlMs: options.batchTtlMs ?? DEFAULT_BATCH_TTL_MS,
      persistPath: options.persistPath,
      onBatchReady: async (batch) => {
        this.latestBatch = batch;
        if (options.onBatchReady) {
          await options.onBatchReady(batch);
        }
      },
    });
    if (options.autoStart) {
      this.start();
    }
  }

  public getGenerator(): StateProofGenerator {
    return this.generator;
  }

  public getBatchEngine(): ProofBatchEngine {
    return this.batchEngine;
  }

  public getLatestBatch(): PactumBatchedStateProof | null {
    return this.latestBatch;
  }

  /**
   * Restores the durable in-flight buffer after a process restart.
   */
  public async restore(): Promise<void> {
    await this.batchEngine.restore();
  }

  /**
   * Registers or updates a score for an address in the relayer's tracked state
   * and buffers it into the aggregation pipeline (default path).
   */
  public updateScore(stellarAddress: string, scoreData: ScoreData): void {
    this.generator.setScoreData(stellarAddress, scoreData);
    this.proofCache.delete(stellarAddress);
    void this.batchEngine.enqueue(stellarAddress, scoreData).catch((err) => {
      console.error('[RelayerService] Failed to enqueue proof for aggregation:', err);
    });
  }

  /**
   * Buffers a score and returns a batch proof if MAX_BATCH_SIZE was reached.
   */
  public async bufferScore(
    stellarAddress: string,
    scoreData: ScoreData
  ): Promise<PactumBatchedStateProof | null> {
    this.proofCache.delete(stellarAddress);
    return this.batchEngine.enqueue(stellarAddress, scoreData);
  }

  /**
   * Generates and returns a zero-trust state proof for the requested Stellar address.
   * Immediate-finality path — does not wait for the aggregation buffer.
   */
  public async getProofForAddress(
    stellarAddress: string,
    options?: {
      targetLedgerSeq?: number;
      allEntries?: TrustScoreEntryRecord[];
    }
  ): Promise<PactumStateProof> {
    const proof = await this.generator.generateProof(stellarAddress, options);
    this.proofCache.set(stellarAddress, proof);
    return proof;
  }

  /**
   * Builds a unified batched proof over the given addresses (or all locally tracked scores).
   */
  public async getBatchProof(
    addresses?: string[],
    options?: { targetLedgerSeq?: number }
  ): Promise<PactumBatchedStateProof> {
    const targets = addresses && addresses.length > 0
      ? addresses
      : this.generator.getTrackedAddresses();
    const batch = await this.generator.generateBatchProof(targets, options);
    this.latestBatch = batch;
    return batch;
  }

  public async flushBatch(): Promise<PactumBatchedStateProof | null> {
    return this.batchEngine.flush();
  }

  /**
   * Starts the background relayer loop (proof refresh + batch TTL polling).
   */
  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    void this.batchEngine.restore();
    console.log(
      `[RelayerService] Started poll=${this.pollIntervalMs}ms maxBatch=${this.batchEngine.getMaxBatchSize()} ttl=${this.batchEngine.getBatchTtlMs()}ms`
    );

    this.intervalTimer = setInterval(async () => {
      try {
        await this.syncTrackedAddresses();
        await this.batchEngine.flushIfDue();
      } catch (err) {
        console.error('[RelayerService] Error during sync:', err);
      }
    }, this.pollIntervalMs);
  }

  /**
   * Stops the background relayer service.
   */
  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
    }
    console.log('[RelayerService] Stopped');
  }

  public async shutdown(): Promise<void> {
    try {
      await this.flushBatch();
    } catch (err) {
      console.error('[RelayerService] Error flushing batch on shutdown:', err);
    } finally {
      this.stop();
    }
  }

  private async syncTrackedAddresses(): Promise<void> {
    for (const address of this.proofCache.keys()) {
      try {
        const freshProof = await this.generator.generateProof(address);
        this.proofCache.set(address, freshProof);
      } catch (err) {
        console.warn(`[RelayerService] Failed to refresh proof for ${address}:`, err);
      }
    }
  }
}

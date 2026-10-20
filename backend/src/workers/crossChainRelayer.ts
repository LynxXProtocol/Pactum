import { ethers } from 'ethers';

export interface SorobanTrustScoreSnapshot {
  score: number;
  fulfilledCount: number;
  lateCount: number;
  breachedCount: number;
  sourceLedgerSeq: bigint;
}

export interface ISorobanClient {
  getTrustScoreSnapshot(address: string): Promise<SorobanTrustScoreSnapshot | null>;
}

export interface TrustScoreEntry {
  stellarAddress: string; // 32-byte hex (bytes32)
  score: bigint;
  fulfilledCount: number;
  lateCount: number;
  breachedCount: number;
  sourceLedgerSeq: bigint;
}

export interface TrustScoreBatch {
  version: number;
  registryId: string; // bytes32
  batchNonce: bigint;
  batchTimestamp: bigint;
  entries: TrustScoreEntry[];
}

export interface IBatchStore {
  saveBatch(batch: TrustScoreBatch): Promise<void>;
  getBatch(batchNonce: bigint): Promise<TrustScoreBatch | null>;
  deleteBatch(batchNonce: bigint): Promise<void>;
}

export class MemoryBatchStore implements IBatchStore {
  private store: Map<string, TrustScoreBatch> = new Map();

  async saveBatch(batch: TrustScoreBatch): Promise<void> {
    this.store.set(batch.batchNonce.toString(), batch);
  }

  async getBatch(batchNonce: bigint): Promise<TrustScoreBatch | null> {
    return this.store.get(batchNonce.toString()) || null;
  }

  async deleteBatch(batchNonce: bigint): Promise<void> {
    this.store.delete(batchNonce.toString());
  }
}

export interface RelayerConfig {
  registryId: string;
  oracleContractAddress: string;
  sourceChainId: number;
  pollIntervalMs?: number;
  overrideSigningKey?: string;
  batchStore?: IBatchStore;
}

export class CrossChainRelayer {
  private sorobanClient: ISorobanClient;
  private oracleContract: ethers.Contract;
  private signer: ethers.Signer;
  private registryId: string;
  private currentNonce: bigint = 0n;
  private isRunning: boolean = false;
  private batchStore: IBatchStore;

  constructor(
    sorobanClient: ISorobanClient,
    oracleContract: ethers.Contract,
    signer: ethers.Signer,
    config: RelayerConfig,
  ) {
    this.sorobanClient = sorobanClient;
    this.oracleContract = oracleContract;
    this.signer = signer;
    this.registryId = config.registryId;
    this.batchStore = config.batchStore || new MemoryBatchStore();
  }

  /**
   * Encodes a TrustScoreBatch to ABI bytes format matching PactumZeroTrustOracle.
   */
  public encodeBatch(batch: TrustScoreBatch): string {
    const tupleType =
      'tuple(uint8 version, bytes32 registryId, uint64 batchNonce, uint64 batchTimestamp, ' +
      'tuple(bytes32 stellarAddress, int64 score, uint32 fulfilledCount, uint32 lateCount, uint32 breachedCount, uint64 sourceLedgerSeq)[] entries)';

    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    return abiCoder.encode([tupleType], [batch]);
  }

  /**
   * Creates and submits a new state batch to the zero-trust oracle.
   */
  public async submitBatch(entries: TrustScoreEntry[]): Promise<string> {
    if (this.currentNonce === 0n) {
      try {
        const onChainNonce = await this.oracleContract.lastProposedBatchNonce();
        this.currentNonce = BigInt(onChainNonce);
      } catch {
        // Fallback to local tracking if view fails
      }
    }

    this.currentNonce += 1n;
    const batchNonce = this.currentNonce;
    const now = BigInt(Math.floor(Date.now() / 1000));

    const batch: TrustScoreBatch = {
      version: 1,
      registryId: this.registryId,
      batchNonce,
      batchTimestamp: now,
      entries,
    };

    const encoded = this.encodeBatch(batch);
    await this.batchStore.saveBatch(batch);

    let tx: any;
    try {
      tx = await this.oracleContract.proposeBatch(encoded);
    } catch (broadcastError) {
      // Broadcast failed before transaction was dispatched to network
      await this.batchStore.deleteBatch(batchNonce);
      this.currentNonce -= 1n;
      throw broadcastError;
    }

    try {
      const receipt = await tx.wait();
      if (receipt && receipt.status === 0) {
        // Transaction mined but reverted on-chain
        await this.batchStore.deleteBatch(batchNonce);
        this.currentNonce -= 1n;
        throw new Error(`proposeBatch transaction reverted: ${receipt.hash}`);
      }
      return receipt ? receipt.hash : tx.hash;
    } catch (waitError) {
      // Post-broadcast confirmation error: retain persisted payload in store
      // so recovery remains possible if the transaction was included in a block.
      console.warn(
        `[Relayer] Confirmation error for batch ${batchNonce}, retaining persisted payload:`,
        waitError,
      );
      throw waitError;
    }
  }

  /**
   * Generates a cryptographic state proof for an override resolution.
   */
  public async generateOverrideProof(batchNonce: bigint, stateRoot: string): Promise<string> {
    const messageHash = ethers.solidityPackedKeccak256(
      ['bytes32', 'uint64', 'bytes32'],
      [this.registryId, batchNonce, stateRoot],
    );

    const signature = await this.signer.signMessage(ethers.getBytes(messageHash));
    return signature;
  }

  /**
   * Automatically detects and handles a challenge on a proposed batch.
   */
  public async handleChallengedBatch(
    batchNonce: bigint,
    challenger: string,
    fraudProof: string,
  ): Promise<{ resolved: boolean; txHash?: string }> {
    console.log(`[Relayer] Detected challenge on batch ${batchNonce} from ${challenger}`);

    const batch = await this.batchStore.getBatch(batchNonce);
    if (!batch) {
      console.error(
        `[Relayer] Batch ${batchNonce} not found in store/cache. Cannot build an override payload.`,
      );
      return { resolved: false };
    }

    // Verify source state against Soroban canonical ledger
    const isSourceStateValid = await this.verifySorobanCanonicalState(batch);

    if (isSourceStateValid) {
      // Relayer's state is valid -> Generate override proof to vindicate relayer and slash challenger
      const payload = this.encodeBatch(batch);
      const stateRoot = ethers.keccak256(payload);
      const overrideProof = await this.generateOverrideProof(batchNonce, stateRoot);

      console.log(
        `[Relayer] Submitting override proof to resolve challenge on batch ${batchNonce}...`,
      );
      const tx = await this.oracleContract.resolveChallengeWithOverride(
        batchNonce,
        overrideProof,
        payload,
      );
      const receipt = await tx.wait();
      await this.batchStore.deleteBatch(batchNonce);
      return { resolved: true, txHash: receipt ? receipt.hash : tx.hash };
    } else {
      // Reorg or dropped packet occurred -> Recover by querying fresh Soroban state and submitting corrected payload
      console.log(
        `[Relayer] State mismatch detected (reorg/packet drop). Initiating automated fault recovery...`,
      );
      const correctedEntries = await this.fetchAuthoritativeState(batch.entries);
      if (!correctedEntries || correctedEntries.length !== batch.entries.length) {
        console.error(
          `[Relayer] Incomplete or unavailable authoritative state during recovery for batch ${batchNonce}.`,
        );
        return { resolved: false };
      }

      const correctedBatch: TrustScoreBatch = {
        version: 1,
        registryId: this.registryId,
        batchNonce: batchNonce,
        batchTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        entries: correctedEntries,
      };

      const correctedPayload = this.encodeBatch(correctedBatch);
      const stateRoot = ethers.keccak256(correctedPayload);
      const overrideProof = await this.generateOverrideProof(batchNonce, stateRoot);

      const tx = await this.oracleContract.resolveChallengeWithOverride(
        batchNonce,
        overrideProof,
        correctedPayload,
      );
      const receipt = await tx.wait();
      await this.batchStore.deleteBatch(batchNonce);
      return { resolved: true, txHash: receipt ? receipt.hash : tx.hash };
    }
  }

  /**
   * Verifies if the proposed entries match the canonical Soroban ledger state across all fields.
   */
  private async verifySorobanCanonicalState(batch?: TrustScoreBatch): Promise<boolean> {
    if (!batch || batch.entries.length === 0) return false;

    for (const entry of batch.entries) {
      try {
        const snapshot = await this.sorobanClient.getTrustScoreSnapshot(entry.stellarAddress);
        if (!snapshot) return false;

        if (
          BigInt(snapshot.score) !== entry.score ||
          snapshot.fulfilledCount !== entry.fulfilledCount ||
          snapshot.lateCount !== entry.lateCount ||
          snapshot.breachedCount !== entry.breachedCount ||
          snapshot.sourceLedgerSeq !== entry.sourceLedgerSeq
        ) {
          return false;
        }
      } catch (error) {
        console.error(`Error querying Soroban state for ${entry.stellarAddress}:`, error);
        return false;
      }
    }
    return true;
  }

  /**
   * Queries authoritative state directly from Soroban RPC for fault recovery.
   * Rejects and aborts recovery if any single entry snapshot is missing or throws.
   */
  private async fetchAuthoritativeState(
    entries: TrustScoreEntry[],
  ): Promise<TrustScoreEntry[] | null> {
    const authoritativeEntries: TrustScoreEntry[] = [];

    for (const entry of entries) {
      try {
        const snapshot = await this.sorobanClient.getTrustScoreSnapshot(entry.stellarAddress);
        if (!snapshot) {
          console.error(
            `[Relayer] Authoritative snapshot missing for ${entry.stellarAddress}. Aborting recovery.`,
          );
          return null;
        }
        authoritativeEntries.push({
          stellarAddress: entry.stellarAddress,
          score: BigInt(snapshot.score),
          fulfilledCount: snapshot.fulfilledCount,
          lateCount: snapshot.lateCount,
          breachedCount: snapshot.breachedCount,
          sourceLedgerSeq: snapshot.sourceLedgerSeq,
        });
      } catch (error) {
        console.error(`Failed to fetch authoritative state for ${entry.stellarAddress}:`, error);
        return null;
      }
    }

    return authoritativeEntries;
  }

  /**
   * Detects if a source chain reorg occurred based on non-monotonic ledger sequences.
   */
  public detectSourceReorg(lastKnownLedgerSeq: bigint, currentCanonicalLedgerSeq: bigint): boolean {
    return currentCanonicalLedgerSeq < lastKnownLedgerSeq;
  }
}

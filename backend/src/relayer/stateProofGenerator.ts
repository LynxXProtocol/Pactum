import { rpc, xdr, Address as StellarAddress, scValToNative } from '@stellar/stellar-sdk';
import {
  BATCH_PROOF_VERSION,
  PactumStateProof,
  PactumBatchedStateProof,
  ScoreData,
  HeaderProof,
  CommitmentEnvelope,
  BatchedProofEntry,
} from '../schemas/stateProof';
import {
  computeLeafHash,
  computeHeaderHash,
  computeAggregationLeaf,
  addressToBytes32,
} from './encoder';
import { MerkleTree } from './merkleTree';

export interface ProofGeneratorConfig {
  rpcUrl?: string;
  contractId: string;
  networkPassphrase: string;
}

export interface TrustScoreEntryRecord {
  stellarAddress: string;
  scoreData: ScoreData;
}

export interface GenerateProofOptions {
  targetLedgerSeq?: number;
  allEntries?: TrustScoreEntryRecord[];
  headerProof?: HeaderProof;
}

/**
 * Zero-trust state proof generator.
 *
 * Single-proof `generateProof` stays available for immediate finality. The default
 * aggregation path is `generateBatchProof`, which emits one unified Merkle root
 * plus per-entry inclusion paths so each state transition remains independently
 * verifiable against that root.
 */
export class StateProofGenerator {
  private rpcServer?: rpc.Server;
  private contractId: string;
  private networkPassphrase: string;
  private localState: Map<string, ScoreData> = new Map();

  constructor(config: ProofGeneratorConfig) {
    this.contractId = config.contractId;
    this.networkPassphrase = config.networkPassphrase;
    if (config.rpcUrl) {
      this.rpcServer = new rpc.Server(config.rpcUrl, { allowHttp: true });
    }
  }

  /**
   * Sets or updates an address's trust score in local state cache.
   */
  public setScoreData(stellarAddress: string, scoreData: ScoreData): void {
    this.localState.set(stellarAddress, scoreData);
  }

  public getTrackedAddresses(): string[] {
    return [...this.localState.keys()];
  }

  public getLocalEntries(): TrustScoreEntryRecord[] {
    return [...this.localState.entries()].map(([stellarAddress, scoreData]) => ({
      stellarAddress,
      scoreData,
    }));
  }

  /**
   * Fetches trust score data for an address either from live RPC or local state.
   */
  public async fetchScoreData(stellarAddress: string): Promise<ScoreData> {
    if (this.localState.has(stellarAddress)) {
      return this.localState.get(stellarAddress)!;
    }

    if (this.rpcServer) {
      try {
        const contractAddr = StellarAddress.fromString(this.contractId);
        const addressObj = StellarAddress.fromString(stellarAddress);
        const sym = xdr.ScVal.scvSymbol('TrustHistory');
        const addrVal = addressObj.toScVal();
        const keyScVal = xdr.ScVal.scvVec([sym, addrVal]);

        const ledgerKey = xdr.LedgerKey.contractData(
          new xdr.LedgerKeyContractData({
            contract: contractAddr.toScAddress(),
            key: keyScVal,
            durability: xdr.ContractDataDurability.persistent(),
          })
        );

        const response = await this.rpcServer.getLedgerEntries(ledgerKey);
        if (response.entries && response.entries.length > 0) {
          const entry: any = response.entries[0];
          const xdrString = typeof entry.xdr === 'string' ? entry.xdr : entry.val;
          const entryData = xdr.LedgerEntryData.fromXDR(xdrString, 'base64');
          const contractData = entryData.contractData();
          const nativeVal = scValToNative(contractData.val());

          const scoreData: ScoreData = {
            score: typeof nativeVal.score === 'number' ? nativeVal.score : 50,
            fulfilledCount: nativeVal.current?.fulfilled || nativeVal.fulfilled || 0,
            lateCount: nativeVal.current?.late || nativeVal.late || 0,
            breachedCount: nativeVal.current?.breached || nativeVal.breached || 0,
            epoch: nativeVal.epoch || 0,
            sourceLedgerSeq: entry.lastModifiedLedgerSeq || response.latestLedger || 1,
          };

          this.localState.set(stellarAddress, scoreData);
          return scoreData;
        }
      } catch (err) {
        console.warn(`Could not query Soroban RPC for ${stellarAddress}:`, err);
      }
    }

    const defaultData: ScoreData = {
      score: 50,
      fulfilledCount: 0,
      lateCount: 0,
      breachedCount: 0,
      epoch: 0,
      sourceLedgerSeq: 1,
    };
    return defaultData;
  }

  /**
   * Generates a zero-trust PactumStateProof for an address at a given ledger sequence.
   * Kept for callers that need immediate single-proof finality.
   */
  public async generateProof(
    stellarAddress: string,
    options?: GenerateProofOptions
  ): Promise<PactumStateProof> {
    const scoreData = await this.fetchScoreData(stellarAddress);
    const ledgerSeq = options?.targetLedgerSeq || scoreData.sourceLedgerSeq || 1;

    const entries = this.collectSortedEntries(
      options?.allEntries,
      { stellarAddress, scoreData }
    );

    const { leaves, tree, targetIndex } = this.buildStateTree(entries, stellarAddress);
    const merkleProof = tree.getProof(targetIndex);
    const stateRootHash = tree.getRootHex();
    const leafHash = `0x${leaves[targetIndex].toString('hex')}`;

    const headerProof: HeaderProof = options?.headerProof || this.defaultHeaderProof(stateRootHash);
    const headerHash = computeHeaderHash(ledgerSeq, headerProof);
    const ledgerHeaderHash = `0x${headerHash.toString('hex')}`;

    return {
      version: '1.0.0',
      networkPassphrase: this.networkPassphrase,
      ledgerSeq,
      ledgerHeaderHash,
      stateRootHash,
      contractId: this.contractId,
      stellarAddress,
      scoreData,
      leafHash,
      merkleProof,
      headerProof,
    };
  }

  /**
   * Builds one unified proof over an ordered set of state transitions.
   *
   * Each entry carries a commitment envelope (score data, leaf hash, sequence id)
   * plus inclusion paths against both the Soroban state tree and the aggregation tree.
   * The batch is the complete leaf set of both trees, so the EVM verifier can
   * reconstruct the roots from the compact entries without shipping audit paths.
   */
  public async generateBatchProof(
    targets: string[] | TrustScoreEntryRecord[],
    options?: {
      targetLedgerSeq?: number;
      headerProof?: HeaderProof;
    }
  ): Promise<PactumBatchedStateProof> {
    if (targets.length === 0) {
      throw new Error('generateBatchProof requires at least one state transition');
    }

    const resolved: TrustScoreEntryRecord[] = [];
    for (const target of targets) {
      if (typeof target === 'string') {
        resolved.push({
          stellarAddress: target,
          scoreData: await this.fetchScoreData(target),
        });
      } else {
        resolved.push(target);
      }
    }

    const entries = this.collectSortedEntries(resolved);
    if (entries.length === 0) {
      throw new Error('generateBatchProof produced an empty entry set');
    }

    const ledgerSeq =
      options?.targetLedgerSeq ||
      Math.max(...entries.map((e) => e.scoreData.sourceLedgerSeq || 1));

    const { leaves, tree } = this.buildStateTree(entries);
    const stateMerkleProofs = tree.getAllProofs();
    const stateRootHash = tree.getRootHex();

    const aggregationLeaves: Buffer[] = [];
    const envelopes: CommitmentEnvelope[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const leafHash = `0x${leaves[i].toString('hex')}`;
      envelopes.push({
        sequenceId: i,
        stellarAddress: entry.stellarAddress,
        scoreData: entry.scoreData,
        leafHash,
        contractId: this.contractId,
      });
      aggregationLeaves.push(
        computeAggregationLeaf(
          i,
          entry.stellarAddress,
          leaves[i],
          entry.scoreData.score,
          entry.scoreData.sourceLedgerSeq
        )
      );
    }

    const aggregationTree = new MerkleTree(aggregationLeaves);
    const aggregationProofs = aggregationTree.getAllProofs();
    const aggregationRoot = aggregationTree.getRootHex();

    const headerProof: HeaderProof = options?.headerProof || this.defaultHeaderProof(stateRootHash);
    const headerHash = computeHeaderHash(ledgerSeq, headerProof);
    const ledgerHeaderHash = `0x${headerHash.toString('hex')}`;

    const batchEntries: BatchedProofEntry[] = envelopes.map((envelope, i) => ({
      sequenceId: envelope.sequenceId,
      stellarAddress: envelope.stellarAddress,
      scoreData: envelope.scoreData,
      leafHash: envelope.leafHash,
      merkleProof: stateMerkleProofs[i],
      aggregationProof: aggregationProofs[i],
    }));

    return {
      version: BATCH_PROOF_VERSION,
      networkPassphrase: this.networkPassphrase,
      ledgerSeq,
      ledgerHeaderHash,
      stateRootHash,
      contractId: this.contractId,
      aggregationRoot,
      headerProof,
      entries: batchEntries,
    };
  }

  private defaultHeaderProof(stateRootHash: string): HeaderProof {
    return {
      previousLedgerHash: '0x' + '11'.repeat(32),
      txSetResultHash: '0x' + '22'.repeat(32),
      bucketListHash: stateRootHash,
      ledgerVersion: 21,
    };
  }

  private collectSortedEntries(
    allEntries?: TrustScoreEntryRecord[],
    extra?: TrustScoreEntryRecord
  ): TrustScoreEntryRecord[] {
    const byAddress = new Map<string, TrustScoreEntryRecord>();
    const source = allEntries && allEntries.length > 0 ? allEntries : [];
    for (const entry of source) {
      byAddress.set(entry.stellarAddress, entry);
    }
    if (extra && !byAddress.has(extra.stellarAddress)) {
      byAddress.set(extra.stellarAddress, extra);
    }
    if (byAddress.size === 0 && extra) {
      byAddress.set(extra.stellarAddress, extra);
    }

    return [...byAddress.values()].sort((a, b) =>
      addressToBytes32(a.stellarAddress).compare(addressToBytes32(b.stellarAddress))
    );
  }

  private buildStateTree(
    entries: TrustScoreEntryRecord[],
    targetAddress?: string
  ): { leaves: Buffer[]; tree: MerkleTree; targetIndex: number } {
    const leaves = entries.map((e) =>
      computeLeafHash(this.contractId, e.stellarAddress, e.scoreData)
    );
    const tree = new MerkleTree(leaves);
    const targetIndex = targetAddress
      ? entries.findIndex((e) => e.stellarAddress === targetAddress)
      : 0;
    if (targetAddress && targetIndex < 0) {
      throw new Error(`Target address ${targetAddress} missing from state tree`);
    }
    return { leaves, tree, targetIndex };
  }
}

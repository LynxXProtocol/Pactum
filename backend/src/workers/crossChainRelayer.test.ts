import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CrossChainRelayer,
  TrustScoreEntry,
  MemoryBatchStore,
  TrustScoreBatch,
} from './crossChainRelayer';

describe('CrossChainRelayer', () => {
  const dummyRegistryId = '0x1111111111111111111111111111111111111111111111111111111111111111';

  it('correctly identifies source chain reorganization', () => {
    const mockSorobanClient = {} as any;
    const mockOracleContract = {} as any;
    const mockSigner = {} as any;

    const relayer = new CrossChainRelayer(mockSorobanClient, mockOracleContract, mockSigner, {
      registryId: dummyRegistryId,
      oracleContractAddress: '0x0000000000000000000000000000000000000001',
      sourceChainId: 1001,
    });

    // Reorg: canonical ledger sequence rolled backward from 1050 to 1040
    assert.equal(relayer.detectSourceReorg(1050n, 1040n), true);

    // Monotonic progression: standard sequential advance
    assert.equal(relayer.detectSourceReorg(1050n, 1051n), false);
  });

  it('encodes batch into expected ABI wire format', () => {
    const mockSorobanClient = {} as any;
    const mockOracleContract = {} as any;
    const mockSigner = {} as any;

    const relayer = new CrossChainRelayer(mockSorobanClient, mockOracleContract, mockSigner, {
      registryId: dummyRegistryId,
      oracleContractAddress: '0x0000000000000000000000000000000000000001',
      sourceChainId: 1001,
    });

    const entry: TrustScoreEntry = {
      stellarAddress: '0x0000000000000000000000000000000000000000000000000000000000000001',
      score: 95n,
      fulfilledCount: 10,
      lateCount: 0,
      breachedCount: 0,
      sourceLedgerSeq: 5000n,
    };

    const encoded = relayer.encodeBatch({
      version: 1,
      registryId: dummyRegistryId,
      batchNonce: 1n,
      batchTimestamp: 1700000000n,
      entries: [entry],
    });

    assert.ok(encoded.startsWith('0x'));
    assert.ok(encoded.length > 64);
  });

  it('persists and retrieves batches through MemoryBatchStore across operations', async () => {
    const store = new MemoryBatchStore();
    const batch: TrustScoreBatch = {
      version: 1,
      registryId: dummyRegistryId,
      batchNonce: 42n,
      batchTimestamp: 1700000000n,
      entries: [],
    };

    await store.saveBatch(batch);
    const retrieved = await store.getBatch(42n);
    assert.deepEqual(retrieved, batch);

    await store.deleteBatch(42n);
    const deleted = await store.getBatch(42n);
    assert.equal(deleted, null);
  });
});

import { describe, it, expect } from 'vitest';
import { StrKey } from '@stellar/stellar-sdk';
import {
  verifyPactumStateProof,
  computeLeafHash,
  computeMerkleRoot,
  computeMerkleRootFromLeaves,
  computeHeaderHash,
  computeAggregationLeaf,
  addressToBytes32,
  bytesToHex,
  type PactumStateProof,
  type PactumBatchedStateProof,
  type ScoreData,
  type MerkleProofNode,
  verifyPactumBatchedStateProof,
  BATCH_PROOF_VERSION,
} from '../src/index.js';

describe('Zero-Trust StateProofVerifier (TypeScript SDK)', () => {
  const defaultScoreData: ScoreData = {
    score: 85,
    fulfilledCount: 10,
    lateCount: 1,
    breachedCount: 0,
    epoch: 1,
    sourceLedgerSeq: 10450,
  };

  // Precomputed cross-runtime fixed proof fixture
  const precomputedProofFixture: PactumStateProof = {
    version: '1.0.0',
    networkPassphrase: 'Test SDF Network ; September 2015',
    ledgerSeq: 10500,
    ledgerHeaderHash: '0x95e603468fa1f5628529977b4dd12b56da453da8756426730eadfd88e3ac73d6',
    stateRootHash: '0x1813fc0d93c324560ff7837e0a4aeba0e7ffab8e600f953c7b9a235dc6deeb57',
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
    stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    scoreData: {
      score: 85,
      fulfilledCount: 10,
      lateCount: 1,
      breachedCount: 0,
      epoch: 1,
      sourceLedgerSeq: 10450,
    },
    leafHash: '0x1af4b84225b30a8dd832dbc4ffc74945852979a5be0bcb0c775364930df313cd',
    merkleProof: [
      {
        sibling: '0x0074712d50c28ef2b55079d4a3522b39c43fd3169e1b17345901e1a2e607f03d',
        isRight: true,
      },
    ],
    headerProof: {
      previousLedgerHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      txSetResultHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
      bucketListHash: '0x1813fc0d93c324560ff7837e0a4aeba0e7ffab8e600f953c7b9a235dc6deeb57',
      ledgerVersion: 21,
    },
  };
  const independentTrustedHeader = '0x95e603468fa1f5628529977b4dd12b56da453da8756426730eadfd88e3ac73d6';

  const sampleProof: PactumStateProof = {
    version: '1.0.0',
    networkPassphrase: 'Test SDF Network ; September 2015',
    ledgerSeq: 10500,
    ledgerHeaderHash: '0x',
    stateRootHash: '0x',
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
    stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    scoreData: { ...defaultScoreData },
    leafHash: '',
    merkleProof: [],
    headerProof: {
      previousLedgerHash: '0x' + '11'.repeat(32),
      txSetResultHash: '0x' + '22'.repeat(32),
      bucketListHash: '',
      ledgerVersion: 21,
    },
  };

  // Helper to setup a dynamic valid proof with independent cloned scoreData
  function createValidProof(overrides: Partial<PactumStateProof> = {}): PactumStateProof {
    const scoreData: ScoreData = {
      ...defaultScoreData,
      ...(overrides.scoreData || {}),
    };

    const contractId = overrides.contractId || sampleProof.contractId;
    const stellarAddress = overrides.stellarAddress || sampleProof.stellarAddress;
    const ledgerSeq = overrides.ledgerSeq !== undefined ? overrides.ledgerSeq : sampleProof.ledgerSeq;

    const leaf = computeLeafHash(contractId, stellarAddress, scoreData);
    const leafHex = bytesToHex(leaf);

    const sibling1 = '0x' + 'ab'.repeat(32);
    const sibling2 = '0x' + 'cd'.repeat(32);
    const merkleProof = overrides.merkleProof || [
      { sibling: sibling1, isRight: true },
      { sibling: sibling2, isRight: false },
    ];

    const root = computeMerkleRoot(leaf, merkleProof);
    const rootHex = bytesToHex(root);

    const headerProof = {
      previousLedgerHash: '0x' + '11'.repeat(32),
      txSetResultHash: '0x' + '22'.repeat(32),
      bucketListHash: rootHex,
      ledgerVersion: 21,
      ...(overrides.headerProof || {}),
    };

    const headerHash = computeHeaderHash(ledgerSeq, headerProof);
    const headerHex = bytesToHex(headerHash);

    const { scoreData: _s, headerProof: _h, merkleProof: _m, ...restOverrides } = overrides;

    return {
      version: '1.0.0',
      networkPassphrase: sampleProof.networkPassphrase,
      ledgerSeq,
      ledgerHeaderHash: headerHex,
      stateRootHash: rootHex,
      contractId,
      stellarAddress,
      scoreData,
      leafHash: leafHex,
      merkleProof,
      headerProof,
      ...restOverrides,
    };
  }

  it('successfully verifies a precomputed cross-runtime proof fixture against independent trusted header', () => {
    const result = verifyPactumStateProof(precomputedProofFixture, independentTrustedHeader);

    expect(result.valid).toBe(true);
    expect(result.score).toBe(85);
    expect(result.ledgerSeq).toBe(10500);
    expect(result.stellarAddress).toBe('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
    expect(result.contractId).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM');
  });

  it('successfully verifies a dynamic valid cryptographic state proof against a trusted header', () => {
    const proof = createValidProof();
    const result = verifyPactumStateProof(proof, proof.ledgerHeaderHash);

    expect(result.valid).toBe(true);
    expect(result.score).toBe(85);
    expect(result.ledgerSeq).toBe(10500);
    expect(result.stellarAddress).toBe(sampleProof.stellarAddress);
    expect(result.contractId).toBe(sampleProof.contractId);
  });

  it('rejects a proof when trusted header anchor is omitted', () => {
    const proof = createValidProof();
    const result = verifyPactumStateProof(proof);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('anchor is required');
  });

  it('rejects a proof when trusted header hash does not match', () => {
    const proof = createValidProof();
    const wrongHeader = '0x' + '99'.repeat(32);
    const result = verifyPactumStateProof(proof, wrongHeader);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('does not match trusted hash');
  });

  it('rejects a proof with an unsupported version string', () => {
    const proof = createValidProof({ version: '2.0.0' as any });
    const result = verifyPactumStateProof(proof, proof.ledgerHeaderHash);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unsupported proof version');
  });

  it('rejects a proof with tampered trust score', () => {
    const proof = createValidProof();
    const trustedHeader = proof.ledgerHeaderHash;
    proof.scoreData.score = 99; // Tampered

    const result = verifyPactumStateProof(proof, trustedHeader);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Leaf hash mismatch');
  });

  it('rejects a proof with tampered fulfilledCount', () => {
    const proof = createValidProof();
    const trustedHeader = proof.ledgerHeaderHash;
    proof.scoreData.fulfilledCount = 500; // Tampered

    const result = verifyPactumStateProof(proof, trustedHeader);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Leaf hash mismatch');
  });

  it('rejects a proof with corrupted Merkle siblings', () => {
    const proof = createValidProof();
    const trustedHeader = proof.ledgerHeaderHash;
    proof.merkleProof[0].sibling = '0x' + 'ff'.repeat(32); // Corrupted sibling

    const result = verifyPactumStateProof(proof, trustedHeader);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Merkle root mismatch');
  });

  it('rejects a proof when stateRootHash does not match bucketListHash in header proof', () => {
    const proof = createValidProof();
    const trustedHeader = proof.ledgerHeaderHash;
    proof.headerProof.bucketListHash = '0x' + 'ee'.repeat(32);

    const result = verifyPactumStateProof(proof, trustedHeader);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('bucketListHash does not match stateRootHash');
  });

  it('rejects a proof with corrupted ledger header hash', () => {
    const proof = createValidProof();
    const trustedHeader = '0x' + '44'.repeat(32);
    proof.ledgerHeaderHash = '0x' + '44'.repeat(32);

    const result = verifyPactumStateProof(proof, trustedHeader);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Ledger header hash mismatch');
  });

  it('correctly decodes Stellar G and C addresses to exact 32-byte buffers', () => {
    const gAddr = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    const gBytes = addressToBytes32(gAddr);
    const expectedG = StrKey.decodeEd25519PublicKey(gAddr);
    expect(gBytes.length).toBe(32);
    expect(Array.from(gBytes)).toEqual(Array.from(expectedG));

    const cAddr = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
    const cBytes = addressToBytes32(cAddr);
    const expectedC = StrKey.decodeContract(cAddr);
    expect(cBytes.length).toBe(32);
    expect(Array.from(cBytes)).toEqual(Array.from(expectedC));
  });

  it('verifies a two-entry batched state proof against a shared trusted header', () => {
    const a = '0x' + '01'.repeat(32);
    const b = '0x' + '02'.repeat(32);
    const scoreA: ScoreData = { ...defaultScoreData, score: 70 };
    const scoreB: ScoreData = { ...defaultScoreData, score: 80 };
    const contractId = sampleProof.contractId;

    const leafA = computeLeafHash(contractId, a, scoreA);
    const leafB = computeLeafHash(contractId, b, scoreB);
    const stateRoot = computeMerkleRootFromLeaves([leafA, leafB]);

    const proofA: MerkleProofNode[] = [{ sibling: bytesToHex(leafB), isRight: true }];
    const proofB: MerkleProofNode[] = [{ sibling: bytesToHex(leafA), isRight: false }];

    const aggA = computeAggregationLeaf(0, a, leafA, scoreA.score, scoreA.sourceLedgerSeq);
    const aggB = computeAggregationLeaf(1, b, leafB, scoreB.score, scoreB.sourceLedgerSeq);
    const aggregationRoot = computeMerkleRootFromLeaves([aggA, aggB]);

    const headerProof = {
      previousLedgerHash: '0x' + '11'.repeat(32),
      txSetResultHash: '0x' + '22'.repeat(32),
      bucketListHash: bytesToHex(stateRoot),
      ledgerVersion: 21,
    };
    const ledgerSeq = 10500;
    const ledgerHeaderHash = bytesToHex(computeHeaderHash(ledgerSeq, headerProof));

    const batch: PactumBatchedStateProof = {
      version: BATCH_PROOF_VERSION,
      networkPassphrase: sampleProof.networkPassphrase,
      ledgerSeq,
      ledgerHeaderHash,
      stateRootHash: bytesToHex(stateRoot),
      contractId,
      aggregationRoot: bytesToHex(aggregationRoot),
      headerProof,
      entries: [
        {
          sequenceId: 0,
          stellarAddress: a,
          scoreData: scoreA,
          leafHash: bytesToHex(leafA),
          merkleProof: proofA,
          aggregationProof: [{ sibling: bytesToHex(aggB), isRight: true }],
        },
        {
          sequenceId: 1,
          stellarAddress: b,
          scoreData: scoreB,
          leafHash: bytesToHex(leafB),
          merkleProof: proofB,
          aggregationProof: [{ sibling: bytesToHex(aggA), isRight: false }],
        },
      ],
    };

    const result = verifyPactumBatchedStateProof(batch, ledgerHeaderHash);
    expect(result.valid).toBe(true);
    expect(result.entryCount).toBe(2);
    expect(result.scores).toEqual([70, 80]);
  });
});

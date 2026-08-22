import {
  BATCH_PROOF_VERSION,
  BatchVerificationResult,
  PactumBatchedStateProof,
  PactumStateProof,
  VerificationResult,
} from '../schemas/stateProof';
import { addressToBytes32, computeAggregationLeaf, computeLeafHash, computeHeaderHash } from './encoder';
import { MerkleTree } from './merkleTree';

export function normalizeHex32(hex: string): string {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return `0x${clean.toLowerCase().padStart(64, '0')}`;
}

/**
 * Cryptographically verifies a zero-trust PactumStateProof against a trusted Stellar ledger header hash.
 *
 * @param proof The state proof payload
 * @param trustedLedgerHeaderHash The known Stellar ledger header hash to anchor and verify against
 */
export function verifyPactumStateProof(
  proof: PactumStateProof,
  trustedLedgerHeaderHash?: string
): VerificationResult {
  try {
    if (!proof || proof.version !== '1.0.0') {
      return { valid: false, error: `Unsupported proof version: ${proof?.version}` };
    }

    if (!trustedLedgerHeaderHash) {
      return {
        valid: false,
        error: 'Trusted ledger header hash anchor is required for zero-trust verification',
      };
    }

    // 1. Verify Leaf Hash
    const expectedLeaf = computeLeafHash(
      proof.contractId,
      proof.stellarAddress,
      proof.scoreData
    );
    const expectedLeafHex = normalizeHex32(expectedLeaf.toString('hex'));
    const proofLeafHex = normalizeHex32(proof.leafHash);

    if (expectedLeafHex !== proofLeafHex) {
      return {
        valid: false,
        error: `Leaf hash mismatch. Claimed ${proof.leafHash}, computed ${expectedLeafHex}`,
      };
    }

    // 2. Verify Merkle Proof against State Root Hash
    const expectedRoot = Buffer.from(proof.stateRootHash.replace(/^0x/, ''), 'hex');
    const isMerkleValid = MerkleTree.verify(expectedLeaf, proof.merkleProof, expectedRoot);
    const proofStateRootHex = normalizeHex32(proof.stateRootHash);

    if (!isMerkleValid) {
      return {
        valid: false,
        error: `Merkle root mismatch. Leaf does not resolve to stateRootHash ${proof.stateRootHash}`,
      };
    }

    // 3. Verify BucketList / StateRoot match in Header Proof
    const headerBucketListHex = normalizeHex32(proof.headerProof.bucketListHash);
    if (headerBucketListHex !== proofStateRootHex) {
      return {
        valid: false,
        error: 'Header proof bucketListHash does not match stateRootHash',
      };
    }

    // 4. Verify Ledger Header Hash
    const computedHeader = computeHeaderHash(proof.ledgerSeq, proof.headerProof);
    const computedHeaderHex = normalizeHex32(computedHeader.toString('hex'));
    const proofHeaderHex = normalizeHex32(proof.ledgerHeaderHash);

    if (computedHeaderHex !== proofHeaderHex) {
      return {
        valid: false,
        error: `Ledger header hash mismatch. Claimed ${proof.ledgerHeaderHash}, computed ${computedHeaderHex}`,
      };
    }

    // 5. Verify against trusted header hash anchor
    const normalizedTrusted = normalizeHex32(trustedLedgerHeaderHash);
    if (proofHeaderHex !== normalizedTrusted) {
      return {
        valid: false,
        error: `Header hash ${proof.ledgerHeaderHash} does not match trusted hash ${trustedLedgerHeaderHash}`,
      };
    }

    return {
      valid: true,
      score: proof.scoreData.score,
      ledgerSeq: proof.ledgerSeq,
      stellarAddress: proof.stellarAddress,
      contractId: proof.contractId,
    };
  } catch (err) {
    return {
      valid: false,
      error: `Verification exception: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Verifies a batched state proof: shared header once, then each entry's state-tree
 * and aggregation-tree inclusion path against the unified roots.
 */
export function verifyPactumBatchedStateProof(
  batch: PactumBatchedStateProof,
  trustedLedgerHeaderHash?: string
): BatchVerificationResult {
  try {
    if (!batch || batch.version !== BATCH_PROOF_VERSION) {
      return { valid: false, error: `Unsupported batch proof version: ${batch?.version}` };
    }

    if (!trustedLedgerHeaderHash) {
      return {
        valid: false,
        error: 'Trusted ledger header hash anchor is required for zero-trust verification',
      };
    }

    if (!batch.entries || batch.entries.length === 0) {
      return { valid: false, error: 'Batch proof contains no entries' };
    }

    const expectedRoot = Buffer.from(batch.stateRootHash.replace(/^0x/, ''), 'hex');
    const expectedAggRoot = Buffer.from(batch.aggregationRoot.replace(/^0x/, ''), 'hex');
    const scores: number[] = [];

    for (let i = 0; i < batch.entries.length; i++) {
      const entry = batch.entries[i];
      if (entry.sequenceId !== i) {
        return {
          valid: false,
          error: `Sequence id mismatch at index ${i}: expected ${i}, got ${entry.sequenceId}`,
        };
      }

      if (i > 0) {
        const prev = addressToBytes32(batch.entries[i - 1].stellarAddress);
        const curr = addressToBytes32(entry.stellarAddress);
        if (curr.compare(prev) <= 0) {
          return { valid: false, error: `Batch entries are not strictly sorted by address at index ${i}` };
        }
      }

      const expectedLeaf = computeLeafHash(
        batch.contractId,
        entry.stellarAddress,
        entry.scoreData
      );
      const expectedLeafHex = normalizeHex32(expectedLeaf.toString('hex'));
      if (expectedLeafHex !== normalizeHex32(entry.leafHash)) {
        return {
          valid: false,
          error: `Leaf hash mismatch for ${entry.stellarAddress}. Claimed ${entry.leafHash}, computed ${expectedLeafHex}`,
        };
      }

      if (!MerkleTree.verify(expectedLeaf, entry.merkleProof, expectedRoot)) {
        return {
          valid: false,
          error: `State Merkle root mismatch for ${entry.stellarAddress}`,
        };
      }

      const aggLeaf = computeAggregationLeaf(
        entry.sequenceId,
        entry.stellarAddress,
        expectedLeaf,
        entry.scoreData.score,
        entry.scoreData.sourceLedgerSeq
      );
      if (!MerkleTree.verify(aggLeaf, entry.aggregationProof, expectedAggRoot)) {
        return {
          valid: false,
          error: `Aggregation Merkle root mismatch for ${entry.stellarAddress}`,
        };
      }

      scores.push(entry.scoreData.score);
    }

    const reconstructedState = MerkleTree.computeRootFromLeaves(
      batch.entries.map((e) => Buffer.from(e.leafHash.replace(/^0x/, ''), 'hex'))
    );
    if (!reconstructedState.equals(expectedRoot)) {
      return { valid: false, error: 'Reconstructed state root does not match stateRootHash' };
    }

    const headerBucketListHex = normalizeHex32(batch.headerProof.bucketListHash);
    if (headerBucketListHex !== normalizeHex32(batch.stateRootHash)) {
      return {
        valid: false,
        error: 'Header proof bucketListHash does not match stateRootHash',
      };
    }

    const computedHeader = computeHeaderHash(batch.ledgerSeq, batch.headerProof);
    const computedHeaderHex = normalizeHex32(computedHeader.toString('hex'));
    const proofHeaderHex = normalizeHex32(batch.ledgerHeaderHash);

    if (computedHeaderHex !== proofHeaderHex) {
      return {
        valid: false,
        error: `Ledger header hash mismatch. Claimed ${batch.ledgerHeaderHash}, computed ${computedHeaderHex}`,
      };
    }

    const normalizedTrusted = normalizeHex32(trustedLedgerHeaderHash);
    if (proofHeaderHex !== normalizedTrusted) {
      return {
        valid: false,
        error: `Header hash ${batch.ledgerHeaderHash} does not match trusted hash ${trustedLedgerHeaderHash}`,
      };
    }

    return {
      valid: true,
      scores,
      ledgerSeq: batch.ledgerSeq,
      aggregationRoot: batch.aggregationRoot,
      entryCount: batch.entries.length,
    };
  } catch (err) {
    return {
      valid: false,
      error: `Verification exception: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

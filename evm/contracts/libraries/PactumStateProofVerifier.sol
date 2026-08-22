// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PactumStateProofVerifier
/// @notice Standalone cryptographic verification library for Stellar / Soroban Pactum state proofs.
/// Cryptographically verifies that a user's trust score existed at a specific Stellar ledger height
/// against a known Stellar block header hash, without trusting any intermediary or relayer.
library PactumStateProofVerifier {
    struct ScoreData {
        uint32 score;
        uint32 fulfilledCount;
        uint32 lateCount;
        uint32 breachedCount;
        uint32 epoch;
        uint64 sourceLedgerSeq;
    }

    struct MerkleNode {
        bytes32 sibling;
        bool isRight;
    }

    struct HeaderProof {
        bytes32 previousLedgerHash;
        bytes32 txSetResultHash;
        bytes32 bucketListHash;
        uint32 ledgerVersion;
    }

    struct StateProof {
        string version;
        string networkPassphrase;
        uint64 ledgerSeq;
        bytes32 ledgerHeaderHash;
        bytes32 stateRootHash;
        bytes32 contractId;
        bytes32 stellarAddress;
        ScoreData scoreData;
        bytes32 leafHash;
        MerkleNode[] merkleProof;
        HeaderProof headerProof;
    }

    error UnsupportedVersion();
    error LeafHashMismatch(bytes32 expected, bytes32 actual);
    error MerkleRootMismatch(bytes32 expected, bytes32 actual);
    error BucketListMismatch(bytes32 stateRoot, bytes32 bucketList);
    error HeaderHashMismatch(bytes32 expected, bytes32 actual);
    error UntrustedHeaderHash(bytes32 claimed, bytes32 trusted);
    error LedgerSeqOverflow(uint64 ledgerSeq);

    /// @notice Computes the 32-byte SHA-256 leaf hash for a trust score contract data entry (92 bytes packed).
    function computeLeafHash(
        bytes32 contractId,
        bytes32 stellarAddress,
        ScoreData memory scoreData
    ) internal pure returns (bytes32) {
        return sha256(
            abi.encodePacked(
                contractId,
                stellarAddress,
                scoreData.score,
                scoreData.fulfilledCount,
                scoreData.lateCount,
                scoreData.breachedCount,
                scoreData.epoch,
                scoreData.sourceLedgerSeq
            )
        );
    }

    /// @notice Computes the Merkle Root from a leaf hash and audit path of sibling hashes.
    function computeMerkleRoot(
        bytes32 leaf,
        MerkleNode[] memory proof
    ) internal pure returns (bytes32) {
        bytes32 current = leaf;
        uint256 length = proof.length;

        for (uint256 i = 0; i < length; i++) {
            bytes32 sibling = proof[i].sibling;
            if (proof[i].isRight) {
                current = sha256(abi.encodePacked(current, sibling));
            } else {
                current = sha256(abi.encodePacked(sibling, current));
            }
        }

        return current;
    }

    /// @notice Computes the 32-byte SHA-256 header hash from ledger sequence and header proof fields (104 bytes packed).
    /// @dev Stellar ledger sequences fit in uint32. An overflow check is enforced if ledgerSeq exceeds type(uint32).max.
    function computeHeaderHash(
        uint64 ledgerSeq,
        HeaderProof memory headerProof
    ) internal pure returns (bytes32) {
        if (ledgerSeq > type(uint32).max) {
            revert LedgerSeqOverflow(ledgerSeq);
        }

        return sha256(
            abi.encodePacked(
                uint32(ledgerSeq),
                headerProof.previousLedgerHash,
                headerProof.txSetResultHash,
                headerProof.bucketListHash,
                headerProof.ledgerVersion
            )
        );
    }

    /// @notice Cryptographically verifies a zero-trust StateProof and reverts with a descriptive error if invalid.
    /// @param proof The state proof structure.
    /// @param trustedLedgerHeaderHash Non-zero trusted block hash to anchor verification against.
    /// @return score The verified trust score (0..100).
    function verifyProofOrRevert(
        StateProof memory proof,
        bytes32 trustedLedgerHeaderHash
    ) internal pure returns (uint32 score) {
        if (keccak256(bytes(proof.version)) != keccak256(bytes("1.0.0"))) {
            revert UnsupportedVersion();
        }

        bytes32 expectedLeaf = computeLeafHash(
            proof.contractId,
            proof.stellarAddress,
            proof.scoreData
        );
        if (expectedLeaf != proof.leafHash) {
            revert LeafHashMismatch(expectedLeaf, proof.leafHash);
        }

        bytes32 computedRoot = computeMerkleRoot(expectedLeaf, proof.merkleProof);
        if (computedRoot != proof.stateRootHash) {
            revert MerkleRootMismatch(computedRoot, proof.stateRootHash);
        }

        if (proof.stateRootHash != proof.headerProof.bucketListHash) {
            revert BucketListMismatch(proof.stateRootHash, proof.headerProof.bucketListHash);
        }

        bytes32 computedHeader = computeHeaderHash(proof.ledgerSeq, proof.headerProof);
        if (computedHeader != proof.ledgerHeaderHash) {
            revert HeaderHashMismatch(computedHeader, proof.ledgerHeaderHash);
        }

        if (trustedLedgerHeaderHash == bytes32(0) || proof.ledgerHeaderHash != trustedLedgerHeaderHash) {
            revert UntrustedHeaderHash(proof.ledgerHeaderHash, trustedLedgerHeaderHash);
        }

        return proof.scoreData.score;
    }

    /// @notice Cryptographically verifies a zero-trust StateProof returning boolean status.
    /// @param proof The state proof structure.
    /// @param trustedLedgerHeaderHash Non-zero trusted block hash to anchor verification against.
    /// @return isValid True if all cryptographic checks pass.
    /// @return score The verified trust score (0..100).
    function verifyProof(
        StateProof memory proof,
        bytes32 trustedLedgerHeaderHash
    ) internal pure returns (bool isValid, uint32 score) {
        if (keccak256(bytes(proof.version)) != keccak256(bytes("1.0.0"))) {
            return (false, 0);
        }

        bytes32 expectedLeaf = computeLeafHash(
            proof.contractId,
            proof.stellarAddress,
            proof.scoreData
        );
        if (expectedLeaf != proof.leafHash) {
            return (false, 0);
        }

        bytes32 computedRoot = computeMerkleRoot(expectedLeaf, proof.merkleProof);
        if (computedRoot != proof.stateRootHash) {
            return (false, 0);
        }

        if (proof.stateRootHash != proof.headerProof.bucketListHash) {
            return (false, 0);
        }

        if (proof.ledgerSeq > type(uint32).max) {
            return (false, 0);
        }

        bytes32 computedHeader = computeHeaderHash(proof.ledgerSeq, proof.headerProof);
        if (computedHeader != proof.ledgerHeaderHash) {
            return (false, 0);
        }

        if (trustedLedgerHeaderHash == bytes32(0) || proof.ledgerHeaderHash != trustedLedgerHeaderHash) {
            return (false, 0);
        }

        return (true, proof.scoreData.score);
    }

    // ---------------------------------------------------------------------
    // Batched proof (aggregation pipeline)
    // ---------------------------------------------------------------------

    uint8 internal constant BATCH_PROOF_VERSION = 1;
    uint256 internal constant MAX_BATCH_SIZE = 64;

    struct CompactBatchEntry {
        bytes32 stellarAddress;
        uint32 score;
        uint32 fulfilledCount;
        uint32 lateCount;
        uint32 breachedCount;
        uint32 epoch;
        uint64 sourceLedgerSeq;
    }

    struct BatchedStateProof {
        uint8 version;
        uint64 ledgerSeq;
        bytes32 ledgerHeaderHash;
        bytes32 contractId;
        bytes32 aggregationRoot;
        HeaderProof headerProof;
        CompactBatchEntry[] entries;
    }

    error EmptyBatch();
    error BatchTooLarge(uint256 size, uint256 max);
    error UnsortedBatchEntries(uint256 index);
    error AggregationRootMismatch(bytes32 expected, bytes32 actual);

    /// @notice Reconstructs a Merkle root from an ordered leaf set (odd leaf duplicated).
    function computeMerkleRootFromLeaves(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        if (n == 0) {
            revert EmptyBatch();
        }
        if (n == 1) {
            return leaves[0];
        }

        bytes32[] memory layer = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            layer[i] = leaves[i];
        }

        while (n > 1) {
            uint256 nextLen = (n + 1) / 2;
            bytes32[] memory next = new bytes32[](nextLen);
            for (uint256 i = 0; i < nextLen; i++) {
                uint256 leftIdx = i * 2;
                uint256 rightIdx = leftIdx + 1;
                bytes32 left = layer[leftIdx];
                bytes32 right = rightIdx < n ? layer[rightIdx] : left;
                next[i] = sha256(abi.encodePacked(left, right));
            }
            layer = next;
            n = nextLen;
        }

        return layer[0];
    }

    /// @notice Double-SHA256 aggregation leaf. `sequenceId` is the sorted batch index.
    function computeAggregationLeaf(
        uint64 sequenceId,
        bytes32 stellarAddress,
        bytes32 leafHash,
        uint32 score,
        uint64 sourceLedgerSeq
    ) internal pure returns (bytes32) {
        bytes32 inner = sha256(
            abi.encodePacked(sequenceId, stellarAddress, leafHash, score, sourceLedgerSeq)
        );
        return sha256(abi.encodePacked(inner));
    }

    /// @notice Recursively unpacks each compact entry, rebuilds the state and aggregation
    /// roots, and checks the shared ledger header once.
    function verifyBatchedProofOrRevert(
        BatchedStateProof calldata batch,
        bytes32 trustedLedgerHeaderHash
    ) internal pure returns (uint256 entryCount) {
        _verifyBatchHeader(batch, trustedLedgerHeaderHash);
        _unpackAndVerifyEntries(batch);
        return batch.entries.length;
    }

    /// @notice Boolean batched verification (no revert on cryptographic failure).
    function verifyBatchedProof(
        BatchedStateProof calldata batch,
        bytes32 trustedLedgerHeaderHash
    ) internal pure returns (bool isValid, uint256 entryCount) {
        if (batch.version != BATCH_PROOF_VERSION) {
            return (false, 0);
        }
        uint256 n = batch.entries.length;
        if (n == 0 || n > MAX_BATCH_SIZE) {
            return (false, 0);
        }
        if (batch.ledgerSeq > type(uint32).max) {
            return (false, 0);
        }
        if (trustedLedgerHeaderHash == bytes32(0)) {
            return (false, 0);
        }

        bytes32 computedHeader = computeHeaderHash(batch.ledgerSeq, batch.headerProof);
        if (computedHeader != batch.ledgerHeaderHash || batch.ledgerHeaderHash != trustedLedgerHeaderHash) {
            return (false, 0);
        }

        if (!_tryUnpackEntries(batch)) {
            return (false, 0);
        }
        return (true, n);
    }

    function _verifyBatchHeader(
        BatchedStateProof calldata batch,
        bytes32 trustedLedgerHeaderHash
    ) private pure {
        if (batch.version != BATCH_PROOF_VERSION) {
            revert UnsupportedVersion();
        }

        uint256 n = batch.entries.length;
        if (n == 0) {
            revert EmptyBatch();
        }
        if (n > MAX_BATCH_SIZE) {
            revert BatchTooLarge(n, MAX_BATCH_SIZE);
        }

        bytes32 computedHeader = computeHeaderHash(batch.ledgerSeq, batch.headerProof);
        if (computedHeader != batch.ledgerHeaderHash) {
            revert HeaderHashMismatch(computedHeader, batch.ledgerHeaderHash);
        }

        if (trustedLedgerHeaderHash == bytes32(0) || batch.ledgerHeaderHash != trustedLedgerHeaderHash) {
            revert UntrustedHeaderHash(batch.ledgerHeaderHash, trustedLedgerHeaderHash);
        }
    }

    function _unpackAndVerifyEntries(BatchedStateProof calldata batch) private pure {
        (bytes32 stateRoot, bytes32 aggregationRoot) = _computeBatchRoots(batch);

        if (stateRoot != batch.headerProof.bucketListHash) {
            revert BucketListMismatch(stateRoot, batch.headerProof.bucketListHash);
        }
        if (aggregationRoot != batch.aggregationRoot) {
            revert AggregationRootMismatch(aggregationRoot, batch.aggregationRoot);
        }
    }

    function _tryUnpackEntries(BatchedStateProof calldata batch) private pure returns (bool) {
        (bool ok, bytes32 stateRoot, bytes32 aggregationRoot) = _tryComputeBatchRoots(batch);
        if (!ok) {
            return false;
        }
        if (stateRoot != batch.headerProof.bucketListHash) {
            return false;
        }
        if (aggregationRoot != batch.aggregationRoot) {
            return false;
        }
        return true;
    }

    function _computeBatchRoots(
        BatchedStateProof calldata batch
    ) private pure returns (bytes32 stateRoot, bytes32 aggregationRoot) {
        uint256 n = batch.entries.length;
        bytes32[] memory stateLeaves = new bytes32[](n);
        bytes32[] memory aggLeaves = new bytes32[](n);

        bytes32 prevAddr = bytes32(0);
        for (uint256 i = 0; i < n; i++) {
            bytes32 addr = batch.entries[i].stellarAddress;
            if (i > 0 && addr <= prevAddr) {
                revert UnsortedBatchEntries(i);
            }
            prevAddr = addr;
            (stateLeaves[i], aggLeaves[i]) = _commitmentHashes(batch, i);
        }

        stateRoot = computeMerkleRootFromLeaves(stateLeaves);
        aggregationRoot = computeMerkleRootFromLeaves(aggLeaves);
    }

    function _tryComputeBatchRoots(
        BatchedStateProof calldata batch
    ) private pure returns (bool ok, bytes32 stateRoot, bytes32 aggregationRoot) {
        uint256 n = batch.entries.length;
        bytes32[] memory stateLeaves = new bytes32[](n);
        bytes32[] memory aggLeaves = new bytes32[](n);

        bytes32 prevAddr = bytes32(0);
        for (uint256 i = 0; i < n; i++) {
            bytes32 addr = batch.entries[i].stellarAddress;
            if (i > 0 && addr <= prevAddr) {
                return (false, bytes32(0), bytes32(0));
            }
            prevAddr = addr;
            (stateLeaves[i], aggLeaves[i]) = _commitmentHashes(batch, i);
        }

        return (
            true,
            computeMerkleRootFromLeaves(stateLeaves),
            computeMerkleRootFromLeaves(aggLeaves)
        );
    }

    /// @dev Unpacks one compact entry into the Soroban state leaf and the aggregation leaf.
    function _commitmentHashes(
        BatchedStateProof calldata batch,
        uint256 index
    ) private pure returns (bytes32 leaf, bytes32 aggregationLeaf) {
        CompactBatchEntry calldata entry = batch.entries[index];
        leaf = sha256(
            abi.encodePacked(
                batch.contractId,
                entry.stellarAddress,
                entry.score,
                entry.fulfilledCount,
                entry.lateCount,
                entry.breachedCount,
                entry.epoch,
                entry.sourceLedgerSeq
            )
        );
        aggregationLeaf = computeAggregationLeaf(
            uint64(index),
            entry.stellarAddress,
            leaf,
            entry.score,
            entry.sourceLedgerSeq
        );
    }
}

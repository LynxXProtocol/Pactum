// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPactumZeroTrustOracle} from "./interfaces/IPactumZeroTrustOracle.sol";
import {PactumStateProofVerifier} from "./libraries/PactumStateProofVerifier.sol";

/// @title PactumZeroTrustOracle
/// @notice Production-ready EVM Zero-Trust Oracle for off-chain and cross-chain integrations.
/// Validates Stellar Merkle state proofs on-chain against trusted Stellar ledger block header hashes.
/// Anyone (untrusted relayer, consumer dApp, or user) can submit a proof. Trust is rooted purely in
/// cryptographic mathematics, not intermediary signatures.
contract PactumZeroTrustOracle is IPactumZeroTrustOracle, Ownable {
    using PactumStateProofVerifier for PactumStateProofVerifier.StateProof;

    /// @notice Soroban Registry Contract ID (bytes32). If set, proofs must originate from this contract.
    bytes32 public registryContractId;

    /// @notice Trusted Stellar ledger sequence -> block header hash mapping.
    mapping(uint64 => bytes32) public trustedLedgerHeaders;

    /// @notice Verified trust score records keyed by Stellar address (bytes32).
    mapping(bytes32 => TrustScoreRecord) private _verifiedScores;

    error UntrustedHeader(uint64 ledgerSeq, bytes32 headerHash);
    error MismatchedRegistry(bytes32 expected, bytes32 actual);
    error StaleLedgerSeq(uint64 submittedSeq, uint64 currentSeq);

    constructor(
        address initialOwner,
        bytes32 initialRegistryContractId
    ) Ownable(initialOwner) {
        registryContractId = initialRegistryContractId;
        emit RegistryContractIdUpdated(initialRegistryContractId);
    }

    // ---------------------------------------------------------------------
    // Owner / Checkpoint Feed Configuration
    // ---------------------------------------------------------------------

    /// @notice Registers or updates a trusted Stellar block header hash at a given ledger sequence.
    /// Can be fed by an on-chain light client, decentralized bridge, or governance oracle.
    function setTrustedLedgerHeader(uint64 ledgerSeq, bytes32 headerHash) external onlyOwner {
        trustedLedgerHeaders[ledgerSeq] = headerHash;
        emit TrustedLedgerHeaderUpdated(ledgerSeq, headerHash);
    }

    /// @notice Batch registers multiple trusted Stellar block headers.
    function setTrustedLedgerHeadersBatch(
        uint64[] calldata ledgerSeqs,
        bytes32[] calldata headerHashes
    ) external onlyOwner {
        require(ledgerSeqs.length == headerHashes.length, "Array length mismatch");
        for (uint256 i = 0; i < ledgerSeqs.length; i++) {
            trustedLedgerHeaders[ledgerSeqs[i]] = headerHashes[i];
            emit TrustedLedgerHeaderUpdated(ledgerSeqs[i], headerHashes[i]);
        }
    }

    /// @notice Updates the allow-listed Soroban registry contract ID.
    function setRegistryContractId(bytes32 newContractId) external onlyOwner {
        registryContractId = newContractId;
        emit RegistryContractIdUpdated(newContractId);
    }

    // ---------------------------------------------------------------------
    // Public State Proof Submission (Zero-Trust)
    // ---------------------------------------------------------------------

    /// @inheritdoc IPactumZeroTrustOracle
    function submitStateProof(
        PactumStateProofVerifier.StateProof calldata proof
    ) external returns (bool) {
        // Check registry contract ID if configured
        if (registryContractId != bytes32(0) && proof.contractId != registryContractId) {
            revert MismatchedRegistry(registryContractId, proof.contractId);
        }

        // Verify that the claimed header hash is in our trusted ledger header set
        bytes32 trustedHeader = trustedLedgerHeaders[proof.ledgerSeq];
        if (trustedHeader == bytes32(0) || trustedHeader != proof.ledgerHeaderHash) {
            revert UntrustedHeader(proof.ledgerSeq, proof.ledgerHeaderHash);
        }

        // Cryptographically verify the state proof (reverts with specific error if invalid)
        uint32 score = PactumStateProofVerifier.verifyProofOrRevert(
            proof,
            trustedHeader
        );

        // Replay and staleness protection: sequence must be strictly greater than existing record
        TrustScoreRecord storage existing = _verifiedScores[proof.stellarAddress];
        if (proof.scoreData.sourceLedgerSeq <= existing.sourceLedgerSeq && existing.updatedAt != 0) {
            revert StaleLedgerSeq(proof.scoreData.sourceLedgerSeq, existing.sourceLedgerSeq);
        }

        // Update score cache
        existing.score = score;
        existing.fulfilledCount = proof.scoreData.fulfilledCount;
        existing.lateCount = proof.scoreData.lateCount;
        existing.breachedCount = proof.scoreData.breachedCount;
        existing.epoch = proof.scoreData.epoch;
        existing.sourceLedgerSeq = proof.scoreData.sourceLedgerSeq;
        existing.updatedAt = uint64(block.timestamp);
        existing.verifiedHeaderHash = proof.ledgerHeaderHash;

        emit StateProofVerified(
            proof.stellarAddress,
            score,
            proof.ledgerSeq,
            proof.ledgerHeaderHash,
            msg.sender
        );

        return true;
    }

    /// @inheritdoc IPactumZeroTrustOracle
    function submitBatchedStateProof(
        PactumStateProofVerifier.BatchedStateProof calldata batch
    ) external returns (uint256) {
        if (registryContractId != bytes32(0) && batch.contractId != registryContractId) {
            revert MismatchedRegistry(registryContractId, batch.contractId);
        }

        bytes32 trustedHeader = trustedLedgerHeaders[batch.ledgerSeq];
        if (trustedHeader == bytes32(0) || trustedHeader != batch.ledgerHeaderHash) {
            revert UntrustedHeader(batch.ledgerSeq, batch.ledgerHeaderHash);
        }

        uint256 verifiedCount = PactumStateProofVerifier.verifyBatchedProofOrRevert(
            batch,
            trustedHeader
        );

        uint256 n = batch.entries.length;
        for (uint256 i = 0; i < n; i++) {
            PactumStateProofVerifier.CompactBatchEntry calldata entry = batch.entries[i];
            TrustScoreRecord storage existing = _verifiedScores[entry.stellarAddress];
            if (entry.sourceLedgerSeq <= existing.sourceLedgerSeq && existing.updatedAt != 0) {
                revert StaleLedgerSeq(entry.sourceLedgerSeq, existing.sourceLedgerSeq);
            }

            existing.score = entry.score;
            existing.fulfilledCount = entry.fulfilledCount;
            existing.lateCount = entry.lateCount;
            existing.breachedCount = entry.breachedCount;
            existing.epoch = entry.epoch;
            existing.sourceLedgerSeq = entry.sourceLedgerSeq;
            existing.updatedAt = uint64(block.timestamp);
            existing.verifiedHeaderHash = batch.ledgerHeaderHash;
        }

        emit BatchedStateProofVerified(
            batch.aggregationRoot,
            verifiedCount,
            batch.ledgerSeq,
            batch.ledgerHeaderHash,
            msg.sender
        );

        return verifiedCount;
    }

    // ---------------------------------------------------------------------
    // View Functions
    // ---------------------------------------------------------------------

    /// @inheritdoc IPactumZeroTrustOracle
    function getVerifiedTrustScore(
        bytes32 stellarAddress
    ) external view returns (TrustScoreRecord memory) {
        return _verifiedScores[stellarAddress];
    }

    /// @inheritdoc IPactumZeroTrustOracle
    function isHeaderTrusted(
        uint64 ledgerSeq,
        bytes32 headerHash
    ) external view returns (bool) {
        bytes32 trusted = trustedLedgerHeaders[ledgerSeq];
        return trusted != bytes32(0) && trusted == headerHash;
    }

    /// @inheritdoc IPactumZeroTrustOracle
    function isScoreStale(
        bytes32 stellarAddress,
        uint256 maxAge
    ) external view returns (bool) {
        uint64 updatedAt = _verifiedScores[stellarAddress].updatedAt;
        if (updatedAt == 0) return true;
        return block.timestamp - uint256(updatedAt) > maxAge;
    }
}

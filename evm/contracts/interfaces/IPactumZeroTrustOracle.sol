// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PactumStateProofVerifier} from "../libraries/PactumStateProofVerifier.sol";

/// @title IPactumZeroTrustOracle
/// @notice Interface for the EVM Zero-Trust Oracle Relay.
/// Allows any untrusted party to submit cryptographically verified Stellar state proofs.
interface IPactumZeroTrustOracle {
    struct TrustScoreRecord {
        uint32 score;
        uint32 fulfilledCount;
        uint32 lateCount;
        uint32 breachedCount;
        uint32 epoch;
        uint64 sourceLedgerSeq;
        uint64 updatedAt;
        bytes32 verifiedHeaderHash;
    }

    event StateProofVerified(
        bytes32 indexed stellarAddress,
        uint32 score,
        uint64 indexed ledgerSeq,
        bytes32 indexed ledgerHeaderHash,
        address submitter
    );

    event TrustedLedgerHeaderUpdated(uint64 indexed ledgerSeq, bytes32 indexed headerHash);
    event RegistryContractIdUpdated(bytes32 indexed contractId);

    event BatchedStateProofVerified(
        bytes32 indexed aggregationRoot,
        uint256 entryCount,
        uint64 indexed ledgerSeq,
        bytes32 indexed ledgerHeaderHash,
        address submitter
    );

    /// @notice Submits and verifies a zero-trust Stellar state proof.
    /// @dev Reverts if cryptographic proof verification fails or header is untrusted.
    function submitStateProof(PactumStateProofVerifier.StateProof calldata proof) external returns (bool);

    /// @notice Submits and verifies a batched aggregation of state proofs in one transaction.
    /// @dev Shared header is checked once; each compact entry is unpacked against the unified roots.
    function submitBatchedStateProof(
        PactumStateProofVerifier.BatchedStateProof calldata batch
    ) external returns (uint256 verifiedCount);

    /// @notice Queries the verified trust score record for a given Stellar address.
    function getVerifiedTrustScore(bytes32 stellarAddress) external view returns (TrustScoreRecord memory);

    /// @notice Checks if a specific Stellar ledger header hash is recorded as trusted.
    function isHeaderTrusted(uint64 ledgerSeq, bytes32 headerHash) external view returns (bool);

    /// @notice Checks if the cached score for an address is older than maxAge seconds.
    function isScoreStale(bytes32 stellarAddress, uint256 maxAge) external view returns (bool);
}

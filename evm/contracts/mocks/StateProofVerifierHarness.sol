// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PactumStateProofVerifier} from "../libraries/PactumStateProofVerifier.sol";

/// @title StateProofVerifierHarness
/// @notice Exposes library verification as external calls so tests can measure gas of
/// cryptographic verification independently from oracle storage writes.
contract StateProofVerifierHarness {
    function verifyProof(
        PactumStateProofVerifier.StateProof calldata proof,
        bytes32 trustedLedgerHeaderHash
    ) external pure returns (bool isValid, uint32 score) {
        return PactumStateProofVerifier.verifyProof(proof, trustedLedgerHeaderHash);
    }

    function verifyBatchedProof(
        PactumStateProofVerifier.BatchedStateProof calldata batch,
        bytes32 trustedLedgerHeaderHash
    ) external pure returns (bool isValid, uint256 entryCount) {
        return PactumStateProofVerifier.verifyBatchedProof(batch, trustedLedgerHeaderHash);
    }
}

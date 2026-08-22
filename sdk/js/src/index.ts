/**
 * @pactum/sdk — TypeScript client for the Pactum commitment registry.
 *
 * @example
 * import { PactumClient, CommitmentStatus } from '@pactum/sdk';
 *
 * const client = new PactumClient({ network: 'testnet' });
 *
 * const id = await client.createCommitment({ issuer, issuerSecret, counterparty, termsHash, dueAt });
 * await client.attest({ caller, callerSecret, id, outcome: CommitmentStatus.Fulfilled });
 * await client.dispute({ caller, callerSecret, id });
 * await client.resolveDispute({ arbitrator, arbitratorSecret, id, finalOutcome: CommitmentStatus.Breached });
 * const rep  = await client.getReputation(address);
 * const cmmt = await client.getCommitment(id);
 */

export { PactumClient } from './client.js';
export { CommitmentStatus } from './types.js';
export type {
  Commitment,
  CommitmentStatus as CommitmentStatusType,
  CreateCommitmentParams,
  AttestParams,
  DisputeParams,
  PactumClientConfig,
  Reputation,
  ResolveDisputeParams,
  Network,
} from './types.js';

/** Canonical deployed contract address on Stellar testnet. */
export { DEFAULT_CONTRACT_ID } from './networks.js';

// Zero-Trust State Proof Verifier
export {
  verifyPactumStateProof,
  verifyPactumBatchedStateProof,
  computeLeafHash,
  computeMerkleRoot,
  computeMerkleRootFromLeaves,
  computeHeaderHash,
  computeAggregationLeaf,
  addressToBytes32,
  bytesToHex,
  hexToBytes,
  normalizeHex32,
  BATCH_PROOF_VERSION,
} from './verifier/stateProofVerifier.js';

export type {
  PactumStateProof,
  PactumBatchedStateProof,
  BatchedProofEntry,
  ScoreData,
  MerkleProofNode,
  HeaderProof,
  VerificationResult,
  BatchVerificationResult,
} from './verifier/stateProofVerifier.js';

import { verifyPactumStateProof } from './stateProofVerifier';
import { fetchReputationProof, type Reputation } from './api';
import {
  DEFAULT_CONTRACT_ID,
  DEFAULT_NETWORK_PASSPHRASE,
  fetchLatestLedgerAnchor,
  fetchReputationFromRpc,
} from '@pactum/soroban-client';

export type ReputationIntegrity = 'verified' | 'rpc-fallback';

export interface VerifiedReputationResult {
  reputation: Reputation;
  integrity: ReputationIntegrity;
  ledgerSequence?: number;
  warning?: string;
}

function reputationFromProof(
  address: string,
  proof: Awaited<ReturnType<typeof fetchReputationProof>>,
) {
  const { fulfilledCount, lateCount, breachedCount } = proof.scoreData;
  return {
    address,
    fulfilled: fulfilledCount,
    late: lateCount,
    breached: breachedCount,
    total: fulfilledCount + lateCount + breachedCount,
  };
}

export async function fetchVerifiedReputation(
  address: string,
  signal?: AbortSignal,
): Promise<VerifiedReputationResult> {
  let failureReason = 'The backend proof could not be verified.';

  try {
    const [proof, trustedLedger] = await Promise.all([
      fetchReputationProof(address, signal),
      fetchLatestLedgerAnchor(),
    ]);

    if (signal?.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }

    const expectedContractId = import.meta.env.VITE_PACTUM_CONTRACT_ID || DEFAULT_CONTRACT_ID;
    const expectedNetwork =
      import.meta.env.VITE_STELLAR_NETWORK_PASSPHRASE || DEFAULT_NETWORK_PASSPHRASE;

    if (proof.stellarAddress !== address) {
      throw new Error('Proof address does not match the requested account');
    }
    if (proof.contractId !== expectedContractId) {
      throw new Error('Proof contract does not match the configured Pactum contract');
    }
    if (proof.networkPassphrase !== expectedNetwork) {
      throw new Error('Proof network does not match the configured Stellar network');
    }
    if (proof.ledgerSeq !== trustedLedger.sequence) {
      throw new Error(
        `Proof ledger ${proof.ledgerSeq} is not the latest trusted ledger ${trustedLedger.sequence}`,
      );
    }

    const verification = verifyPactumStateProof(proof, trustedLedger.hash);
    if (!verification.valid) {
      throw new Error(verification.error || 'Merkle proof verification failed');
    }

    return {
      reputation: reputationFromProof(address, proof),
      integrity: 'verified',
      ledgerSequence: proof.ledgerSeq,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    failureReason = error instanceof Error ? error.message : failureReason;
  }

  try {
    const reputation = await fetchReputationFromRpc(address);
    return {
      reputation,
      integrity: 'rpc-fallback',
      warning:
        `Critical security warning: indexed data was rejected (${failureReason}). ` +
        'Showing reputation read directly from Soroban RPC; indexed commitment history is hidden.',
    };
  } catch (fallbackError) {
    throw new Error(
      `State proof verification failed and direct Soroban fallback failed: ${
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      }`,
    );
  }
}

/**
 * Off-chain verification.
 *
 * Checking the pairing equation is only half the job. A Groth16 proof says "these
 * public signals satisfy the circuit" — it says nothing about whether those signals
 * are the ones the verifier cares about. A verifier that calls `groth16.verify` and
 * stops there will happily accept a valid proof against a stale root, a threshold of
 * 0, or another DAO's context. `verifyTrustThresholdProof` checks both halves.
 */

import * as snarkjs from 'snarkjs';

import type { Groth16Proof } from './prove.ts';

/**
 * Public signal layout, in the order circom emits it: outputs first, then public
 * inputs in declaration order. Asserted against a real proof in `test/circuit.test.ts`.
 */
export const PUBLIC_SIGNAL_ORDER = ['aboveThreshold', 'root', 'threshold', 'contextId'] as const;

export interface PublicSignals {
  aboveThreshold: bigint;
  root: bigint;
  threshold: bigint;
  contextId: bigint;
}

export interface VerificationKey {
  protocol: string;
  curve: string;
  nPublic: number;
  [key: string]: unknown;
}

export interface VerifyRequest {
  proof: Groth16Proof;
  publicSignals: string[];
  verificationKey: VerificationKey;
  /** The snapshot root the verifier is willing to accept. */
  expectedRoot: bigint;
  /** The lowest threshold that earns the right being granted. */
  minThreshold: bigint;
  /** The verifier's own context identifier. */
  expectedContextId: bigint;
}

export type VerificationResult =
  { valid: true; signals: PublicSignals } | { valid: false; reason: string };

/** Destructures raw public signals into named values. */
export function parsePublicSignals(publicSignals: string[]): PublicSignals {
  if (publicSignals.length !== PUBLIC_SIGNAL_ORDER.length) {
    throw new Error(
      `Expected ${PUBLIC_SIGNAL_ORDER.length} public signals, got ${publicSignals.length}`,
    );
  }

  const [aboveThreshold, root, threshold, contextId] = publicSignals.map(BigInt);
  return { aboveThreshold, root, threshold, contextId };
}

/**
 * Verifies a Trust Score threshold proof and the claim it is being used to make.
 *
 * Returns a reason instead of throwing so a caller can log or surface which check
 * failed without conflating a malformed submission with a cryptographically invalid one.
 */
export async function verifyTrustThresholdProof(
  request: VerifyRequest,
): Promise<VerificationResult> {
  const { proof, publicSignals, verificationKey } = request;

  let signals: PublicSignals;
  try {
    signals = parsePublicSignals(publicSignals);
  } catch (error) {
    return { valid: false, reason: (error as Error).message };
  }

  // Cheap semantic checks first: they reject the common mistakes without paying for
  // a pairing check, and every one of them is required for the proof to mean anything.
  if (signals.aboveThreshold !== 1n) {
    return { valid: false, reason: 'Proof does not assert that the score is above the threshold' };
  }
  if (signals.root !== request.expectedRoot) {
    return { valid: false, reason: 'Proof is against a different reputation snapshot root' };
  }
  if (signals.threshold < request.minThreshold) {
    return {
      valid: false,
      reason: `Proven threshold ${signals.threshold} is below the required ${request.minThreshold}`,
    };
  }
  if (signals.contextId !== request.expectedContextId) {
    return { valid: false, reason: 'Proof was generated for a different context' };
  }

  const cryptographicallyValid = await snarkjs.groth16.verify(
    verificationKey,
    publicSignals,
    proof,
  );
  if (!cryptographicallyValid) {
    return { valid: false, reason: 'Groth16 verification failed' };
  }

  return { valid: true, signals };
}

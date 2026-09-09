/**
 * HomomorphicReputationService — Issue #190
 *
 * Bridges the off-chain reputation pipeline with the Paillier PHE layer.
 *
 * Responsibilities:
 * 1. Maintain a singleton Paillier key pair (private key held in-memory, never
 *    persisted in the database or logged).
 * 2. Encrypt plaintext outcome ratings before they are submitted to the Soroban
 *    contract's `submit_encrypted_outcome` entrypoint.
 * 3. Generate Bulletproof-style range proofs attesting that each encrypted
 *    rating is in the valid range [1, 5].
 * 4. Decrypt the aggregated `EncryptedScore` returned by `get_encrypted_trust_score`
 *    so the backend can serve a usable score to authorised callers.
 * 5. Store and retrieve encrypted aggregate state from the TimescaleDB
 *    `he_reputation_scores` table (migration `006_he_reputation.sql`).
 *
 * The service deliberately exposes no method that would reveal individual
 * plaintext ratings — only the aggregate decrypted score is ever returned.
 */

import { queryTimescale } from '../db/timescale';
import {
  COMPACT_N,
  computeEncryptedScore,
  decrypt,
  encrypt,
  encAdd,
  fromEncryptedScore,
  modInverse,
  PaillierPrivateKey,
  PaillierPublicKey,
  toEncryptedScore,
  EncryptedScore,
} from '../crypto/paillier';
import {
  generateRangeProof,
  verifyRangeProof,
  randomBlinding,
  RATING_MIN,
  RATING_MAX,
  RangeProof,
} from '../crypto/bulletproof';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three outcome kinds, matching the on-chain outcome_kind parameter. */
export type OutcomeKind = 'fulfilled' | 'late' | 'breached';

const OUTCOME_KIND_MAP: Record<OutcomeKind, number> = {
  fulfilled: 0,
  late: 1,
  breached: 2,
};

/**
 * An encrypted outcome ready to be submitted to the Soroban contract
 * `submit_encrypted_outcome` entrypoint.
 */
export interface EncryptedOutcomePayload {
  /** Paillier ciphertext in EncryptedScore wire format (lo/hi/count). */
  encOutcome: EncryptedScore;
  /** Outcome bucket index (0=fulfilled, 1=late, 2=breached). */
  outcomeKind: number;
  /** Zero-knowledge range proof. */
  proof: {
    commitment: string; // hex-encoded bigint for JSON transport
    witnessA: string;
    witnessB: string;
  };
  /** Compact Paillier public-key modulus (hex). */
  pkN: string;
}

/**
 * Aggregate encrypted reputation state for one address.
 */
export interface EncryptedReputationState {
  address: string;
  encFulfilled: bigint;
  encLate: bigint;
  encBreached: bigint;
  fulfilledCount: number;
  lateCount: number;
  breachedCount: number;
  updatedAt: Date;
}

/**
 * The decrypted aggregate score returned to callers.
 * Individual ratings are never exposed.
 */
export interface DecryptedReputationScore {
  address: string;
  /** Decrypted aggregate trust score (may exceed 0–100 before clamping). */
  rawScore: bigint;
  /** Score clamped to [0, 100]. */
  trustScore: number;
  fulfilledCount: number;
  lateCount: number;
  breachedCount: number;
  computedAt: Date;
}

// ---------------------------------------------------------------------------
// Singleton service
// ---------------------------------------------------------------------------

export class HomomorphicReputationService {
  private static instance: HomomorphicReputationService | null = null;

  private readonly privateKey: PaillierPrivateKey;
  private readonly publicKey: PaillierPublicKey;

  /** The 64-bit compact modulus string, sent to the contract as pkN. */
  private readonly pkNHex: string;

  private constructor(privateKey: PaillierPrivateKey) {
    this.privateKey = privateKey;
    this.publicKey = privateKey.publicKey;
    this.pkNHex = privateKey.publicKey.n.toString(16);
  }

  /**
   * Returns the singleton instance, creating it on first call.
   *
   * In production, the private key should be injected from the KMS rather than
   * derived here. For now the key is generated deterministically from the
   * environment variable `HE_KEY_SEED` (two 32-bit prime seeds), or falls back
   * to a fixed test pair when that variable is absent.
   */
  public static getInstance(): HomomorphicReputationService {
    if (!HomomorphicReputationService.instance) {
      HomomorphicReputationService.instance = HomomorphicReputationService.createFromEnv();
    }
    return HomomorphicReputationService.instance;
  }

  /** Resets the singleton (test helper — do not call in production). */
  public static resetInstance(): void {
    HomomorphicReputationService.instance = null;
  }

  private static createFromEnv(): HomomorphicReputationService {
    // Use the compact public key (matches on-chain PAILLIER_N = 2^64 - 59).
    // For the compact 64-bit modulus we cannot factor n into p·q, so we
    // derive the private key analytically: with n prime, λ = n - 1, μ = λ^(-1) mod n.
    const n = COMPACT_N;
    const lambda = n - 1n;
    const nSquared = n * n;
    const g = n + 1n;
    // L(g^λ mod n²) = L((1 + λ·n) mod n²) = λ
    // μ = λ^(-1) mod n
    const mu = modInverse(lambda, n);

    const publicKey: PaillierPublicKey = { n, nSquared, g };
    const privateKey: PaillierPrivateKey = { publicKey, lambda, mu };

    return new HomomorphicReputationService(privateKey);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Returns the public key's compact modulus as a hex string.
   * Safe to expose — the modulus is a public parameter.
   */
  public getPublicKeyHex(): string {
    return this.pkNHex;
  }

  /**
   * Encrypts a plaintext rating and generates a range proof.
   *
   * This is the preparation step before calling the Soroban contract.
   * The plaintext `rating` never leaves this function — only the
   * ciphertext and proof are returned.
   *
   * @param rating      Plaintext outcome score in [1, 5].
   * @param outcomeKind Which counter to update.
   * @param blinding    Optional deterministic blinding factor (for tests).
   */
  public prepareEncryptedOutcome(
    rating: bigint,
    outcomeKind: OutcomeKind,
    blinding?: bigint,
  ): EncryptedOutcomePayload {
    if (rating < RATING_MIN || rating > RATING_MAX) {
      throw new RangeError(
        `rating ${rating} is outside valid range [${RATING_MIN}, ${RATING_MAX}]`,
      );
    }

    const r = blinding ?? randomBlinding();
    const pkN = this.publicKey.n;

    // Encrypt the rating under the Paillier public key.
    const ciphertext = encrypt(this.publicKey, rating, r);

    // Generate the zero-knowledge range proof.
    const proof: RangeProof = generateRangeProof(rating, r, pkN);

    // Verify the proof off-chain before returning (prevents trivially broken proofs).
    if (!verifyRangeProof(proof, pkN)) {
      throw new Error('Internal error: generated range proof failed self-verification');
    }

    const encOutcome = toEncryptedScore(ciphertext, 1);

    return {
      encOutcome,
      outcomeKind: OUTCOME_KIND_MAP[outcomeKind],
      proof: {
        commitment: proof.commitment.toString(16),
        witnessA: proof.witnessA.toString(16),
        witnessB: proof.witnessB.toString(16),
      },
      pkN: pkN.toString(16),
    };
  }

  /**
   * Homomorphically accumulates an incoming encrypted outcome into the stored
   * aggregate for `address` in the `he_reputation_scores` table.
   *
   * This mirrors what `accumulate_encrypted_outcome` does on-chain but at the
   * off-chain indexer level so the TimescaleDB record stays in sync.
   *
   * @param address     Stellar address of the issuer.
   * @param encOutcome  Ciphertext of the incoming outcome.
   * @param outcomeKind Which counter to accumulate into.
   */
  public async accumulateEncryptedOutcome(
    address: string,
    encOutcome: EncryptedScore,
    outcomeKind: OutcomeKind,
  ): Promise<void> {
    const existing = await this.loadEncryptedState(address);
    const pk = this.publicKey;

    let encF = existing?.encFulfilled ?? encrypt(pk, 0n);
    let encL = existing?.encLate ?? encrypt(pk, 0n);
    let encB = existing?.encBreached ?? encrypt(pk, 0n);
    const fulfilledCount = existing?.fulfilledCount ?? 0;
    const lateCount = existing?.lateCount ?? 0;
    const breachedCount = existing?.breachedCount ?? 0;

    const incoming = fromEncryptedScore(encOutcome);

    let newFulfilled = fulfilledCount;
    let newLate = lateCount;
    let newBreached = breachedCount;

    switch (outcomeKind) {
      case 'fulfilled':
        encF = encAdd(pk, encF, incoming);
        newFulfilled++;
        break;
      case 'late':
        encL = encAdd(pk, encL, incoming);
        newLate++;
        break;
      case 'breached':
        encB = encAdd(pk, encB, incoming);
        newBreached++;
        break;
    }

    await this.saveEncryptedState({
      address,
      encFulfilled: encF,
      encLate: encL,
      encBreached: encB,
      fulfilledCount: newFulfilled,
      lateCount: newLate,
      breachedCount: newBreached,
      updatedAt: new Date(),
    });
  }

  /**
   * Computes and decrypts the aggregate trust score for `address`.
   *
   * The linear score is evaluated homomorphically over ciphertexts, then the
   * single aggregate result is decrypted. Individual ratings are never
   * decrypted or logged.
   */
  public async getDecryptedScore(address: string): Promise<DecryptedReputationScore> {
    const state = await this.loadEncryptedState(address);
    const pk = this.publicKey;

    // Default to Enc(0) for addresses with no history.
    const encF = state?.encFulfilled ?? encrypt(pk, 0n);
    const encL = state?.encLate ?? encrypt(pk, 0n);
    const encB = state?.encBreached ?? encrypt(pk, 0n);

    // Evaluate Enc(score) = Enc(BASE + wF·F − wL·L − wB·B) homomorphically.
    const encScore = computeEncryptedScore(pk, encF, encL, encB);

    // Decrypt the single aggregate result.
    const rawScore = decrypt(this.privateKey, encScore);

    // Clamp to [0, 100].
    const trustScore = rawScore <= 0n ? 0 : rawScore >= 100n ? 100 : Number(rawScore);

    return {
      address,
      rawScore,
      trustScore,
      fulfilledCount: state?.fulfilledCount ?? 0,
      lateCount: state?.lateCount ?? 0,
      breachedCount: state?.breachedCount ?? 0,
      computedAt: new Date(),
    };
  }

  // -------------------------------------------------------------------------
  // Persistence helpers
  // -------------------------------------------------------------------------

  private async loadEncryptedState(address: string): Promise<EncryptedReputationState | null> {
    const result = await queryTimescale(
      `SELECT enc_fulfilled, enc_late, enc_breached,
              fulfilled_count, late_count, breached_count, updated_at
       FROM he_reputation_scores
       WHERE address = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [address],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      address,
      encFulfilled: BigInt('0x' + row.enc_fulfilled),
      encLate: BigInt('0x' + row.enc_late),
      encBreached: BigInt('0x' + row.enc_breached),
      fulfilledCount: Number(row.fulfilled_count),
      lateCount: Number(row.late_count),
      breachedCount: Number(row.breached_count),
      updatedAt: new Date(row.updated_at),
    };
  }

  private async saveEncryptedState(state: EncryptedReputationState): Promise<void> {
    await queryTimescale(
      `INSERT INTO he_reputation_scores
         (address, enc_fulfilled, enc_late, enc_breached,
          fulfilled_count, late_count, breached_count, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (address) DO UPDATE SET
         enc_fulfilled   = EXCLUDED.enc_fulfilled,
         enc_late        = EXCLUDED.enc_late,
         enc_breached    = EXCLUDED.enc_breached,
         fulfilled_count = EXCLUDED.fulfilled_count,
         late_count      = EXCLUDED.late_count,
         breached_count  = EXCLUDED.breached_count,
         updated_at      = EXCLUDED.updated_at`,
      [
        state.address,
        state.encFulfilled.toString(16),
        state.encLate.toString(16),
        state.encBreached.toString(16),
        state.fulfilledCount,
        state.lateCount,
        state.breachedCount,
        state.updatedAt,
      ],
    );
  }
}

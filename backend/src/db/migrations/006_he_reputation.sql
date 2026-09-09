-- Migration 005: Homomorphic Encryption Layer for Privacy-Preserving Reputation Scoring
-- Issue #190
--
-- Adds the `he_reputation_scores` table that stores Paillier-encrypted aggregate
-- outcome counts per address.  The three `enc_*` columns hold the ciphertext as
-- a hex string (variable length, up to 512 hex chars for a 2048-bit modulus).
-- The plaintext counts are retained so the service can reconstruct running totals
-- without decrypting the ciphertext on every write.
--
-- No existing columns are altered; this migration is purely additive.

CREATE TABLE IF NOT EXISTS he_reputation_scores (
    -- Stellar address of the issuer (G... or C... format, 56 chars).
    address         VARCHAR(255) PRIMARY KEY,

    -- Paillier ciphertext of the homomorphically aggregated fulfilled-outcome count.
    -- Stored as a lowercase hex string.  Empty string represents Enc(0) = '1'.
    enc_fulfilled   TEXT NOT NULL DEFAULT '1',

    -- Paillier ciphertext of the homomorphically aggregated late-outcome count.
    enc_late        TEXT NOT NULL DEFAULT '1',

    -- Paillier ciphertext of the homomorphically aggregated breached-outcome count.
    enc_breached    TEXT NOT NULL DEFAULT '1',

    -- Running count of plaintext fulfilled outcomes accumulated (used for averaging).
    fulfilled_count INTEGER NOT NULL DEFAULT 0,

    -- Running count of plaintext late outcomes accumulated.
    late_count      INTEGER NOT NULL DEFAULT 0,

    -- Running count of plaintext breached outcomes accumulated.
    breached_count  INTEGER NOT NULL DEFAULT 0,

    -- Timestamp of the most recent update (used for ordering in the service's
    -- SELECT … ORDER BY updated_at DESC LIMIT 1 query).
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Range proofs submitted with each outcome are stored for auditability.
-- The on-chain verifier already gates acceptance, but keeping the proofs
-- off-chain enables post-hoc audit without re-running the contract.
CREATE TABLE IF NOT EXISTS he_range_proof_log (
    id              BIGSERIAL PRIMARY KEY,

    -- Stellar address that submitted this outcome.
    address         VARCHAR(255) NOT NULL,

    -- Outcome kind: 0=fulfilled, 1=late, 2=breached.
    outcome_kind    SMALLINT NOT NULL CHECK (outcome_kind IN (0, 1, 2)),

    -- Paillier public-key modulus used (hex).
    pk_n            TEXT NOT NULL,

    -- Pedersen commitment C = g^v · h^r mod p (hex).
    commitment      TEXT NOT NULL,

    -- Fiat–Shamir witness scalars (hex).
    witness_a       TEXT NOT NULL,
    witness_b       TEXT NOT NULL,

    -- Whether the on-chain verifier accepted this proof.
    verified        BOOLEAN NOT NULL DEFAULT TRUE,

    submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_he_reputation_scores_updated_at
    ON he_reputation_scores (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_he_range_proof_log_address
    ON he_range_proof_log (address, submitted_at DESC);

-- Migration 006: Encrypted payloads table
-- Stores AES-GCM encrypted commitment terms (base64url blobs).
-- The backend is a dumb blob store — it never decrypts this data.
-- Decryption happens entirely in the browser via sign-to-derive key exchange.

CREATE TABLE IF NOT EXISTS encrypted_payloads (
  id            SERIAL       PRIMARY KEY,
  commitment_id VARCHAR(255) NOT NULL UNIQUE,
  issuer        VARCHAR(255) NOT NULL,
  counterparty  VARCHAR(255) NOT NULL,
  -- base64url(IV[12] || AES-GCM-ciphertext || auth-tag[16])
  -- max ~64 KB for safety; typical terms are a few hundred bytes
  ciphertext    TEXT         NOT NULL CHECK (length(ciphertext) > 0 AND length(ciphertext) <= 65536),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Primary lookup: commitment_id -> ciphertext blob
CREATE INDEX IF NOT EXISTS idx_encrypted_payloads_commitment_id
  ON encrypted_payloads (commitment_id);

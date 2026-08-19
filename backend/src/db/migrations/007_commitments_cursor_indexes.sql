-- Migration: 005_commitments_cursor_indexes.sql
-- Add template column and composite indexes for high-performance cursor-based pagination and filtering

ALTER TABLE commitment_outcomes ADD COLUMN IF NOT EXISTS template VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_commitments_cursor_keyset
ON commitment_outcomes (party_a, party_b, status, template, time DESC, commitment_id DESC);

CREATE INDEX IF NOT EXISTS idx_commitments_time_id_desc
ON commitment_outcomes (time DESC, commitment_id DESC);

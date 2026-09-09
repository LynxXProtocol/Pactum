-- Migration: 007_commitments_cursor_indexes.sql
-- Add template column and composite indexes for high-performance cursor-based pagination and filtering

ALTER TABLE commitment_outcomes ADD COLUMN IF NOT EXISTS template VARCHAR(50);

-- commitment_outcomes is a TimescaleDB hypertable (see 001_timescale_setup.sql) -- TimescaleDB
-- rejects CONCURRENTLY on hypertable index creation outright ("hypertables do not support
-- concurrent index creation"), and it can't run inside a transaction block anyway, which is how
-- runMigrations applies each file. Matches the plain CREATE INDEX IF NOT EXISTS style the table's
-- other indexes already use in 001_timescale_setup.sql.
CREATE INDEX IF NOT EXISTS idx_commitments_cursor_keyset
ON commitment_outcomes (party_a, party_b, status, template, time DESC, commitment_id DESC);

CREATE INDEX IF NOT EXISTS idx_commitments_time_id_desc
ON commitment_outcomes (time DESC, commitment_id DESC);

CREATE INDEX IF NOT EXISTS idx_commitments_party_a_time_id
ON commitment_outcomes (party_a, time DESC, commitment_id DESC);

CREATE INDEX IF NOT EXISTS idx_commitments_party_b_time_id
ON commitment_outcomes (party_b, time DESC, commitment_id DESC);

CREATE INDEX IF NOT EXISTS idx_commitments_status_time_id
ON commitment_outcomes (status, time DESC, commitment_id DESC);

CREATE INDEX IF NOT EXISTS idx_commitments_template_time_id
ON commitment_outcomes (template, time DESC, commitment_id DESC);

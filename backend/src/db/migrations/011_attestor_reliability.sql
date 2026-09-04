-- Issue #63: Dynamic Attestor Reputation & Algorithmic Discovery
--
-- Backs the attestor "reliability score" and the discovery engine. The indexer
-- projects on-chain events into these tables:
--   * attestor_votes           <- `votecast`   (attestor cast a vote)
--   * attestor_dispute_outcomes<- `voteres`/`votefall` (final outcome = overturn signal)
--   * attestor_assignments     <- `disputed`   (panel membership read from get_commitment)
--   * attestor_registry        <- `staked`/`unstaked` (availability + fee/domain, off-chain)
--
-- `vw_attestor_reliability` rolls the raw facts into the metrics the API serves.

CREATE TABLE IF NOT EXISTS attestor_registry (
  attestor      TEXT PRIMARY KEY,
  fee           BIGINT NOT NULL DEFAULT 0,
  domains       TEXT[] NOT NULL DEFAULT '{}',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  staked        BIGINT NOT NULL DEFAULT 0,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attestor_assignments (
  commitment_id TEXT NOT NULL,
  attestor      TEXT NOT NULL,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (commitment_id, attestor)
);

CREATE TABLE IF NOT EXISTS attestor_votes (
  commitment_id   TEXT NOT NULL,
  attestor        TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  voted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ledger_sequence BIGINT NOT NULL,
  PRIMARY KEY (commitment_id, attestor)
);

CREATE TABLE IF NOT EXISTS attestor_dispute_outcomes (
  commitment_id   TEXT PRIMARY KEY,
  final_outcome   TEXT NOT NULL,
  resolution_type TEXT NOT NULL,
  resolved_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attestor_votes_attestor ON attestor_votes (attestor);
CREATE INDEX IF NOT EXISTS idx_attestor_assignments_attestor ON attestor_assignments (attestor);
CREATE INDEX IF NOT EXISTS idx_attestor_registry_active ON attestor_registry (active, staked);

CREATE OR REPLACE VIEW vw_attestor_reliability AS
WITH all_attestors AS (
  SELECT attestor FROM attestor_registry
  UNION
  SELECT attestor FROM attestor_assignments
  UNION
  SELECT attestor FROM attestor_votes
),
assigned AS (
  SELECT attestor, COUNT(*) AS total_assigned
  FROM attestor_assignments
  GROUP BY attestor
),
cast_votes AS (
  SELECT attestor, COUNT(*) AS votes_cast
  FROM attestor_votes
  GROUP BY attestor
),
overturned AS (
  SELECT v.attestor, COUNT(*) AS overturned
  FROM attestor_votes v
  JOIN attestor_dispute_outcomes d ON d.commitment_id = v.commitment_id
  WHERE d.final_outcome <> v.outcome
  GROUP BY v.attestor
)
SELECT
  a.attestor,
  COALESCE(assigned.total_assigned, 0)::bigint            AS total_assigned,
  COALESCE(cast_votes.votes_cast, 0)::bigint              AS votes_cast,
  COALESCE(overturned.overturned, 0)::bigint              AS overturned,
  CASE
    WHEN COALESCE(assigned.total_assigned, 0) > 0
    THEN COALESCE(cast_votes.votes_cast, 0)::float / assigned.total_assigned
    ELSE 0
  END                                                    AS uptime_ratio,
  CASE
    WHEN COALESCE(cast_votes.votes_cast, 0) > 0
    THEN (COALESCE(cast_votes.votes_cast, 0) - COALESCE(overturned.overturned, 0))::float
         / cast_votes.votes_cast
    ELSE 0
  END                                                    AS accuracy_ratio,
  CASE
    WHEN COALESCE(assigned.total_assigned, 0) > 0
    THEN (COALESCE(cast_votes.votes_cast, 0) - COALESCE(overturned.overturned, 0))::float
         / assigned.total_assigned
    ELSE 0
  END                                                    AS successful_resolutions_ratio
FROM all_attestors a
LEFT JOIN assigned  ON assigned.attestor  = a.attestor
LEFT JOIN cast_votes ON cast_votes.attestor = a.attestor
LEFT JOIN overturned ON overturned.attestor = a.attestor;

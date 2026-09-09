-- Drop cron-populated snapshot table and legacy mv_* views
DROP TABLE IF EXISTS reputation_snapshots;
DROP MATERIALIZED VIEW IF EXISTS mv_daily_fulfillment_rates;
DROP MATERIALIZED VIEW IF EXISTS mv_weekly_fulfillment_rates;
DROP MATERIALIZED VIEW IF EXISTS mv_monthly_fulfillment_rates;
DROP MATERIALIZED VIEW IF EXISTS mv_trust_score_trends;
DROP MATERIALIZED VIEW IF EXISTS mv_moving_averages;

-- Daily fulfillment rates per address
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_fulfillment_rates_cagg
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', time)              AS bucket,
  party_a                                 AS address,
  COUNT(*) FILTER (WHERE outcome = 'fulfilled')  AS fulfilled,
  COUNT(*) FILTER (WHERE outcome = 'late')       AS late,
  COUNT(*) FILTER (WHERE outcome = 'breached')   AS breached,
  COUNT(*)                                AS total
FROM commitment_outcomes
GROUP BY bucket, party_a
WITH NO DATA;

-- Weekly and monthly variants (same shape, wider bucket)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_weekly_fulfillment_rates_cagg
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 week', time)             AS bucket,
  party_a                                 AS address,
  COUNT(*) FILTER (WHERE outcome = 'fulfilled')  AS fulfilled,
  COUNT(*) FILTER (WHERE outcome = 'late')       AS late,
  COUNT(*) FILTER (WHERE outcome = 'breached')   AS breached,
  COUNT(*)                                AS total
FROM commitment_outcomes
GROUP BY bucket, party_a
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_monthly_fulfillment_rates_cagg
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 month', time)            AS bucket,
  party_a                                 AS address,
  COUNT(*) FILTER (WHERE outcome = 'fulfilled')  AS fulfilled,
  COUNT(*) FILTER (WHERE outcome = 'late')       AS late,
  COUNT(*) FILTER (WHERE outcome = 'breached')   AS breached,
  COUNT(*)                                AS total
FROM commitment_outcomes
GROUP BY bucket, party_a
WITH NO DATA;

-- Canonical daily snapshot (replaces reputation_snapshots table)
CREATE MATERIALIZED VIEW IF NOT EXISTS reputation_snapshots_daily
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', time)              AS bucket,
  party_a                                 AS address,
  COUNT(*) FILTER (WHERE outcome = 'fulfilled')  AS fulfilled_count,
  COUNT(*) FILTER (WHERE outcome = 'late')       AS late_count,
  COUNT(*) FILTER (WHERE outcome = 'breached')   AS breached_count,
  COUNT(*)                                AS total_count,
  ROUND(
    COUNT(*) FILTER (WHERE outcome = 'fulfilled')::NUMERIC / NULLIF(COUNT(*), 0) * 100,
    2
  )                                       AS fulfillment_rate_pct
FROM commitment_outcomes
GROUP BY bucket, party_a
WITH NO DATA;

-- CAAG over trust_score_snapshots
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_trust_score_trends_cagg
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', time)              AS bucket,
  address,
  AVG(trust_score)                        AS avg_score,
  MIN(trust_score)                        AS min_score,
  MAX(trust_score)                        AS max_score,
  LAST(trust_score, time)                 AS latest_score
FROM trust_score_snapshots
GROUP BY bucket, address
WITH NO DATA;

-- Refresh policies
SELECT add_continuous_aggregate_policy('reputation_snapshots_daily',
  start_offset => INTERVAL '3 days',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');

SELECT add_continuous_aggregate_policy('mv_daily_fulfillment_rates_cagg',
  start_offset => INTERVAL '3 days',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');

SELECT add_continuous_aggregate_policy('mv_weekly_fulfillment_rates_cagg',
  start_offset => INTERVAL '2 months',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');

SELECT add_continuous_aggregate_policy('mv_monthly_fulfillment_rates_cagg',
  start_offset => INTERVAL '2 years',
  end_offset   => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day');

SELECT add_continuous_aggregate_policy('mv_trust_score_trends_cagg',
  start_offset => INTERVAL '3 days',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');

-- Retention policies
SELECT add_retention_policy('commitment_outcomes',    INTERVAL '90 days');
SELECT add_retention_policy('trust_score_snapshots',  INTERVAL '90 days');

-- No initial CALL refresh_continuous_aggregate(...) backfill here: runMigrations (timescale.ts)
-- applies every migration inside BEGIN/COMMIT, and TimescaleDB refuses to run
-- refresh_continuous_aggregate() inside a transaction block at all, so this file could never
-- succeed with an eager backfill included. The add_continuous_aggregate_policy calls above
-- already schedule the first refresh within their schedule_interval (as little as 1 minute), so
-- this only delays population, not correctness.

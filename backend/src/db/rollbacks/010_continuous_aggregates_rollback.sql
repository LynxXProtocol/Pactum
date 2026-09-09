-- Inverse of 010_continuous_aggregates.sql
-- Removes continuous aggregates and restores cron-populated table and old materialized views
--
-- NOT auto-applied: runMigrations (backend/src/db/timescale.ts) only scans
-- src/db/migrations/*.sql, and this file previously lived there, where it was picked up and
-- executed as the very next "migration" immediately after 010_continuous_aggregates.sql --
-- undoing it on every fresh migrate:timescale run and deadlocking against 010's own
-- freshly-scheduled continuous aggregate policies. Apply manually with `psql -f` if 010 needs
-- to be rolled back.

-- 1. Remove refresh and retention policies
SELECT remove_continuous_aggregate_policy('reputation_snapshots_daily', if_exists => true);
SELECT remove_continuous_aggregate_policy('mv_daily_fulfillment_rates_cagg', if_exists => true);
SELECT remove_continuous_aggregate_policy('mv_weekly_fulfillment_rates_cagg', if_exists => true);
SELECT remove_continuous_aggregate_policy('mv_monthly_fulfillment_rates_cagg', if_exists => true);
SELECT remove_continuous_aggregate_policy('mv_trust_score_trends_cagg', if_exists => true);

SELECT remove_retention_policy('commitment_outcomes', if_exists => true);
SELECT remove_retention_policy('trust_score_snapshots', if_exists => true);

-- 2. Drop continuous aggregates
DROP MATERIALIZED VIEW IF EXISTS reputation_snapshots_daily;
DROP MATERIALIZED VIEW IF EXISTS mv_daily_fulfillment_rates_cagg;
DROP MATERIALIZED VIEW IF EXISTS mv_weekly_fulfillment_rates_cagg;
DROP MATERIALIZED VIEW IF EXISTS mv_monthly_fulfillment_rates_cagg;
DROP MATERIALIZED VIEW IF EXISTS mv_trust_score_trends_cagg;

-- 3. Restore reputation_snapshots table (from 004_reputation_snapshots.sql)
CREATE TABLE IF NOT EXISTS reputation_snapshots (
    day DATE NOT NULL,
    address VARCHAR(255) NOT NULL,
    fulfilled INTEGER NOT NULL DEFAULT 0,
    late INTEGER NOT NULL DEFAULT 0,
    breached INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (address, day)
);

CREATE INDEX IF NOT EXISTS idx_reputation_snapshots_address_day
    ON reputation_snapshots (address, day DESC);

-- 4. Restore old materialized views (from 002_materialized_views.sql)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_fulfillment_rates AS
SELECT 
    time_bucket('1 day', time) AS day,
    COUNT(*) AS total_commitments,
    COUNT(*) FILTER (WHERE outcome = 'fulfilled') AS total_fulfilled,
    COUNT(*) FILTER (WHERE outcome = 'late') AS total_late,
    COUNT(*) FILTER (WHERE outcome = 'breached') AS total_breached,
    COUNT(*) FILTER (WHERE outcome = 'disputed') AS total_disputed,
    ROUND(
        (COUNT(*) FILTER (WHERE outcome = 'fulfilled')::DECIMAL / NULLIF(COUNT(*), 0)) * 100, 
        2
    ) AS fulfillment_rate,
    ROUND(
        (COUNT(*) FILTER (WHERE outcome = 'breached')::DECIMAL / NULLIF(COUNT(*), 0)) * 100, 
        2
    ) AS breach_rate,
    COUNT(DISTINCT party_a) + COUNT(DISTINCT party_b) - COUNT(DISTINCT CASE WHEN party_a = party_b THEN party_a END) AS unique_addresses,
    COALESCE(SUM(amount), 0) AS total_volume
FROM commitment_outcomes
GROUP BY time_bucket('1 day', time)
ORDER BY day DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_daily_fulfillment_rates_day ON mv_daily_fulfillment_rates (day);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_weekly_fulfillment_rates AS
SELECT 
    time_bucket('1 week', time) AS week,
    COUNT(*) AS total_commitments,
    COUNT(*) FILTER (WHERE outcome = 'fulfilled') AS total_fulfilled,
    COUNT(*) FILTER (WHERE outcome = 'late') AS total_late,
    COUNT(*) FILTER (WHERE outcome = 'breached') AS total_breached,
    COUNT(*) FILTER (WHERE outcome = 'disputed') AS total_disputed,
    ROUND(
        (COUNT(*) FILTER (WHERE outcome = 'fulfilled')::DECIMAL / NULLIF(COUNT(*), 0)) * 100, 
        2
    ) AS fulfillment_rate,
    ROUND(
        (COUNT(*) FILTER (WHERE outcome = 'breached')::DECIMAL / NULLIF(COUNT(*), 0)) * 100, 
        2
    ) AS breach_rate,
    COUNT(DISTINCT party_a) + COUNT(DISTINCT party_b) - COUNT(DISTINCT CASE WHEN party_a = party_b THEN party_a END) AS unique_addresses,
    COALESCE(SUM(amount), 0) AS total_volume
FROM commitment_outcomes
GROUP BY time_bucket('1 week', time)
ORDER BY week DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_weekly_fulfillment_rates_week ON mv_weekly_fulfillment_rates (week);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_monthly_fulfillment_rates AS
SELECT 
    time_bucket('1 month', time) AS month,
    COUNT(*) AS total_commitments,
    COUNT(*) FILTER (WHERE outcome = 'fulfilled') AS total_fulfilled,
    COUNT(*) FILTER (WHERE outcome = 'late') AS total_late,
    COUNT(*) FILTER (WHERE outcome = 'breached') AS total_breached,
    COUNT(*) FILTER (WHERE outcome = 'disputed') AS total_disputed,
    ROUND(
        (COUNT(*) FILTER (WHERE outcome = 'fulfilled')::DECIMAL / NULLIF(COUNT(*), 0)) * 100, 
        2
    ) AS fulfillment_rate,
    ROUND(
        (COUNT(*) FILTER (WHERE outcome = 'breached')::DECIMAL / NULLIF(COUNT(*), 0)) * 100, 
        2
    ) AS breach_rate,
    COUNT(DISTINCT party_a) + COUNT(DISTINCT party_b) - COUNT(DISTINCT CASE WHEN party_a = party_b THEN party_a END) AS unique_addresses,
    COALESCE(SUM(amount), 0) AS total_volume
FROM commitment_outcomes
GROUP BY time_bucket('1 month', time)
ORDER BY month DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_monthly_fulfillment_rates_month ON mv_monthly_fulfillment_rates (month);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_moving_averages AS
WITH daily_stats AS (
    SELECT 
        time_bucket('1 day', time) AS day,
        COUNT(*) FILTER (WHERE outcome = 'fulfilled')::DECIMAL / NULLIF(COUNT(*), 0) AS daily_fulfillment_rate,
        COUNT(*) FILTER (WHERE outcome = 'breached')::DECIMAL / NULLIF(COUNT(*), 0) AS daily_breach_rate
    FROM commitment_outcomes
    GROUP BY time_bucket('1 day', time)
)
SELECT 
    day,
    daily_fulfillment_rate,
    daily_breach_rate,
    AVG(daily_fulfillment_rate) OVER (
        ORDER BY day 
        RANGE BETWEEN INTERVAL '7 days' PRECEDING AND CURRENT ROW
    ) AS ma_7day_fulfillment_rate,
    AVG(daily_breach_rate) OVER (
        ORDER BY day 
        RANGE BETWEEN INTERVAL '7 days' PRECEDING AND CURRENT ROW
    ) AS ma_7day_breach_rate,
    AVG(daily_fulfillment_rate) OVER (
        ORDER BY day 
        RANGE BETWEEN INTERVAL '30 days' PRECEDING AND CURRENT ROW
    ) AS ma_30day_fulfillment_rate,
    AVG(daily_breach_rate) OVER (
        ORDER BY day 
        RANGE BETWEEN INTERVAL '30 days' PRECEDING AND CURRENT ROW
    ) AS ma_30day_breach_rate,
    AVG(daily_fulfillment_rate) OVER (
        ORDER BY day 
        RANGE BETWEEN INTERVAL '90 days' PRECEDING AND CURRENT ROW
    ) AS ma_90day_fulfillment_rate,
    AVG(daily_breach_rate) OVER (
        ORDER BY day 
        RANGE BETWEEN INTERVAL '90 days' PRECEDING AND CURRENT ROW
    ) AS ma_90day_breach_rate
FROM daily_stats
ORDER BY day DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_moving_averages_day ON mv_moving_averages (day);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_trust_score_trends AS
SELECT 
    time_bucket('1 day', time) AS day,
    AVG(trust_score) AS avg_score,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY trust_score) AS median_trust_score,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY trust_score) AS q25_trust_score,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY trust_score) AS q75_trust_score,
    STDDEV(trust_score) AS stddev_trust_score,
    COUNT(DISTINCT address) AS active_addresses
FROM trust_score_snapshots
GROUP BY time_bucket('1 day', time)
ORDER BY day DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_trust_score_trends_day ON mv_trust_score_trends (day);

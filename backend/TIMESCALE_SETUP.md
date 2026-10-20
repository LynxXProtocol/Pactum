# TimescaleDB Analytics Setup

This document describes the time-series data pipeline for tracking macro-level statistics in the Pactum network.

## Overview

The analytics system uses TimescaleDB (a PostgreSQL extension) to store and analyze time-series data for:

- Trust score snapshots
- Commitment outcomes
- Network-wide statistics
- Moving averages and trends

## Architecture

### Database Schema

#### Hypertables

- `trust_score_snapshots` - Historical trust score data per address
- `commitment_outcomes` - Historical commitment completion data
- `network_daily_stats` - Daily aggregated network statistics

#### Materialized Views

- `mv_daily_fulfillment_rates` - Daily network fulfillment statistics
- `mv_weekly_fulfillment_rates` - Weekly network fulfillment statistics
- `mv_monthly_fulfillment_rates` - Monthly network fulfillment statistics
- `mv_moving_averages` - 7-day, 30-day, and 90-day moving averages
- `mv_trust_score_trends` - Trust score distribution trends

## Setup Instructions

### 1. Install TimescaleDB

#### Docker (Recommended)

```bash
docker run -d \
  --name pactum-timescaledb \
  -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=pactum_timeseries \
  timescale/timescaledb:latest-pg16
```

#### Native Installation

```bash
# Ubuntu/Debian
wget https://repos.timescale.com/_latest.key
sudo apt-key add _latest.key
sudo apt-add-repository 'https://repos.timescale.com/latest/debian/'
sudo apt update
sudo apt install timescaledb-2-postgresql-16

# macOS
brew install timescaledb
```

### 2. Run Migrations

```bash
cd backend
npm run build
node -e "require('./dist/db/timescale').runMigrations()"
```

Or manually run the SQL files:

```bash
psql -h localhost -U postgres -d pactum_timeseries -f src/db/migrations/001_timescale_setup.sql
psql -h localhost -U postgres -d pactum_timeseries -f src/db/migrations/002_materialized_views.sql
```

### 3. Configure Environment

Add to your `.env` file:

```env
TIMESCALEDB_HOST=localhost
TIMESCALEDB_PORT=5432
TIMESCALEDB_DATABASE=pactum_timeseries
TIMESCALEDB_USER=postgres
TIMESCALEDB_PASSWORD=postgres
ANALYTICS_SNAPSHOT_INTERVAL_MS=3600000
MATERIALIZED_VIEW_REFRESH_INTERVAL_MS=300000
```

### 4. Start Analytics Worker

```bash
cd backend
npm run build
node dist/workers/analyticsWorker.js
```

The worker will:

- Take snapshots of network statistics every hour (configurable)
- Refresh materialized views every 5 minutes (configurable)

## API Endpoints

All endpoints are prefixed with `/api/analytics`

### Network Statistics

- `GET /api/analytics/network/daily?days=30` - Daily network stats
- `GET /api/analytics/network/weekly?weeks=52` - Weekly network stats
- `GET /api/analytics/network/monthly?months=24` - Monthly network stats
- `GET /api/analytics/network/moving-averages?days=90` - Moving averages
- `GET /api/analytics/network/trust-trends?days=90` - Trust score trends
- `GET /api/analytics/network/summary` - Current network summary

### Address Statistics

- `GET /api/analytics/address/:address/trust-history?days=30` - Trust score history
- `GET /api/analytics/address/:address/commitments?limit=50` - Commitment outcomes

### Market Analysis

- `GET /api/analytics/breach-rates?period=month` - Breach rate trends

## Performance Optimization

### Query Performance

All materialized views are optimized to return results within 100ms regardless of historical data size:

- Pre-computed aggregations
- Indexed time dimensions
- Efficient time-bucket queries
- Concurrent refresh support

### Data Retention

Consider implementing data retention policies:

```sql
-- Retain 2 years of raw data
SELECT add_retention_policy('trust_score_snapshots', INTERVAL '2 years');
SELECT add_retention_policy('commitment_outcomes', INTERVAL '2 years');

-- Retain 5 years of aggregated data
SELECT add_retention_policy('network_daily_stats', INTERVAL '5 years');
```

## Data Ingestion

### Manual Snapshot

```typescript
import { insertTrustScoreSnapshot, insertCommitmentOutcome } from './workers/timescaleSnapshot';

// Insert trust score snapshot
await insertTrustScoreSnapshot({
  address: 'G...',
  trustScore: 850,
  totalCommitments: 10,
  fulfilledCommitments: 8,
  lateCommitments: 2,
  breachedCommitments: 0,
});

// Insert commitment outcome
await insertCommitmentOutcome({
  commitmentId: 'commitment_123',
  partyA: 'G...',
  partyB: 'G...',
  amount: 100.5,
  currency: 'XLM',
  status: 'completed',
  outcome: 'fulfilled',
  dueDate: new Date('2024-01-01'),
  completedAt: new Date('2024-01-01'),
});
```

### Batch Operations

```typescript
import { batchInsertTrustScores, batchInsertCommitmentOutcomes } from './workers/timescaleSnapshot';

// Batch insert trust scores
await batchInsertTrustScores([
  { address: 'G...', trustScore: 850, ... },
  { address: 'G...', trustScore: 900, ... }
]);

// Batch insert commitment outcomes
await batchInsertCommitmentOutcomes([
  { commitmentId: '1', partyA: 'G...', ... },
  { commitmentId: '2', partyA: 'G...', ... }
]);
```

## Monitoring

### Materialized View Refresh Status

```sql
SELECT * FROM timescaledb_information.materialized_views;
```

### Hypertable Statistics

```sql
SELECT hypertable_name,
       number_chunks,
       total_size
FROM timescaledb_information.hypertables;
```

### Query Performance

```sql
-- Enable query statistics
LOAD 'auto_explain';
SET auto_explain.log_min_duration = 100; -- Log queries > 100ms
```

## Troubleshooting

### Connection Issues

- Verify TimescaleDB is running: `docker ps` or `systemctl status timescaledb`
- Check connection parameters in `.env`
- Test connection: `psql -h localhost -U postgres -d pactum_timeseries`

### Migration Failures

- Ensure TimescaleDB extension is installed: `CREATE EXTENSION IF NOT EXISTS timescaledb;`
- Check PostgreSQL version compatibility (requires PostgreSQL 12+)
- Review migration logs for specific errors

### Slow Queries

- Check materialized view refresh status
- Verify indexes are created
- Consider increasing refresh interval
- Use `EXPLAIN ANALYZE` to analyze query plans

## Integration with Main Application

The analytics system is designed to run alongside the main PostgreSQL database:

- Main database: Transactional data (current state)
- TimescaleDB: Historical analytics (time-series data)

The indexer should:

1. Write commitment outcomes to both databases
2. Periodically snapshot trust scores to TimescaleDB
3. Trigger analytics worker for materialized view refreshes

## Security Considerations

- Use environment variables for database credentials
- Implement connection pooling (already configured)
- Restrict database user permissions
- Use SSL connections in production
- Regular backups of TimescaleDB data

## Future Enhancements

- Real-time continuous aggregates
- Downsampling for older data
- Automated data retention policies
- Alert system for anomaly detection
- Integration with external monitoring tools

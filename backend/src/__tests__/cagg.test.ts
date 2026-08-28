import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../db/timescale';
import { PostgresReputationRepository } from '../reputation/repository';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('TimescaleDB Continuous Aggregates', () => {
  let pool: Pool;
  let container: any;

  before(async () => {
    // Start TimescaleDB container
    container = await new PostgreSqlContainer('timescale/timescaledb:latest-pg14')
      .withDatabase('pactum_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    process.env.TIMESCALEDB_HOST = container.getHost();
    process.env.TIMESCALEDB_PORT = container.getPort().toString();
    process.env.TIMESCALEDB_DATABASE = 'pactum_test';
    process.env.TIMESCALEDB_USER = 'test';
    process.env.TIMESCALEDB_PASSWORD = 'test';

    pool = new Pool({
      host: container.getHost(),
      port: container.getPort(),
      database: 'pactum_test',
      user: 'test',
      password: 'test',
    });

    // Run migrations up to 007
    await runMigrations();
  });

  after(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  it('should refresh continuous aggregates correctly on CALL refresh_continuous_aggregate', async () => {
    // 1. Insert raw commitment outcome data
    const address = 'GCTestAddress12345';
    await pool.query(
      `INSERT INTO commitment_outcomes (party_a, party_b, outcome, amount, time)
       VALUES 
       ($1, 'GBXXX', 'fulfilled', 100, NOW() - INTERVAL '2 days'),
       ($1, 'GBXXX', 'late', 50, NOW() - INTERVAL '2 days'),
       ($1, 'GBXXX', 'fulfilled', 200, NOW() - INTERVAL '1 day')`,
      [address],
    );

    await pool.query(
      `INSERT INTO trust_score_snapshots (address, trust_score, total_commitments, fulfilled_commitments, late_commitments, breached_commitments, fulfillment_rate, time)
       VALUES 
       ($1, 80, 2, 1, 1, 0, 50, NOW() - INTERVAL '2 days'),
       ($1, 85, 3, 2, 1, 0, 66.67, NOW() - INTERVAL '1 day')`,
      [address],
    );

    // 2. Manually trigger CAGG refresh
    await pool.query(
      `CALL refresh_continuous_aggregate('reputation_snapshots_daily', NOW() - INTERVAL '7 days', NOW())`,
    );
    await pool.query(
      `CALL refresh_continuous_aggregate('mv_trust_score_trends_cagg', NOW() - INTERVAL '7 days', NOW())`,
    );

    // 3. Verify Repository correctly queries the view
    const repo = new PostgresReputationRepository(pool);
    const result = await repo.findByAddress(address);

    assert.ok(result);
    assert.ok(result.trustScore);
    assert.ok(Number(result.totalCommitments) >= 1);
    assert.ok(Number(result.fulfilledCommitments) >= 1);
  });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Pool } from 'pg';
import { startIntegrationDatabase, stopIntegrationDatabase, IntegrationDatabase } from '../setup';
import commitmentsRouter from '../../src/routes/commitments';

// We need to override the pool imported in commitmentsRouter.
// Since it's a singleton in src/db/timescale.ts, the easiest way is to mock it.
// However, since we're using real integration tests, we can just point the timescale module's pool
// to our integration pool if possible, or just mock the route handler directly.
// Actually, we can just replace the pool object in timescale.ts during tests!
import pool from '../../src/db/timescale';

describe('Commitments API Integration', () => {
  let db: IntegrationDatabase;
  let app: express.Express;
  let server: any;
  let port: number;
  let originalQuery: any;

  before(async () => {
    db = await startIntegrationDatabase();

    // Override the pool.query used by the router with our integration DB pool
    originalQuery = pool.query;
    pool.query = db.pool.query.bind(db.pool);

    app = express();
    app.use(express.json());
    app.use('/commitments', commitmentsRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    pool.query = originalQuery;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await stopIntegrationDatabase(db);
  });

  it('POST /commitments should insert an optimistic commitment into commitment_outcomes', async () => {
    const payload = {
      issuer: 'GBLDEY4S2X2WFTX6FYX4M4YZ276M2E4N5J5QO2E3B5Z5O5N5P5R5S222',
      counterparty: 'GCLDEY4S2X2WFTX6FYX4M4YZ276M2E4N5J5QO2E3B5Z5O5N5P5R5S222',
      terms_hash: 'abc123def456',
      due_at: Math.floor(Date.now() / 1000) + 86400, // tomorrow
    };

    const res = await fetch(`http://localhost:${port}/commitments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: number; status: string };
    assert.ok(typeof body.id === 'number');
    assert.equal(body.status, 'Pending');

    // Assert a row landed in commitment_outcomes
    const { rows } = await db.pool.query(
      'SELECT * FROM commitment_outcomes WHERE commitment_id = $1',
      [body.id.toString()],
    );
    assert.equal(rows.length, 1);
    const row = rows[0];

    assert.equal(row.party_a, payload.issuer);
    assert.equal(row.party_b, payload.counterparty);
    assert.equal(row.status, 'pending');
    assert.equal(row.outcome, 'pending');
  });
});

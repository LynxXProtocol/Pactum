import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export interface IntegrationDatabase {
  container?: StartedPostgreSqlContainer;
  pool: Pool;
}

// Only the tables the indexer pipeline actually touches (indexed_ledgers,
// indexer_checkpoint, commitment_index). The TimescaleDB migrations
// (001, 007) require the timescale/timescaledb image rather than plain
// postgres, and nothing under test here reads them.
const INDEXER_MIGRATIONS = ['003_deterministic_indexer.sql', '005_commitment_index.sql'];

/**
 * Boots an ephemeral, throwaway Postgres via Testcontainers (or connects to
 * process.env.DATABASE_URL if configured) and applies the indexer's schema to it.
 * Call from a suite's `before`; pair with `stopIntegrationDatabase` in `after`.
 */
export async function startIntegrationDatabase(): Promise<IntegrationDatabase> {
  let pool: Pool;
  let container: StartedPostgreSqlContainer | undefined;

  if (process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  } else {
    container = await new PostgreSqlContainer('timescale/timescaledb:latest-pg16')
      .withDatabase('pactum_integration')
      .withUsername('pactum')
      .withPassword('pactum')
      .start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }

  // Resolved from the repo-relative cwd (mirrors src/indexer/commitments.test.ts
  // and src/indexer/listener.test.ts) rather than __dirname, since __dirname
  // points at compiled test output under dist-integration-test/, which the
  // build does not copy the .sql migrations into.
  const migrationsDir = path.join(process.cwd(), 'src', 'db', 'migrations');
  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(migrationsDir);
    const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();
    for (const file of sqlFiles) {
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await pool.query(sql);
    }
  } catch (error) {
    // allSettled, not sequential awaits: a rejection from one cleanup must not
    // skip the other, and neither should replace the original setup error.
    await Promise.allSettled([pool.end(), container?.stop()]);
    throw error;
  }

  return { container, pool };
}

/** Closes the pool and stops the container started by `startIntegrationDatabase`. */
export async function stopIntegrationDatabase(db?: IntegrationDatabase): Promise<void> {
  if (!db) return;
  await db.pool?.end();
  if (db.container) {
    await db.container.stop();
  }
}

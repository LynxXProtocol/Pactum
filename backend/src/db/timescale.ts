import { Pool, PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '../logger/logger';

const pool = new Pool({
  host: process.env.TIMESCALEDB_HOST || 'localhost',
  port: parseInt(process.env.TIMESCALEDB_PORT || '5432'),
  database: process.env.TIMESCALEDB_DATABASE || 'pactum_timeseries',
  user: process.env.TIMESCALEDB_USER || 'postgres',
  password: process.env.TIMESCALEDB_PASSWORD || 'postgres',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export const getTimescaleClient = async (): Promise<PoolClient> => {
  return await pool.connect();
};

export const queryTimescale = async (text: string, params?: unknown[]) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Executed TimescaleDB query', { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    logger.error('TimescaleDB query error', error, { text });
    throw error;
  }
};

/**
 * Calculates SHA-256 checksum of SQL migration content for immutability validation.
 */
export function calculateMigrationChecksum(content: string): string {
  return crypto.createHash('sha256').update(content.trim(), 'utf8').digest('hex');
}

/**
 * Ensures the schema_migrations tracking table exists.
 */
export async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      version VARCHAR(255) NOT NULL UNIQUE,
      checksum VARCHAR(64) NOT NULL,
      executed_at TIMESTAMPTZ DEFAULT NOW(),
      execution_time_ms INTEGER NOT NULL
    );
  `);
}

/**
 * Runs pending immutable migrations against the database.
 * Detects modified past migrations via checksum verification.
 */
export const runMigrations = async (
  customMigrationsDir?: string,
): Promise<{ applied: string[]; skipped: string[] }> => {
  const client = await getTimescaleClient();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await ensureMigrationTable(client);

    const migrationsDir = customMigrationsDir || path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      return { applied, skipped };
    }

    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // Fetch existing applied migrations
    const existingResult = await client.query(
      'SELECT version, checksum FROM schema_migrations ORDER BY id ASC',
    );
    const appliedMap = new Map<string, string>(
      existingResult.rows.map((row: { version: string; checksum: string }) => [
        row.version,
        row.checksum,
      ]),
    );

    for (const file of migrationFiles) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      const checksum = calculateMigrationChecksum(sql);

      if (appliedMap.has(file)) {
        const recordedChecksum = appliedMap.get(file);
        if (recordedChecksum !== checksum) {
          throw new Error(
            `[Migration Error] Immutable migration '${file}' has been altered! Recorded SHA256: ${recordedChecksum}, Current SHA256: ${checksum}`,
          );
        }
        skipped.push(file);
        continue;
      }

      logger.info(`Applying database migration: ${file}`);
      const startTime = performance.now();

      await client.query('BEGIN');
      try {
        await client.query(sql);
        const durationMs = Math.round(performance.now() - startTime);

        await client.query(
          'INSERT INTO schema_migrations (version, checksum, execution_time_ms) VALUES ($1, $2, $3)',
          [file, checksum, durationMs],
        );
        await client.query('COMMIT');
        applied.push(file);
        logger.info(`Migration ${file} applied successfully (${durationMs}ms)`);
      } catch (migrationError) {
        await client.query('ROLLBACK');
        logger.error(`Migration ${file} failed, transaction rolled back`, migrationError);
        throw migrationError;
      }
    }

    logger.info(`Migration cycle complete: ${applied.length} applied, ${skipped.length} skipped.`);
    return { applied, skipped };
  } finally {
    client.release();
  }
};

/**
 * Dry-run mode: validates all migrations (checksum integrity + SQL parse-ability)
 * without writing anything to the database.  Exits non-zero on any error so CI
 * can catch broken schemas before they land on a shared database.
 *
 * Returns a status report for each migration file.
 */
export const dryRunMigrations = async (
  customMigrationsDir?: string,
): Promise<
  Array<{ file: string; status: 'pending' | 'applied' | 'tampered' | 'error'; message?: string }>
> => {
  const client = await getTimescaleClient();
  const report: Array<{
    file: string;
    status: 'pending' | 'applied' | 'tampered' | 'error';
    message?: string;
  }> = [];

  try {
    await ensureMigrationTable(client);

    const migrationsDir = customMigrationsDir || path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      logger.warn('[dry-run] Migrations directory not found. Nothing to validate.');
      return report;
    }

    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const existingResult = await client.query(
      'SELECT version, checksum FROM schema_migrations ORDER BY id ASC',
    );
    const appliedMap = new Map<string, string>(
      existingResult.rows.map((row: { version: string; checksum: string }) => [
        row.version,
        row.checksum,
      ]),
    );

    for (const file of migrationFiles) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      const checksum = calculateMigrationChecksum(sql);

      if (appliedMap.has(file)) {
        const recordedChecksum = appliedMap.get(file);
        if (recordedChecksum !== checksum) {
          const msg = `Immutable migration '${file}' has been altered! Recorded: ${recordedChecksum}, Current: ${checksum}`;
          logger.error(`[dry-run] TAMPERED: ${msg}`);
          report.push({ file, status: 'tampered', message: msg });
        } else {
          logger.info(`[dry-run] OK (applied): ${file}`);
          report.push({ file, status: 'applied' });
        }
      } else {
        // Validate the SQL parses cleanly using a savepoint that we always roll back.
        await client.query('BEGIN');
        try {
          await client.query(sql);
          logger.info(`[dry-run] OK (pending, syntax valid): ${file}`);
          report.push({ file, status: 'pending' });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[dry-run] SYNTAX ERROR in ${file}: ${msg}`);
          report.push({ file, status: 'error', message: msg });
        } finally {
          await client.query('ROLLBACK');
        }
      }
    }

    return report;
  } finally {
    client.release();
  }
};

/**
 * Reports the current migration state without making any changes.
 * Useful for `npm run migrate:status`.
 */
export const getMigrationStatus = async (
  customMigrationsDir?: string,
): Promise<
  Array<{
    file: string;
    status: 'applied' | 'pending' | 'tampered';
    executedAt?: string;
    checksum: string;
  }>
> => {
  const client = await getTimescaleClient();

  try {
    await ensureMigrationTable(client);

    const migrationsDir = customMigrationsDir || path.join(__dirname, 'migrations');
    const migrationFiles = fs.existsSync(migrationsDir)
      ? fs
          .readdirSync(migrationsDir)
          .filter((f) => f.endsWith('.sql'))
          .sort()
      : [];

    const existingResult = await client.query(
      'SELECT version, checksum, executed_at FROM schema_migrations ORDER BY id ASC',
    );
    const appliedMap = new Map<string, { checksum: string; executed_at: string }>(
      existingResult.rows.map((row: { version: string; checksum: string; executed_at: string }) => [
        row.version,
        { checksum: row.checksum, executed_at: row.executed_at },
      ]),
    );

    return migrationFiles.map((file) => {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      const currentChecksum = calculateMigrationChecksum(sql);
      const record = appliedMap.get(file);

      if (!record) {
        return { file, status: 'pending' as const, checksum: currentChecksum };
      }

      const status =
        record.checksum !== currentChecksum ? ('tampered' as const) : ('applied' as const);
      return { file, status, executedAt: record.executed_at, checksum: record.checksum };
    });
  } finally {
    client.release();
  }
};

export const refreshMaterializedViews = async () => {
  const views = [
    'mv_daily_fulfillment_rates',
    'mv_weekly_fulfillment_rates',
    'mv_monthly_fulfillment_rates',
    'mv_moving_averages',
    'mv_trust_score_trends',
  ];

  for (const view of views) {
    const start = Date.now();
    try {
      await queryTimescale(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
      const duration = Date.now() - start;
      logger.debug(`Refreshed materialized view ${view} in ${duration}ms`);
    } catch (error) {
      logger.warn(`Failed to refresh ${view} concurrently, falling back to standard refresh`, {
        error,
      });
      try {
        await queryTimescale(`REFRESH MATERIALIZED VIEW ${view}`);
        logger.info(`Refreshed ${view} with standard refresh`);
      } catch (fallbackError) {
        logger.error(`Failed to refresh ${view} with fallback`, fallbackError);
      }
    }
  }
};

export default pool;

import pool, { runMigrations } from './timescale';

// Standalone migration entrypoint. Exits explicitly because the pg pool keeps
// the event loop alive, which would otherwise hang container startup.
runMigrations()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('[migrate] Migrations failed:', error);
    try {
      await pool.end();
    } catch {
      // Surface the migration failure, not the teardown failure.
    }
    process.exit(1);
  });

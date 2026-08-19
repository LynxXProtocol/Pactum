import pool, { dryRunMigrations } from './timescale';

// Validates all migration files (checksum integrity + SQL syntax) against an
// ephemeral database without making any persistent changes.  Used by CI to
// gate PRs that touch migration files.
//
// Exit codes:
//   0 — all migrations are valid (applied checksums match, pending SQL is clean)
//   1 — at least one migration is tampered or contains a syntax error
dryRunMigrations()
  .then(async (report) => {
    let hasError = false;

    for (const entry of report) {
      const icon =
        entry.status === 'applied'
          ? '✓'
          : entry.status === 'pending'
            ? '⧖'
            : entry.status === 'tampered'
              ? '✗'
              : '✗';

      const detail = entry.message ? ` — ${entry.message}` : '';
      console.log(`[migrate:dry-run] ${icon} ${entry.file} (${entry.status})${detail}`);

      if (entry.status === 'tampered' || entry.status === 'error') {
        hasError = true;
      }
    }

    if (hasError) {
      console.error('\n[migrate:dry-run] FAILED — fix the errors above before merging.');
    } else {
      console.log(`\n[migrate:dry-run] OK — ${report.length} migration(s) validated successfully.`);
    }

    await pool.end();
    process.exit(hasError ? 1 : 0);
  })
  .catch(async (err) => {
    console.error('[migrate:dry-run] Error:', err);
    try {
      await pool.end();
    } catch {
      // ignore teardown errors
    }
    process.exit(1);
  });

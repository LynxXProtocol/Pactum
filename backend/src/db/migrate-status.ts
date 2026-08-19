import pool, { getMigrationStatus } from './timescale';

// Prints a human-readable status table for all migration files.
// Exits 0 even when there are pending migrations — it is informational only.
getMigrationStatus()
  .then(async (rows) => {
    const pad = (s: string, n: number) => s.padEnd(n);
    const header = `${'FILE'.padEnd(50)} ${'STATUS'.padEnd(10)} EXECUTED AT`;
    console.log('\n' + header);
    console.log('-'.repeat(header.length));

    for (const row of rows) {
      const statusLabel =
        row.status === 'applied'
          ? '✓ applied'
          : row.status === 'tampered'
            ? '✗ TAMPERED'
            : '⧖ pending';

      const executedAt = row.executedAt ? new Date(row.executedAt).toISOString() : '—';
      console.log(`${pad(row.file, 50)} ${pad(statusLabel, 10)} ${executedAt}`);
    }

    const pending = rows.filter((r) => r.status === 'pending').length;
    const tampered = rows.filter((r) => r.status === 'tampered').length;
    console.log(`\n${rows.length} total, ${pending} pending, ${tampered} tampered\n`);

    await pool.end();
    process.exit(tampered > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.error('[migrate:status] Error:', err);
    try {
      await pool.end();
    } catch {
      // ignore teardown errors
    }
    process.exit(1);
  });

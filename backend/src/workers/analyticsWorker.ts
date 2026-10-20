import { snapshotNetworkDailyStats } from './timescaleSnapshot';
import { queryTimescale } from '../db/timescale';
import { logger } from '../logger/logger';

const SNAPSHOT_INTERVAL = parseInt(process.env.ANALYTICS_SNAPSHOT_INTERVAL_MS || '3600000');
const WATCHDOG_INTERVAL = 5 * 60 * 1000; // 5 minutes

export class AnalyticsWorker {
  private snapshotTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;

  start() {
    console.log('[Analytics Worker] Starting analytics worker...');

    // Schedule periodic snapshots
    this.snapshotTimer = setInterval(() => {
      this.runSnapshot();
    }, SNAPSHOT_INTERVAL);

    // Schedule periodic CAGG health watchdog
    this.watchdogTimer = setInterval(() => {
      this.watchCAAGHealth();
    }, WATCHDOG_INTERVAL);

    // Run initial snapshot and watchdog check
    this.runSnapshot().catch(console.error);
    this.watchCAAGHealth().catch(console.error);

    console.log('[Analytics Worker] Analytics worker started');
    console.log(`[Analytics Worker] Snapshot interval: ${SNAPSHOT_INTERVAL}ms`);
    console.log(`[Analytics Worker] CAGG Watchdog interval: ${WATCHDOG_INTERVAL}ms`);
  }

  stop() {
    console.log('[Analytics Worker] Stopping analytics worker...');

    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }

    console.log('[Analytics Worker] Analytics worker stopped');
  }

  private async runSnapshot() {
    console.log('[Analytics Worker] Running network stats snapshot...');
    try {
      await snapshotNetworkDailyStats();
      console.log('[Analytics Worker] Daily stats snapshot completed');
    } catch (error) {
      console.error('[Analytics Worker] Snapshot failed:', error);
    }
  }

  // Watchdog: checks CAAG health every 5 minutes
  private async watchCAAGHealth(): Promise<void> {
    try {
      const stale = await queryTimescale(`
        SELECT view_name, next_scheduled_run AS next_run
        FROM timescaledb_information.continuous_aggregate_stats
        WHERE next_scheduled_run < NOW() - INTERVAL '10 minutes'
      `);

      if (stale.rows.length > 0) {
        logger.warn('CAGG background jobs appear stalled', { staleViews: stale.rows });

        if (process.env.CAGG_MANUAL_REFRESH === 'true') {
          // Fallback for restricted environments (managed Postgres without background workers)
          for (const { view_name } of stale.rows) {
            await queryTimescale(
              `CALL refresh_continuous_aggregate($1, NOW() - INTERVAL '3 days', NOW())`,
              [view_name],
            );
            logger.info('Manual CAGG refresh triggered', { view_name });
          }
        }
      }
    } catch (error) {
      logger.error('Failed to check CAGG health', error);
    }
  }
}

// Export singleton instance
export const analyticsWorker = new AnalyticsWorker();

// Auto-start if this file is run directly
if (require.main === module) {
  analyticsWorker.start();

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('[Analytics Worker] Received SIGINT, shutting down...');
    analyticsWorker.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('[Analytics Worker] Received SIGTERM, shutting down...');
    analyticsWorker.stop();
    process.exit(0);
  });
}

import { schedule, ScheduledTask } from 'node-cron';
import { queryTimescale } from '../db/timescale';
import {
  TtlMonitor,
  TtlBumper,
  TtlRpcClient,
  DEFAULT_TTL_REFRESH_THRESHOLD_LEDGERS,
  createTtlRpcClient,
} from './ttl-monitor';

/*
 * NOTE: The legacy snapshot logic (snapshotDay, runDailySnapshot) has been removed.
 * Reputation snapshots are now handled natively by TimescaleDB Continuous Aggregates
 * (see migration 010_continuous_aggregates.sql) via `add_continuous_aggregate_policy`.
 */

export type SnapshotQuery = (text: string, params?: any[]) => Promise<{ rows: any[] }>;

// ─── TTL Monitor Cron ────────────────────────────────────────────────────────

/**
 * Cron schedule for the TTL monitor.
 * Default: every 6 hours.  Override with `TTL_MONITOR_CRON`.
 */
const TTL_MONITOR_CRON = process.env.TTL_MONITOR_CRON || '0 */6 * * *';

/**
 * Timezone for the TTL monitor cron.
 * Default: UTC.  Override with `TTL_MONITOR_TIMEZONE`.
 */
const TTL_MONITOR_TIMEZONE = process.env.TTL_MONITOR_TIMEZONE || 'UTC';

/**
 * TTL threshold in ledgers below which a rent-bump is submitted.
 * Default: 241_920 (≈14 days at 5s/ledger, matching the contract constant).
 * Override with `TTL_MONITOR_THRESHOLD_LEDGERS`.
 */
const TTL_MONITOR_THRESHOLD_LEDGERS = Math.max(
  1,
  parseInt(
    process.env.TTL_MONITOR_THRESHOLD_LEDGERS ?? String(DEFAULT_TTL_REFRESH_THRESHOLD_LEDGERS),
    10,
  ),
);

/**
 * Maximum number of concurrent bump transactions per run.
 * Override with `TTL_MONITOR_BUMP_CONCURRENCY`.
 */
const TTL_MONITOR_BUMP_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.TTL_MONITOR_BUMP_CONCURRENCY || '5', 10),
);

let ttlMonitorRunning = false;

/**
 * Runs one TTL-monitor scan: fetches the set of high-value addresses from
 * TimescaleDB, checks each address's Soroban entry TTL, and submits a
 * `bumpReputationTtl` transaction for every address that is near expiry.
 *
 * @param rpc  - Soroban RPC client adapter (TtlRpcClient).
 * @param bumper - Soroban client that can submit TTL-bump transactions.
 * @param query - Optional SnapshotQuery override (for testing).
 */
export const runTtlMonitor = async (
  rpc: TtlRpcClient,
  bumper: TtlBumper,
  query: SnapshotQuery = queryTimescale,
  contractId: string = process.env.SOROBAN_CONTRACT_ID ?? '',
): Promise<void> => {
  if (ttlMonitorRunning) {
    console.warn('[TTL Monitor] Previous run is still in flight, skipping this tick');
    return;
  }

  ttlMonitorRunning = true;
  const startedAt = Date.now();

  try {
    // Fetch the union of all addresses that have ever appeared in commitment
    // outcomes — these are the addresses with on-chain reputation data.
    const addressResult = await query(
      `SELECT DISTINCT party_a AS address FROM commitment_outcomes`,
    );
    const highValueAddresses = addressResult.rows.map((row) => row.address as string);

    const monitor = new TtlMonitor({
      rpc,
      bumper,
      getHighValueAddresses: async () => highValueAddresses,
      ttlRefreshThresholdLedgers: TTL_MONITOR_THRESHOLD_LEDGERS,
      bumpConcurrency: TTL_MONITOR_BUMP_CONCURRENCY,
      contractId,
    });

    const result = await monitor.run();

    console.log(
      `[TTL Monitor] Scanned ${result.total} addresses in ${Date.now() - startedAt}ms ` +
        `| near-expiry: ${result.nearExpiry} | bumped: ${result.bumped} | failed: ${result.failed}`,
    );

    if (result.failed > 0) {
      for (const [address, error] of Object.entries(result.errors)) {
        console.error(`[TTL Monitor] Failed to bump ${address}: ${error}`);
      }
    }
  } catch (error) {
    console.error('[TTL Monitor] Run failed:', error);
  } finally {
    ttlMonitorRunning = false;
  }
};

/**
 * Starts the TTL monitor cron job.
 *
 * The job runs on `TTL_MONITOR_CRON` schedule (default every 6 hours) and
 * calls `runTtlMonitor` with the supplied Soroban RPC and bumper instances.
 *
 * @param rpc    - Soroban RPC adapter (use `createTtlRpcClient` with a live `rpc.Server`).
 * @param bumper - Soroban client with `bumpReputationTtl` (use `SorobanClient`).
 * @returns The scheduled task (call `.stop()` to cancel).
 */
export const startTtlMonitorCron = (rpc: TtlRpcClient, bumper: TtlBumper): ScheduledTask => {
  console.log(
    `[TTL Monitor] Scheduling TTL monitor at "${TTL_MONITOR_CRON}" (${TTL_MONITOR_TIMEZONE}) ` +
      `| threshold: ${TTL_MONITOR_THRESHOLD_LEDGERS} ledgers | concurrency: ${TTL_MONITOR_BUMP_CONCURRENCY}`,
  );
  return schedule(TTL_MONITOR_CRON, () => void runTtlMonitor(rpc, bumper), {
    timezone: TTL_MONITOR_TIMEZONE,
    noOverlap: true,
  });
};

export { createTtlRpcClient };

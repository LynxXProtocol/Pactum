/**
 * Tests for the TtlMonitor (Issue #58 — Soroban State Archival).
 *
 * Uses the node:test runner (same as the rest of the indexer test suite)
 * with fully in-process test doubles — no live Soroban RPC needed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TtlMonitor,
  TtlRpcClient,
  TtlBumper,
  DEFAULT_TTL_REFRESH_THRESHOLD_LEDGERS,
} from './ttl-monitor';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Minimal TtlRpcClient test double.
 * `ttlMap` maps base64 XDR key → expiration ledger (omit to simulate absent).
 */
function makeRpc(options: { latestSequence: number; ttlMap?: Map<string, number> }): TtlRpcClient {
  return {
    async getLatestLedger() {
      return { sequence: options.latestSequence };
    },
    async getLedgerEntryTtls(_keys: string[]) {
      return options.ttlMap ?? new Map();
    },
  };
}

/**
 * Minimal TtlBumper test double.  Records every address it was asked to bump.
 */
function makeBumper(options: { failAddresses?: Set<string> } = {}): TtlBumper & {
  bumped: string[];
} {
  const bumped: string[] = [];
  return {
    bumped,
    async bumpReputationTtl(address: string): Promise<string> {
      if (options.failAddresses?.has(address)) {
        throw new Error(`Simulated RPC failure for ${address}`);
      }
      bumped.push(address);
      return `txhash-${address}`;
    },
  };
}

const TEST_CONTRACT_ID = 'CBADTVTJ6IN332HIKZ7LWUYMYTLPZYCEBV3X2HS47VHR5UDBHQ3GAA7E';

// Convenience factory
function makeMonitor(options: {
  addresses: string[];
  latestSequence: number;
  ttlMap?: Map<string, number>;
  failAddresses?: Set<string>;
  thresholdLedgers?: number;
  bumpConcurrency?: number;
}): { monitor: TtlMonitor; bumper: TtlBumper & { bumped: string[] } } {
  const rpc = makeRpc({ latestSequence: options.latestSequence, ttlMap: options.ttlMap });
  const bumper = makeBumper({ failAddresses: options.failAddresses });
  const monitor = new TtlMonitor({
    rpc,
    bumper,
    getHighValueAddresses: async () => options.addresses,
    ttlRefreshThresholdLedgers: options.thresholdLedgers ?? DEFAULT_TTL_REFRESH_THRESHOLD_LEDGERS,
    bumpConcurrency: options.bumpConcurrency ?? 5,
    contractId: TEST_CONTRACT_ID,
  });
  return { monitor, bumper };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('returns zero counts when there are no high-value addresses', async () => {
  const { monitor } = makeMonitor({ addresses: [], latestSequence: 1000 });
  const result = await monitor.run();

  assert.equal(result.total, 0);
  assert.equal(result.nearExpiry, 0);
  assert.equal(result.bumped, 0);
  assert.equal(result.failed, 0);
});

test('does not bump addresses whose TTL is well above the threshold', async () => {
  const CURRENT = 1_000_000;
  const THRESHOLD = DEFAULT_TTL_REFRESH_THRESHOLD_LEDGERS; // 241_920

  // The monitor looks up keys by their XDR-encoded form in production.  In
  // unit tests, real Stellar address encoding is unavailable (fake address
  // strings like 'GADDR1' are not valid G… keys), so buildLedgerKeys falls
  // back to using the raw address string as the lookup key.  We key the ttlMap
  // by the address string directly so the test double's lookup succeeds.
  const ttlMap = new Map<string, number>([['GADDR1', CURRENT + THRESHOLD * 2]]);

  const { monitor, bumper } = makeMonitor({
    addresses: ['GADDR1'],
    latestSequence: CURRENT,
    ttlMap,
  });

  // The TTL for 'GADDR1' is well above the threshold, so no bump should occur.
  const result = await monitor.run();

  assert.equal(result.total, 1);
  assert.equal(result.nearExpiry, 0);
  assert.equal(result.bumped, 0);
  assert.equal((bumper as any).bumped.length, 0);
});

test('bumps an address whose TTL is at the threshold', async () => {
  const CURRENT = 1_000_000;
  const THRESHOLD = DEFAULT_TTL_REFRESH_THRESHOLD_LEDGERS;

  // Expiry ledger exactly at threshold distance → TTL == THRESHOLD → should bump.
  const ttlMap = new Map<string, number>([
    ['any-key', CURRENT + THRESHOLD], // TTL == THRESHOLD (at the boundary)
  ]);

  const { monitor, bumper } = makeMonitor({
    addresses: ['GADDR_AT_THRESHOLD'],
    latestSequence: CURRENT,
    ttlMap,
  });

  const result = await monitor.run();

  assert.equal(result.total, 1);
  assert.equal(result.nearExpiry, 1);
  assert.equal(result.bumped, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual((bumper as any).bumped, ['GADDR_AT_THRESHOLD']);
});

test('bumps an address whose TTL is below the threshold', async () => {
  const CURRENT = 1_000_000;
  const THRESHOLD = DEFAULT_TTL_REFRESH_THRESHOLD_LEDGERS;

  // Expiry ledger below threshold → must bump.
  const ttlMap = new Map<string, number>([['any-key', CURRENT + THRESHOLD - 1]]);

  const { monitor, bumper } = makeMonitor({
    addresses: ['GADDR_NEAR_EXPIRY'],
    latestSequence: CURRENT,
    ttlMap,
  });

  const result = await monitor.run();

  assert.equal(result.nearExpiry, 1);
  assert.equal(result.bumped, 1);
  assert.deepEqual((bumper as any).bumped, ['GADDR_NEAR_EXPIRY']);
});

test('treats absent keys as near-expiry (archived or never written for known address)', async () => {
  // ttlMap is empty → every key is absent → address is treated as near-expiry
  // because it IS in the high-value set (meaning it had data at some point).
  const { monitor, bumper } = makeMonitor({
    addresses: ['GADDR_ABSENT'],
    latestSequence: 1_000_000,
    ttlMap: new Map(),
  });

  const result = await monitor.run();

  assert.equal(result.total, 1);
  assert.equal(result.nearExpiry, 1);
  assert.equal(result.bumped, 1);
  assert.deepEqual((bumper as any).bumped, ['GADDR_ABSENT']);
});

test('handles a mix of healthy and near-expiry addresses', async () => {
  const CURRENT = 1_000_000;
  const THRESHOLD = DEFAULT_TTL_REFRESH_THRESHOLD_LEDGERS;

  // In unit tests, fake addresses fail XDR encoding so each address produces
  // exactly one fallback key (the raw address string).  We supply a ttlMap
  // that has a healthy TTL for 'GHEALTHY' and no entry for 'GNEAREXPIRY'
  // (absent = near-expiry).
  const ttlMap = new Map<string, number>([
    ['GHEALTHY', CURRENT + THRESHOLD * 3],
    // 'GNEAREXPIRY' is intentionally absent → treated as near-expiry
  ]);

  const rpc: TtlRpcClient = {
    async getLatestLedger() {
      return { sequence: CURRENT };
    },
    async getLedgerEntryTtls(_keys: string[]) {
      return ttlMap;
    },
  };

  const bumper = makeBumper();
  const monitor = new TtlMonitor({
    rpc,
    bumper,
    getHighValueAddresses: async () => ['GHEALTHY', 'GNEAREXPIRY'],
    ttlRefreshThresholdLedgers: THRESHOLD,
    bumpConcurrency: 5,
    contractId: TEST_CONTRACT_ID,
  });

  const result = await monitor.run();

  assert.equal(result.total, 2);
  // 'GHEALTHY' has a healthy TTL; 'GNEAREXPIRY' is absent → near-expiry.
  assert.equal(result.nearExpiry, 1);
  assert.equal(result.bumped, 1);
  assert.equal(result.failed, 0);
});

test('records failure and continues when bump throws for one address', async () => {
  const CURRENT = 1_000_000;

  // Both addresses near-expiry (absent from TTL map).
  const { monitor, bumper } = makeMonitor({
    addresses: ['GADDR_GOOD', 'GADDR_BAD'],
    latestSequence: CURRENT,
    ttlMap: new Map(), // all absent → all near-expiry
    failAddresses: new Set(['GADDR_BAD']),
  });

  const result = await monitor.run();

  assert.equal(result.total, 2);
  assert.equal(result.nearExpiry, 2);
  assert.equal(result.bumped, 1);
  assert.equal(result.failed, 1);
  assert.ok('GADDR_BAD' in result.errors, 'error should be keyed by address');
  assert.match(result.errors['GADDR_BAD'], /Simulated RPC failure/);
  assert.deepEqual((bumper as any).bumped, ['GADDR_GOOD']);
});

test('respects bumpConcurrency: all bumps complete even with concurrency = 1', async () => {
  const addresses = ['GA1', 'GA2', 'GA3', 'GA4', 'GA5'];

  const { monitor, bumper } = makeMonitor({
    addresses,
    latestSequence: 1_000_000,
    ttlMap: new Map(), // all near-expiry
    bumpConcurrency: 1,
  });

  const result = await monitor.run();

  assert.equal(result.bumped, 5);
  assert.equal(result.failed, 0);
  // All five addresses were bumped (order may vary with concurrency).
  assert.deepEqual([...(bumper as any).bumped].sort(), [...addresses].sort());
});

test('constructor rejects non-positive ttlRefreshThresholdLedgers', () => {
  assert.throws(
    () =>
      new TtlMonitor({
        rpc: makeRpc({ latestSequence: 0 }),
        bumper: makeBumper(),
        getHighValueAddresses: async () => [],
        ttlRefreshThresholdLedgers: 0,
        contractId: TEST_CONTRACT_ID,
      }),
    /ttlRefreshThresholdLedgers must be a positive integer/,
  );
});

test('constructor rejects non-positive bumpConcurrency', () => {
  assert.throws(
    () =>
      new TtlMonitor({
        rpc: makeRpc({ latestSequence: 0 }),
        bumper: makeBumper(),
        getHighValueAddresses: async () => [],
        bumpConcurrency: 0,
        contractId: TEST_CONTRACT_ID,
      }),
    /bumpConcurrency must be a positive integer/,
  );
});

test('uses DEFAULT_TTL_REFRESH_THRESHOLD_LEDGERS when threshold is not supplied', async () => {
  // Monitor with no ttlRefreshThresholdLedgers option; it should default to
  // DEFAULT_TTL_REFRESH_THRESHOLD_LEDGERS (241_920).
  const CURRENT = 1_000_000;
  // Key the map by the address string — the fallback path used when XDR
  // encoding is unavailable (fake address in unit tests).
  const ttlMap = new Map<string, number>([
    // TTL just above the default threshold → should NOT bump.
    ['GADDR_JUST_ABOVE', CURRENT + DEFAULT_TTL_REFRESH_THRESHOLD_LEDGERS + 1],
  ]);

  const rpc = makeRpc({ latestSequence: CURRENT, ttlMap });
  const bumper = makeBumper();
  const monitor = new TtlMonitor({
    rpc,
    bumper,
    getHighValueAddresses: async () => ['GADDR_JUST_ABOVE'],
    contractId: TEST_CONTRACT_ID,
    // ttlRefreshThresholdLedgers intentionally omitted
  });

  const result = await monitor.run();
  assert.equal(result.nearExpiry, 0);
  assert.equal(result.bumped, 0);
});

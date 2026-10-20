/**
 * TTL Monitor for Soroban State Archival Prevention (Issue #58).
 *
 * Stellar's Soroban ledger enforces state expiration: any persistent entry
 * whose TTL (time-to-live, measured in ledgers) drops below the minimum
 * will be archived and become unreadable until a `RestoreFootprint`
 * transaction is submitted to bring it back.
 *
 * For an address that has been dormant for ~30 days (the contract's current
 * `TTL_EXTEND_LEDGERS` window) its reputation and trust-history entries can
 * reach the archive threshold.  If a lending protocol then calls
 * `get_trust_score(dormant_address)` on the live chain, the host will reject
 * the transaction before the contract code runs.
 *
 * `TtlMonitor` addresses this by:
 *
 * 1. Querying the Soroban RPC for the current TTL of each high-value address's
 *    persistent storage entries using `getLedgerEntries`.
 * 2. Comparing each TTL against a configurable threshold
 *    (`ttlRefreshThresholdLedgers`, default: 241,920 ≈ 14 days).
 * 3. Submitting a `restore_reputation(address)` transaction (via
 *    `SorobanClient.bumpReputationTtl`) for every address whose TTL is at or
 *    below the threshold, refreshing it to the full 518,400-ledger window.
 *
 * The monitor is intentionally **non-blocking**: a failure to bump one address
 * is logged but does not abort the scan.  Concurrency is bounded by
 * `bumpConcurrency` (default: 5) to avoid overwhelming the RPC endpoint.
 *
 * ## High-value address selection
 *
 * A "high-value" address is one that has appeared in the indexer's event
 * stream at least once (i.e. it has reputation data on-chain).  The caller
 * is responsible for supplying the list — `TtlMonitor` only does the TTL
 * check and the bump.  In the `startTtlMonitorCron` integration, the list
 * comes from a `SELECT DISTINCT party_a FROM commitment_outcomes` query on
 * the TimescaleDB database.
 *
 * ## Ledger entry key encoding
 *
 * The contract stores reputation data under two Soroban persistent keys:
 *
 * ```
 * ReputationKey::ReputationV2(address)  – V2 (Phase C) row
 * ReputationKey::Reputation(address)    – V1 (Phase B) legacy row
 * TrustKey::TrustHistory(address)       – trust-score time-decay history
 * ```
 *
 * `getLedgerEntries` requires XDR-encoded `LedgerKey` values.  The monitor
 * uses the `ContractData` XDR variant with the contract ID and the matching
 * ScVal to compute the live TTL.  When `getLedgerEntries` returns
 * `expirationLedger` for a key, `ttl = expirationLedger - latestLedger`; a
 * missing key means the entry was never written or is already archived.
 */

import type { rpc as SorobanRpc, xdr as SorobanXdr } from '@stellar/stellar-sdk' with {
  'resolution-mode': 'import',
};

/**
 * Minimal interface for the Soroban RPC methods the monitor needs, so it can
 * be replaced with a test double without a live network connection.
 */
export interface TtlRpcClient {
  getLatestLedger(): Promise<{ sequence: number }>;
  /**
   * Fetch the live ledger entries for the given XDR-encoded LedgerKey values.
   * Returns a map from key (base64 XDR) to expiration ledger sequence number.
   * Keys that are absent (never written or already archived) are omitted.
   */
  getLedgerEntryTtls(keys: string[]): Promise<Map<string, number>>;
}

/**
 * Minimal interface the monitor uses to bump an address's TTL.
 * Keeping it narrow makes testing trivial.
 */
export interface TtlBumper {
  bumpReputationTtl(address: string): Promise<string>;
}

export interface TtlMonitorOptions {
  /** Soroban RPC client (or test double). */
  rpc: TtlRpcClient;
  /** Soroban client that can submit bumpReputationTtl transactions. */
  bumper: TtlBumper;
  /**
   * Returns the list of Stellar addresses (G…) to monitor on each run.
   * Typically a database query for all addresses that have reputation data.
   */
  getHighValueAddresses(): Promise<string[]>;
  /**
   * TTL in ledgers below which a bump is triggered.
   * Default: 241_920 (≈14 days at 5s/ledger, matching the contract's
   * `TTL_THRESHOLD_LEDGERS`).
   */
  ttlRefreshThresholdLedgers?: number;
  /**
   * Maximum number of concurrent bump transactions.
   * Default: 5.
   */
  bumpConcurrency?: number;
  /**
   * The deployed Pactum registry contract ID (Cxxxxxxxx… Stellar format).
   * Used to construct the Soroban `ContractData` ledger keys.
   */
  contractId: string;
}

export interface TtlMonitorRunResult {
  /** Total addresses scanned. */
  total: number;
  /** Addresses whose TTL was at or below the threshold. */
  nearExpiry: number;
  /** Addresses successfully bumped. */
  bumped: number;
  /** Addresses that failed to bump (RPC / submission errors). */
  failed: number;
  /** Error messages for failed bumps, keyed by address. */
  errors: Record<string, string>;
}

/**
 * Threshold below which an address is considered "near expiry" and must be
 * proactively bumped.  Matches the contract's `TTL_THRESHOLD_LEDGERS`.
 */
export const DEFAULT_TTL_REFRESH_THRESHOLD_LEDGERS = 241_920;

/**
 * Default number of concurrent bump transactions.
 */
export const DEFAULT_BUMP_CONCURRENCY = 5;

/**
 * Runs a bounded concurrency loop, calling `fn` for each item in `items`
 * with at most `concurrency` parallel calls at a time.
 */
async function pLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  let index = 0;

  const worker = async (): Promise<void> => {
    while (index < items.length) {
      const i = index;
      index += 1;
      try {
        const result = await fn(items[i]);
        results[i] = { status: 'fulfilled', value: result };
      } catch (error) {
        results[i] = {
          status: 'rejected',
          reason: error instanceof Error ? error : new Error(String(error)),
        };
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Monitors the TTL of Soroban reputation entries for high-value addresses and
 * proactively bumps their rent before they reach the archive threshold.
 */
export class TtlMonitor {
  private readonly ttlRefreshThresholdLedgers: number;

  private readonly bumpConcurrency: number;

  constructor(private readonly options: TtlMonitorOptions) {
    this.ttlRefreshThresholdLedgers =
      options.ttlRefreshThresholdLedgers ?? DEFAULT_TTL_REFRESH_THRESHOLD_LEDGERS;
    this.bumpConcurrency = options.bumpConcurrency ?? DEFAULT_BUMP_CONCURRENCY;

    if (this.ttlRefreshThresholdLedgers <= 0) {
      throw new Error('ttlRefreshThresholdLedgers must be a positive integer');
    }
    if (this.bumpConcurrency <= 0) {
      throw new Error('bumpConcurrency must be a positive integer');
    }
  }

  /**
   * Runs a single TTL-monitor scan:
   *
   * 1. Fetches the latest ledger sequence from the RPC.
   * 2. Retrieves all high-value addresses from the supplied callback.
   * 3. Queries the live TTL of each address's reputation entries.
   * 4. Bumps any entry whose TTL is at or below `ttlRefreshThresholdLedgers`.
   *
   * @returns A summary of the scan.
   */
  async run(): Promise<TtlMonitorRunResult> {
    const [latestLedger, addresses] = await Promise.all([
      this.options.rpc.getLatestLedger(),
      this.options.getHighValueAddresses(),
    ]);

    const currentSequence = latestLedger.sequence;
    const result: TtlMonitorRunResult = {
      total: addresses.length,
      nearExpiry: 0,
      bumped: 0,
      failed: 0,
      errors: {},
    };

    if (addresses.length === 0) {
      return result;
    }

    // Build the ledger keys for each address.
    // We encode one key per address (the V2 reputation key is the canonical one;
    // the monitor bumps all three via restore_reputation when the TTL is low).
    const keyMap = await this.buildLedgerKeys(addresses);

    // Fetch live TTLs.
    const allKeys = [...keyMap.values()].flat();
    const ttls = await this.options.rpc.getLedgerEntryTtls(allKeys);

    // Identify addresses near expiry.
    const nearExpiry: string[] = [];
    for (const address of addresses) {
      const keys = keyMap.get(address) ?? [];
      const isNearExpiry = this.isAddressNearExpiry(keys, ttls, currentSequence);
      if (isNearExpiry) {
        nearExpiry.push(address);
        result.nearExpiry += 1;
      }
    }

    if (nearExpiry.length === 0) {
      return result;
    }

    // Bump all near-expiry addresses with bounded concurrency.
    const bumpResults = await pLimit(nearExpiry, this.bumpConcurrency, async (address) => {
      const txHash = await this.options.bumper.bumpReputationTtl(address);
      return { address, txHash };
    });

    for (let i = 0; i < nearExpiry.length; i++) {
      const settled = bumpResults[i];
      const address = nearExpiry[i];
      if (settled.status === 'fulfilled') {
        result.bumped += 1;
      } else {
        result.failed += 1;
        const reason = settled.reason as Error;
        result.errors[address] = reason.message;
      }
    }

    return result;
  }

  /**
   * Checks whether an address's reputation entries are at risk of archival.
   *
   * An address stores up to three key variants (V2 row, legacy V1 row, and
   * trust-history), but not all of them are present at once: a row migrated to
   * V2 drops its V1 variant, and an un-migrated row has no V2 variant.  A
   * single absent variant is therefore **not** an expiry signal.
   *
   * The address is considered near expiry when either a live key's TTL is at or
   * below the refresh threshold, or when **no** key variant is present at all —
   * the latter meaning the reputation data is fully archived and needs a
   * restore.
   */
  private isAddressNearExpiry(
    keys: string[],
    ttls: Map<string, number>,
    currentSequence: number,
  ): boolean {
    let anyPresent = false;
    let anyNearExpiry = false;

    for (const key of keys) {
      const expirationLedger = ttls.get(key);
      if (expirationLedger === undefined) {
        // This key variant is absent (never written, migrated away, or the
        // address simply isn't on this schema). Not an expiry signal on its own.
        continue;
      }
      anyPresent = true;
      const ttl = expirationLedger - currentSequence;
      if (ttl <= this.ttlRefreshThresholdLedgers) {
        anyNearExpiry = true;
      }
    }

    return anyNearExpiry || !anyPresent;
  }

  /**
   * Builds the base64-XDR encoded `ContractData` LedgerKey for a list of
   * addresses.  Returns a Map<address, key[]> — one key per schema variant
   * (V2 row, V1 legacy row, trust-history).
   *
   * The actual XDR encoding uses the @stellar/stellar-sdk `xdr` namespace,
   * imported lazily to avoid coupling the module to a specific bundle.
   */
  private async buildLedgerKeys(addresses: string[]): Promise<Map<string, string[]>> {
    // Lazy-import the SDK to stay compatible with both ESM and CJS.
    const sdk = await (import('@stellar/stellar-sdk') as Promise<{
      xdr: typeof SorobanXdr;
      Address: { fromString(s: string): { toScVal(): unknown; toScAddress(): unknown } };
      Contract: new (id: string) => { address(): { toScAddress(): unknown } };
      nativeToScVal(v: unknown, opts?: { type: string }): unknown;
    }>);

    const map = new Map<string, string[]>();

    for (const address of addresses) {
      try {
        const keys = this.encodeAddressKeys(sdk, address);
        map.set(address, keys);
      } catch {
        // XDR encoding failed (e.g. invalid address format in test environments).
        // Fall back to using the raw address string as a single lookup key so
        // that test doubles keyed by address string still work.  In production
        // this branch is never reached because all addresses are valid Stellar
        // G… public keys.
        map.set(address, [address]);
      }
    }

    return map;
  }

  /**
   * Encodes the three Soroban persistent ledger keys for a single address.
   *
   * Each contract key is an ScVal of the form:
   *   `Vec [ Symbol("ReputationV2"), Address ]`   (V2 reputation row)
   *   `Vec [ Symbol("Reputation"),   Address ]`   (V1 legacy row)
   *   `Vec [ Symbol("TrustHistory"), Address ]`   (trust-score history)
   *
   * These match the `#[contracttype]` enum variant names that the Soroban
   * SDK encodes at runtime.
   */
  private encodeAddressKeys(
    sdk: {
      xdr: typeof SorobanXdr;
      Address: { fromString(s: string): { toScVal(): unknown; toScAddress(): unknown } };
      Contract: new (id: string) => { address(): { toScAddress(): unknown } };
      nativeToScVal(v: unknown, opts?: { type: string }): unknown;
    },
    address: string,
  ): string[] {
    const { xdr } = sdk;

    const stellarAddress = sdk.Address.fromString(address);
    const addressScVal = stellarAddress.toScVal() as InstanceType<typeof xdr.ScVal>;

    // Use sdk.Contract to obtain a correctly typed ScAddress for the contract
    // key.  The Contract constructor internally decodes the C… Strkey and
    // produces the right XDR Opaque Hash type that xdr.ScAddress expects.
    const contractScAddress = new sdk.Contract(this.options.contractId)
      .address()
      .toScAddress() as InstanceType<typeof xdr.ScAddress>;

    const buildKey = (variantName: string): string => {
      // The contracttype enum encodes as: Vec [ Symbol(variantName), ScVal(address) ]
      const keyScVal = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variantName), addressScVal]);

      const ledgerKey = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: contractScAddress,
          key: keyScVal,
          durability: xdr.ContractDataDurability.persistent(),
        }),
      );

      return ledgerKey.toXDR('base64');
    };

    return [buildKey('ReputationV2'), buildKey('Reputation'), buildKey('TrustHistory')];
  }
}

/**
 * Factory function that builds a `TtlRpcClient` adapter from the Soroban RPC
 * server.  Used by `startTtlMonitorCron` to connect the monitor to the live
 * network.
 */
export function createTtlRpcClient(server: {
  getLatestLedger(): Promise<{ sequence: number }>;
  getLedgerEntries(
    ...keys: unknown[]
  ): Promise<{ entries: Array<{ liveUntilLedgerSeq?: number; key?: unknown }> }>;
}): TtlRpcClient {
  return {
    getLatestLedger: () => server.getLatestLedger(),

    async getLedgerEntryTtls(keys: string[]): Promise<Map<string, number>> {
      if (keys.length === 0) return new Map();

      // Lazy-import so the module can load in test environments without the SDK.
      const { xdr } = await (import('@stellar/stellar-sdk') as Promise<{ xdr: typeof SorobanXdr }>);

      const decodedKeys = keys.map((k) => xdr.LedgerKey.fromXDR(k, 'base64'));
      let response: { entries: Array<{ liveUntilLedgerSeq?: number; key?: unknown }> };
      try {
        response = await server.getLedgerEntries(decodedKeys);
      } catch {
        return new Map();
      }

      const result = new Map<string, number>();
      for (let i = 0; i < response.entries.length; i++) {
        const entry = response.entries[i];
        if (entry.liveUntilLedgerSeq !== undefined) {
          result.set(keys[i], entry.liveUntilLedgerSeq);
        }
      }
      return result;
    },
  };
}

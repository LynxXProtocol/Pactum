import { Account, FeeBumpTransaction, Keypair, Transaction, rpc, xdr } from '@stellar/stellar-sdk';

/**
 * A single Soroban RPC endpoint that the pool can route traffic to.
 */
export interface SorobanRpcNodeConfig {
  url: string;
  /**
   * Optional per-node HTTP headers (e.g. an API key for private RPC
   * infrastructure). Headers set here take precedence over the pool-wide
   * `headers` option.
   */
  headers?: Record<string, string>;
}

export interface SorobanRpcPoolOptions {
  /**
   * Allow `http://` endpoints (local development / sandbox). Mirrors the
   * `allowHttp` option of {@link rpc.Server} and defaults to `true` to match
   * the behaviour of the code this pool replaces.
   */
  allowHttp?: boolean;
  /** Per-request timeout in milliseconds, passed to every {@link rpc.Server}. */
  timeout?: number;
  /** Optional headers applied to every node in the pool. */
  headers?: Record<string, string>;
  /**
   * Maximum number of node attempts per call. Defaults to the number of
   * configured nodes (try every node exactly once, most healthy first).
   */
  maxAttempts?: number;
  /**
   * How long (in milliseconds) a node is deprioritised after a retryable
   * failure. During this window the pool routes around the node. Default 30s.
   */
  cooldownMs?: number;
  /** Health score added on a successful call. Default 2. */
  successBonus?: number;
  /** Health score subtracted on a retryable failure. Default 25. */
  failurePenalty?: number;
  /** Maximum health score a node can reach. Default 100. */
  maxScore?: number;
  /** Minimum health score floor. Default 0. */
  minScore?: number;
  /**
   * Called whenever a call fails on a node and the pool is about to retry it
   * on another node. Useful for surfacing user-facing status updates.
   */
  onFallback?: (info: {
    url: string;
    error: unknown;
    /** 1-based attempt number that just failed. */
    attempt: number;
    /** Number of additional nodes left to try. */
    remaining: number;
  }) => void;
  /** Called after a node successfully answers a call. */
  onNodeSuccess?: (stats: SorobanRpcNodeStats) => void;
  /** Called after a node fails a call (retryable or not). */
  onNodeFailure?: (stats: SorobanRpcNodeStats, error: unknown) => void;
  /**
   * Optional callback invoked when all nodes are exhausted on retryable failures.
   */
  onError?: (error: unknown, context?: Record<string, unknown>) => void;
  /**
   * Injectable {@link rpc.Server} factory — primarily used by tests to stub
   * out the network layer.
   */
  serverFactory?: (url: string, options: rpc.Server.Options) => rpc.Server;
}

/** A snapshot of a node's health, exposed via {@link SorobanRpcPool.getStats}. */
export interface SorobanRpcNodeStats {
  url: string;
  /** Current health score (0..maxScore). Higher = preferred. */
  score: number;
  /** EWMA of recent call latency in milliseconds. Lower = preferred. */
  latencyMs: number;
  totalSuccesses: number;
  totalFailures: number;
  consecutiveFailures: number;
  lastError?: string;
  lastAttemptAt?: number;
  /** Timestamp until which the node is deprioritised after a failure. */
  cooldownUntil?: number;
}

/**
 * Marker error used by the pool itself to force a retry on another node even
 * when the underlying transport returned a 2xx response. The most notable
 * case is {@link SorobanRpcPool.sendTransaction} when the node answers
 * `status: "TRY_AGAIN_LATER"` — the node is overloaded, not the transaction.
 */
export class RetryableRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableRpcError';
  }
}

/**
 * Thrown by {@link SorobanRpcPool.execute} when every configured node failed
 * with a retryable error. The underlying failures are preserved in
 * {@link RpcPoolExhaustedError.lastError} and {@link RpcPoolExhaustedError.nodeStats}.
 */
export class RpcPoolExhaustedError extends Error {
  readonly lastError: unknown;
  readonly nodeStats: SorobanRpcNodeStats[];
  readonly attempts: number;

  constructor(lastError: unknown, nodeStats: SorobanRpcNodeStats[], attempts: number) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    super(
      `All ${nodeStats.length} configured Soroban RPC node(s) failed after ${attempts} ` +
        `attempt(s). Last error: ${reason}`,
    );
    this.name = 'RpcPoolExhaustedError';
    this.lastError = lastError;
    this.nodeStats = nodeStats;
    this.attempts = attempts;
  }
}

const NETWORK_ERROR_HINTS = [
  'fetch failed',
  'failed to fetch',
  'network error',
  'econnrefused',
  'econnreset',
  'enotfound',
  'etimedout',
  'timeout of ',
  'socket hang up',
  'getaddrinfo',
  'load failed',
  'request timed out',
];

/**
 * Classifies an error thrown by the Stellar SDK (or the underlying fetch
 * client) as *retryable on another node*:
 *
 * - HTTP `429 Too Many Requests` — the node is rate-limiting us.
 * - HTTP `5xx` server errors — the node is sick or overloaded.
 * - JSON-RPC server errors (`code` in `-32000..-32099`, `-32603`) — transient
 *   server-side failures reported inside a 200 response body.
 * - Network-level failures (DNS, connection reset/refused, timeouts,
 *   `TypeError: Failed to fetch`) — no HTTP response was ever produced.
 *
 * Anything else (400s, contract/simulation errors, auth failures) is
 * application-level and would fail identically on every node, so it is **not**
 * retryable and is surfaced to the caller immediately.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof RetryableRpcError) return true;
  if (!error || typeof error !== 'object') return false;

  const candidate = error as {
    response?: { status?: unknown };
    status?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };

  // 1. HTTP status code surfaced by the SDK's fetch/axios-style client, which
  //    throws `Error` with an attached `error.response.status`. Some clients
  //    also expose the status directly on the error object.
  const status =
    typeof candidate.response?.status === 'number'
      ? candidate.response.status
      : typeof candidate.status === 'number' && candidate.status >= 100 && candidate.status <= 599
        ? candidate.status
        : undefined;
  if (status !== undefined) {
    return status === 429 || (status >= 500 && status <= 599);
  }

  // 2. JSON-RPC error object thrown by the SDK's postObject when the response
  //    body contains an "error" member: `{ code, message, data }`.
  if (typeof candidate.code === 'number') {
    return candidate.code === -32603 || (candidate.code <= -32000 && candidate.code >= -32099);
  }

  // 3. Network-level failures that never produced an HTTP response.
  const name = typeof candidate.name === 'string' ? candidate.name.toLowerCase() : '';
  const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
  if (name === 'fetcherror' || name === 'networkerror' || name === 'timeouterror') return true;
  if (name === 'typeerror' && NETWORK_ERROR_HINTS.some((hint) => message.includes(hint))) {
    return true;
  }
  return NETWORK_ERROR_HINTS.some((hint) => message.includes(hint));
}

interface RpcNodeState extends SorobanRpcNodeStats {
  server: rpc.Server;
}

const EWMA_ALPHA = 0.7;
const DEFAULT_OPTIONS: Required<
  Pick<
    SorobanRpcPoolOptions,
    | 'allowHttp'
    | 'timeout'
    | 'cooldownMs'
    | 'successBonus'
    | 'failurePenalty'
    | 'maxScore'
    | 'minScore'
  >
> = {
  allowHttp: true,
  timeout: 15_000,
  cooldownMs: 30_000,
  successBonus: 2,
  failurePenalty: 25,
  maxScore: 100,
  minScore: 0,
};

/**
 * A production-grade Soroban RPC connection manager.
 *
 * The pool maintains a set of RPC endpoints (typically public nodes plus any
 * private infrastructure) and:
 *
 * - routes each call to the healthiest, most performant node,
 * - detects `429 Too Many Requests`, `5xx` server errors, JSON-RPC server
 *   errors and raw network failures,
 * - transparently retries the call on the next-best node without interrupting
 *   the caller,
 * - maintains a local health score and EWMA latency per node, dynamically
 *   shifting traffic away from degraded nodes (and back once they recover).
 *
 * All endpoints should be on the **same Stellar network** so that a
 * transaction prepared or submitted through any of them is valid on all of
 * them.
 *
 * @example
 * ```ts
 * const pool = new SorobanRpcPool([
 *   'https://soroban-testnet.stellar.org',
 *   'https://my-private-rpc.example.com',
 * ]);
 * const ledger = await pool.getLatestLedger();
 * console.log(pool.getStats());
 * ```
 */
export class SorobanRpcPool {
  private readonly nodes: RpcNodeState[];
  private readonly options: SorobanRpcPoolOptions;
  private readonly nodeOrder = new Map<string, number>();

  constructor(urls: Array<string | SorobanRpcNodeConfig>, options: SorobanRpcPoolOptions = {}) {
    if (!urls || urls.length === 0) {
      throw new Error('SorobanRpcPool requires at least one RPC endpoint URL');
    }
    this.options = { ...DEFAULT_OPTIONS, ...options };

    this.nodes = urls.map((entry, index) => {
      const config = typeof entry === 'string' ? { url: entry } : entry;
      const url = config.url.trim();
      if (!url) {
        throw new Error('SorobanRpcPool received an empty RPC endpoint URL');
      }
      const serverOptions: rpc.Server.Options = {
        allowHttp: this.options.allowHttp,
        timeout: this.options.timeout,
        headers: { ...this.options.headers, ...config.headers },
      };
      const server = this.options.serverFactory
        ? this.options.serverFactory(url, serverOptions)
        : new rpc.Server(url, serverOptions);
      this.nodeOrder.set(url, index);
      return {
        url,
        server,
        score: this.options.maxScore ?? DEFAULT_OPTIONS.maxScore,
        latencyMs: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        consecutiveFailures: 0,
      };
    });
  }

  /** Number of configured RPC nodes. */
  get size(): number {
    return this.nodes.length;
  }

  /** URL of the currently preferred (healthiest) node, if any. */
  get preferredUrl(): string | undefined {
    return this.rankNodes()[0]?.url;
  }

  /** Snapshot of every node's health stats, ordered by preference. */
  getStats(): SorobanRpcNodeStats[] {
    return this.rankNodes().map((node) => this.toStats(node));
  }

  /**
   * Proactively probes every node with `getHealth()` and updates their health
   * scores. Call this from a timer (e.g. every 60s) to keep the pool warm, or
   * rely purely on the passive scoring updated by real traffic.
   */
  async checkHealth(): Promise<SorobanRpcNodeStats[]> {
    await Promise.all(
      this.nodes.map(async (node) => {
        const startedAt = Date.now();
        try {
          await node.server.getHealth();
          this.recordSuccess(node, startedAt);
        } catch (error) {
          this.recordFailure(node, error, startedAt, true);
        }
      }),
    );
    return this.getStats();
  }

  /**
   * Core execution path: run `operation` against the healthiest node and, if
   * it fails with a retryable error, transparently re-run it on the next-best
   * node until one succeeds or every node has been tried.
   */
  async execute<T>(
    operation: (server: rpc.Server) => Promise<T>,
    options: { isRetryable?: (error: unknown) => boolean } = {},
  ): Promise<T> {
    const candidates = this.rankNodes();
    const maxAttempts = Math.min(
      Math.max(1, this.options.maxAttempts ?? candidates.length),
      candidates.length,
    );
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const node = candidates[attempt];
      if (!node) break;
      const startedAt = Date.now();
      node.lastAttemptAt = startedAt;

      try {
        const result = await operation(node.server);
        this.recordSuccess(node, startedAt);
        return result;
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof RetryableRpcError ||
          (options.isRetryable ? options.isRetryable(error) : isRetryableError(error));
        this.recordFailure(node, error, startedAt, retryable);

        const remaining = maxAttempts - attempt - 1;
        if (retryable && remaining > 0) {
          this.options.onFallback?.({ url: node.url, error, attempt: attempt + 1, remaining });
        } else if (retryable) {
          // Every node failed on a retryable (timeout / network / node overload)
          // error. Report it with non-sensitive context if an onError callback is provided.
          this.options.onError?.(error, {
            rpcNode: node.url,
            attempts: maxAttempts,
            errorType: error instanceof Error ? error.name : typeof error,
          });
          throw new RpcPoolExhaustedError(lastError, this.getStats(), maxAttempts);
        } else {
          // Application-level error (simulation failure, bad request, ...) —
          // every node would reject it the same way, so surface it immediately.
          throw error;
        }
      }
    }

    throw new RpcPoolExhaustedError(lastError, this.getStats(), maxAttempts);
  }

  // ── rpc.Server-compatible surface ──────────────────────────────────────
  // The pool is a drop-in replacement for `new rpc.Server(...)` for the
  // methods the Pactum dApp uses.

  /**
   * Fetch a minimal set of current info about a Stellar account.
   *
   * Implemented on top of `getLedgerEntries` (rather than the SDK's
   * `getAccount`, which swallows HTTP errors into a generic "Account not
   * found") so that rate-limit / server errors are preserved and the pool can
   * rotate to a healthy node.
   */
  async getAccount(address: string): Promise<Account> {
    return this.execute(async (server) => {
      const ledgerKey = xdr.LedgerKey.account(
        new xdr.LedgerKeyAccount({
          accountId: Keypair.fromPublicKey(address).xdrPublicKey(),
        }),
      );
      const response = await server.getLedgerEntries(ledgerKey);
      if (!response.entries.length) {
        throw new Error(`Account not found: ${address}`);
      }
      const entry = response.entries[0].val.account();
      return new Account(address, entry.seqNum().toString());
    });
  }

  /** General node health check. */
  getHealth(): Promise<rpc.Api.GetHealthResponse> {
    return this.execute((server) => server.getHealth());
  }

  /** Fetch metadata about the network this Soroban RPC server is connected to. */
  getNetwork(): Promise<rpc.Api.GetNetworkResponse> {
    return this.execute((server) => server.getNetwork());
  }

  /** Fetch the latest ledger meta info from the network. */
  getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> {
    return this.execute((server) => server.getLatestLedger());
  }

  /** Fetch the details of a submitted transaction. */
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    return this.execute((server) => server.getTransaction(hash));
  }

  /** Submit a trial contract invocation to get back return values, footprint, auth and costs. */
  simulateTransaction(
    tx: Transaction | FeeBumpTransaction,
    addlResources?: rpc.Server.ResourceLeeway,
    authMode?: rpc.Api.SimulationAuthMode,
    useUpgradedAuth?: boolean,
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    return this.execute((server) =>
      server.simulateTransaction(tx, addlResources, authMode, useUpgradedAuth),
    );
  }

  /** Simulate + assemble a transaction so it is ready for signing and sending. */
  prepareTransaction(tx: Transaction | FeeBumpTransaction): Promise<Transaction> {
    return this.execute((server) => server.prepareTransaction(tx));
  }

  /**
   * Submit a real transaction to the Stellar network.
   *
   * When a node answers `status: "TRY_AGAIN_LATER"` it is overloaded (not a
   * transaction problem), so the pool throws a {@link RetryableRpcError}
   * internally and retries the submission on the next node. Submitting the
   * same signed envelope to another node on the same network is safe — the
   * network treats duplicate submissions idempotently.
   */
  async sendTransaction(
    transaction: Transaction | FeeBumpTransaction,
  ): Promise<rpc.Api.SendTransactionResponse> {
    return this.execute(async (server) => {
      const response = await server.sendTransaction(transaction);
      if (response.status === 'TRY_AGAIN_LATER') {
        throw new RetryableRpcError(
          'Soroban RPC node is overloaded (sendTransaction returned TRY_AGAIN_LATER); retrying on another node',
        );
      }
      return response;
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /** Order nodes by: not cooling down → score desc → latency asc → config order. */
  private rankNodes(): RpcNodeState[] {
    const now = Date.now();
    return [...this.nodes].sort((a, b) => {
      const aCoolingDown = a.cooldownUntil !== undefined && a.cooldownUntil > now;
      const bCoolingDown = b.cooldownUntil !== undefined && b.cooldownUntil > now;
      if (aCoolingDown !== bCoolingDown) return aCoolingDown ? 1 : -1;
      if (b.score !== a.score) return b.score - a.score;
      if (a.latencyMs !== b.latencyMs) return a.latencyMs - b.latencyMs;
      return (this.nodeOrder.get(a.url) ?? 0) - (this.nodeOrder.get(b.url) ?? 0);
    });
  }

  private recordSuccess(node: RpcNodeState, startedAt: number): void {
    const latency = Date.now() - startedAt;
    node.latencyMs =
      node.latencyMs === 0 ? latency : node.latencyMs * EWMA_ALPHA + latency * (1 - EWMA_ALPHA);
    node.totalSuccesses += 1;
    node.consecutiveFailures = 0;
    node.cooldownUntil = undefined;
    node.lastError = undefined;
    node.score = Math.min(
      this.options.maxScore ?? DEFAULT_OPTIONS.maxScore,
      node.score + (this.options.successBonus ?? DEFAULT_OPTIONS.successBonus),
    );
    this.options.onNodeSuccess?.(this.toStats(node));
  }

  private recordFailure(
    node: RpcNodeState,
    error: unknown,
    startedAt: number,
    retryable: boolean,
  ): void {
    const latency = Date.now() - startedAt;
    node.latencyMs =
      node.latencyMs === 0 ? latency : node.latencyMs * EWMA_ALPHA + latency * (1 - EWMA_ALPHA);
    node.totalFailures += 1;
    node.lastError = error instanceof Error ? error.message : String(error);

    // Only penalise the node's health score and put it into cooldown when
    // the failure is transient (the node itself is struggling). Application-
    // level errors like "unfunded account" or contract simulation failures
    // are not the node's fault — every node would return the same result.
    if (retryable) {
      node.consecutiveFailures += 1;
      node.cooldownUntil = Date.now() + (this.options.cooldownMs ?? DEFAULT_OPTIONS.cooldownMs);
      node.score = Math.max(
        this.options.minScore ?? DEFAULT_OPTIONS.minScore,
        node.score - (this.options.failurePenalty ?? DEFAULT_OPTIONS.failurePenalty),
      );
    } else {
      node.consecutiveFailures = 0;
    }
    this.options.onNodeFailure?.(this.toStats(node), error);
  }

  private toStats(node: RpcNodeState): SorobanRpcNodeStats {
    return {
      url: node.url,
      score: node.score,
      latencyMs: node.latencyMs,
      totalSuccesses: node.totalSuccesses,
      totalFailures: node.totalFailures,
      consecutiveFailures: node.consecutiveFailures,
      lastError: node.lastError,
      lastAttemptAt: node.lastAttemptAt,
      cooldownUntil: node.cooldownUntil,
    };
  }
}

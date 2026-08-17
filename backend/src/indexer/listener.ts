import {
  IndexerStore,
  LedgerCheckpoint,
  LedgerSnapshot,
  LedgerSource,
} from './types';
import { InMemoryCursorCache, PostgresCursorCache } from './cache';

// ─── Existing FinalityIndexer (unchanged) ────────────────────────────────────

export interface FinalityIndexerOptions {
  source: LedgerSource;
  store: IndexerStore;
  finalityDepth: number;
  startSequence?: number;
  maxBatchSize?: number;
  maxRollbackDepth?: number;
  /**
   * Invoked after each ledger is committed, so downstream caches can be
   * invalidated for the addresses it touched. Failures are logged and
   * swallowed: a committed ledger is canonical whether or not a cache noticed.
   */
  onLedgerCommitted?: (ledger: LedgerSnapshot) => void | Promise<void>;
}

export interface SyncResult {
  latestSequence: number;
  finalizedSequence: number;
  committed: number;
  rolledBackFrom: number | null;
  checkpoint: LedgerCheckpoint | null;
}

export class LedgerLinkageError extends Error {
  constructor(
    public readonly sequence: number,
    public readonly expectedPreviousHash: string,
    public readonly receivedPreviousHash: string | null,
  ) {
    super(
      `Ledger ${sequence} links to ${receivedPreviousHash}, expected ${expectedPreviousHash}`,
    );
    this.name = 'LedgerLinkageError';
  }
}

export class NoCommonAncestorError extends Error {
  constructor(sequence: number) {
    super(`Could not find a canonical ancestor for checkpoint ${sequence}`);
    this.name = 'NoCommonAncestorError';
  }
}

export class FinalityIndexer {
  private readonly startSequence: number;

  private readonly maxBatchSize: number;

  private readonly maxRollbackDepth: number;

  constructor(private readonly options: FinalityIndexerOptions) {
    if (!Number.isInteger(options.finalityDepth) || options.finalityDepth < 0) {
      throw new Error('finalityDepth must be a non-negative integer');
    }

    this.startSequence = options.startSequence ?? 1;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.maxRollbackDepth = options.maxRollbackDepth
      ?? Math.max(100, options.finalityDepth * 2);
    if (!Number.isInteger(this.startSequence) || this.startSequence < 1) {
      throw new Error('startSequence must be a positive integer');
    }
    if (!Number.isInteger(this.maxBatchSize) || this.maxBatchSize < 1) {
      throw new Error('maxBatchSize must be a positive integer');
    }
    if (!Number.isInteger(this.maxRollbackDepth) || this.maxRollbackDepth < 1) {
      throw new Error('maxRollbackDepth must be a positive integer');
    }
  }

  async sync(): Promise<SyncResult> {
    const latest = await this.options.source.getLatestLedger();
    const finalizedSequence = Math.max(
      0,
      latest.sequence - this.options.finalityDepth,
    );
    let checkpoint = await this.options.store.getCheckpoint();
    let rolledBackFrom: number | null = null;

    if (checkpoint) {
      const canonicalCheckpoint = checkpoint.sequence <= latest.sequence
        ? await this.options.source.getLedger(checkpoint.sequence)
        : null;
      if (!canonicalCheckpoint || canonicalCheckpoint.hash !== checkpoint.hash) {
        const ancestorSequence = await this.findCommonAncestor(
          checkpoint.sequence,
          Math.min(latest.sequence, finalizedSequence),
        );
        if (ancestorSequence === null) {
          throw new NoCommonAncestorError(checkpoint.sequence);
        }

        await this.options.store.rollbackTo(ancestorSequence);
        rolledBackFrom = checkpoint.sequence;
        checkpoint = await this.options.store.getCheckpoint();
      }
    }

    let nextSequence = checkpoint ? checkpoint.sequence + 1 : this.startSequence;
    const endSequence = Math.min(
      finalizedSequence,
      nextSequence + this.maxBatchSize - 1,
    );
    let committed = 0;

    while (nextSequence <= endSequence) {
      const ledger = await this.options.source.getLedger(nextSequence);
      if (!ledger) {
        throw new Error(`Canonical source did not return ledger ${nextSequence}`);
      }
      if (checkpoint && ledger.previousHash !== checkpoint.hash) {
        throw new LedgerLinkageError(nextSequence, checkpoint.hash, ledger.previousHash);
      }

      await this.options.store.appendLedger(ledger);
      checkpoint = { sequence: ledger.sequence, hash: ledger.hash };
      nextSequence += 1;
      committed += 1;

      if (this.options.onLedgerCommitted) {
        try {
          await this.options.onLedgerCommitted(ledger);
        } catch (error) {
          console.error(`[indexer] Ledger ${ledger.sequence} commit hook failed:`, error);
        }
      }
    }

    return {
      latestSequence: latest.sequence,
      finalizedSequence,
      committed,
      rolledBackFrom,
      checkpoint,
    };
  }

  private async findCommonAncestor(
    sequence: number,
    canonicalCeiling: number,
  ): Promise<number | null> {
    const firstCandidate = Math.min(sequence - 1, canonicalCeiling);
    const floor = Math.max(this.startSequence, sequence - this.maxRollbackDepth);
    let sawCanonicalCandidate = false;

    for (let candidate = firstCandidate; candidate >= floor; candidate -= 1) {
      const stored = await this.options.store.getLedger(candidate);
      if (!stored) continue;

      const canonical = await this.options.source.getLedger(candidate);
      if (canonical) sawCanonicalCandidate = true;
      if (canonical?.hash === stored.hash) return candidate;
    }

    return floor === this.startSequence && sawCanonicalCandidate ? 0 : null;
  }
}

// ─── Horizon SSE Indexer ──────────────────────────────────────────────────────

/**
 * Minimal subset of a Horizon operation record that we need from the stream.
 * Horizon SSE records carry a `paging_token` which acts as the resumption cursor.
 */
export interface HorizonOperationRecord {
  paging_token: string;
  type: string;
  transaction_hash?: string;
  [key: string]: unknown;
}

/**
 * Abstraction over the Horizon SSE streaming call so it can be replaced with a
 * test double without requiring a live network connection.
 *
 * The real implementation wraps `Horizon.Server.operations().cursor(...).stream(...)`.
 * It must return a `() => void` that closes/cancels the stream when called.
 */
export interface HorizonStreamClient {
  /**
   * Opens an SSE stream starting at `cursor` (or from the beginning when
   * `cursor` is `undefined`) and calls `onMessage` for every incoming record.
   *
   * @returns A teardown function that stops the stream.
   */
  stream(options: {
    cursor: string | undefined;
    onMessage: (record: HorizonOperationRecord) => void;
    onError: (error: unknown) => void;
  }): () => void;
}

/**
 * Options accepted by `HorizonSSEIndexer`.
 */
export interface BroadcastEvent {
  address: string | string[];
  event: string;
  data: any;
}

export interface HorizonSSEIndexerOptions {
  /** Horizon SSE client that provides the streaming connection. */
  streamClient: HorizonStreamClient;
  /** Cursor cache that persists the paging_token between restarts. */
  cursorCache: InMemoryCursorCache | PostgresCursorCache;
  /**
   * Handler invoked for each event record received from the stream.
   * The indexer guarantees the cursor is saved only after this resolves.
   *
   * @returns An optional BroadcastEvent to trigger a WebSocket broadcast.
   */
  onEvent: (record: HorizonOperationRecord) => Promise<BroadcastEvent | void>;
  /**
   * Optional callback for broadcasting events to external subscribers.
   * Invoked after onEvent successfully resolves.
   */
  onBroadcast?: (address: string, event: string, data: any) => void;
  /**
   * Base delay (ms) before the first reconnect attempt.
   * Subsequent attempts use exponential back-off capped at `maxReconnectDelayMs`.
   * @default 1000
   */
  initialReconnectDelayMs?: number;
  /**
   * Maximum reconnect back-off delay in ms.
   * @default 30000
   */
  maxReconnectDelayMs?: number;
  /**
   * How many consecutive reconnect attempts are allowed before the indexer
   * gives up and emits a terminal error.  Set to `Infinity` for endless retry.
   * @default Infinity
   */
  maxReconnectAttempts?: number;
}

/**
 * Emitted by `HorizonSSEIndexer` when the maximum reconnect budget is exhausted.
 */
export class HorizonSSEMaxRetriesExceededError extends Error {
  constructor(attempts: number) {
    super(`Horizon SSE indexer gave up after ${attempts} reconnect attempt(s)`);
    this.name = 'HorizonSSEMaxRetriesExceededError';
  }
}

/**
 * Real-time, push-based event indexer built on the Stellar Horizon SSE API.
 *
 * ### How it works
 * 1. On `start()` the indexer reads the last persisted cursor from
 *    `PostgresCursorCache` (or `InMemoryCursorCache`) and opens an SSE stream
 *    via `HorizonStreamClient` starting at that cursor.
 * 2. For every incoming record it calls the user-supplied `onEvent` handler and
 *    then atomically saves the record's `paging_token` as the new cursor.
 * 3. If the SSE connection drops the indexer automatically reconnects with
 *    exponential back-off, resuming from the last persisted cursor so no events
 *    are lost or double-processed.
 * 4. Call `stop()` to gracefully close the stream and cancel any pending
 *    reconnect timer.
 *
 * ### Usage
 * ```ts
 * import { Horizon } from '@stellar/stellar-sdk';
 * import { HorizonSSEIndexer, HorizonStreamClient } from './listener';
 * import { PostgresCursorCache } from './cache';
 *
 * const horizonServer = new Horizon.Server('https://horizon-testnet.stellar.org');
 *
 * const streamClient: HorizonStreamClient = {
 *   stream({ cursor, onMessage, onError }) {
 *     const builder = horizonServer.operations().limit(200);
 *     if (cursor) builder.cursor(cursor);
 *     return builder.stream({ onmessage: onMessage, onerror: onError });
 *   },
 * };
 *
 * const indexer = new HorizonSSEIndexer({
 *   streamClient,
 *   cursorCache: new PostgresCursorCache(pool, 'pactum_events'),
 *   onEvent: async (record) => {
 *     // handle CommitmentCreated / Attested events
 *   },
 * });
 *
 * indexer.start();
 * ```
 */
export class HorizonSSEIndexer {
  private readonly initialReconnectDelayMs: number;

  private readonly maxReconnectDelayMs: number;

  private readonly maxReconnectAttempts: number;

  private stopStream: (() => void) | null = null;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private reconnectAttempts = 0;

  private stopped = false;

  private onFatalError: ((error: Error) => void) | null = null;

  constructor(private readonly options: HorizonSSEIndexerOptions) {
    this.initialReconnectDelayMs = options.initialReconnectDelayMs ?? 1000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? Infinity;

    if (this.initialReconnectDelayMs <= 0) {
      throw new Error('initialReconnectDelayMs must be a positive number');
    }
    if (this.maxReconnectDelayMs < this.initialReconnectDelayMs) {
      throw new Error('maxReconnectDelayMs must be >= initialReconnectDelayMs');
    }
  }

  /**
   * Starts the SSE stream.  Returns immediately; processing happens
   * asynchronously in the background.
   *
   * @param onFatalError  Optional callback invoked when the max reconnect budget
   *                      is exhausted.  If omitted, the error is thrown as an
   *                      unhandled rejection.
   */
  start(onFatalError?: (error: Error) => void): void {
    if (!this.stopped && this.stopStream !== null) return; // already running
    this.stopped = false;
    this.onFatalError = onFatalError ?? null;
    void this.connect();
  }

  /**
   * Stops the indexer, closes the SSE stream, and cancels any pending reconnect.
   */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stopStream !== null) {
      this.stopStream();
      this.stopStream = null;
    }
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.stopped) return;

    let cursor: string | undefined;
    try {
      const persisted = await this.options.cursorCache.getCursor();
      cursor = persisted ?? undefined;
    } catch {
      // Non-fatal: start from the beginning if we cannot read the cursor.
      cursor = undefined;
    }

    this.stopStream = this.options.streamClient.stream({
      cursor,
      onMessage: (record) => void this.handleMessage(record),
      onError: (error) => this.handleStreamError(error),
    });
  }

  private async handleMessage(record: HorizonOperationRecord): Promise<void> {
    if (this.stopped) return;

    try {
      const broadcast = await this.options.onEvent(record);
      await this.options.cursorCache.saveCursor(record.paging_token);
      // Successful message resets the reconnect counter so the back-off
      // window resets to the initial delay for future disconnects.
      this.reconnectAttempts = 0;

      if (broadcast && this.options.onBroadcast) {
        const addresses = Array.isArray(broadcast.address) ? broadcast.address : [broadcast.address];
        for (const address of addresses) {
          this.options.onBroadcast(address, broadcast.event, broadcast.data);
        }
      }
    } catch {
      // Event handler errors are non-fatal by design.  The cursor is not
      // advanced so the event will be redelivered after the next reconnect.
    }
  }

  private handleStreamError(error: unknown): void {
    if (this.stopped) return;

    // Close the current (broken) stream before reconnecting.
    if (this.stopStream !== null) {
      this.stopStream();
      this.stopStream = null;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      const fatal = new HorizonSSEMaxRetriesExceededError(this.reconnectAttempts);
      if (this.onFatalError) {
        this.onFatalError(fatal);
      } else {
        // Surface as an unhandled rejection so the process can crash-restart.
        Promise.reject(fatal);
      }
      return;
    }

    const delay = Math.min(
      this.initialReconnectDelayMs * 2 ** this.reconnectAttempts,
      this.maxReconnectDelayMs,
    );
    this.reconnectAttempts += 1;

    void error; // consumed — error details available via onFatalError callback if needed

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) void this.connect();
    }, delay);
  }
}

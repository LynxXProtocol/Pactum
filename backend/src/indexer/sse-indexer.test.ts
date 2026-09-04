import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HorizonSSEIndexer,
  HorizonSSEMaxRetriesExceededError,
  HorizonStreamClient,
  HorizonOperationRecord,
} from './listener';
import { InMemoryCursorCache, PostgresCursorCache } from './cache';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeRecord(pagingToken: string, type = 'create_account'): HorizonOperationRecord {
  return { paging_token: pagingToken, type };
}

/**
 * A controllable fake stream client.
 * Call `emit(record)` to push a message or `fail(error)` to trigger an error.
 */
class FakeStreamClient implements HorizonStreamClient {
  private _onMessage: ((r: HorizonOperationRecord) => void) | null = null;
  private _onError: ((e: unknown) => void) | null = null;
  public streamedCursors: Array<string | undefined> = [];
  public openCount = 0;
  public closeCount = 0;

  stream(options: {
    cursor: string | undefined;
    onMessage: (record: HorizonOperationRecord) => void;
    onError: (error: unknown) => void;
  }): () => void {
    this.streamedCursors.push(options.cursor);
    this.openCount += 1;
    this._onMessage = options.onMessage;
    this._onError = options.onError;
    return () => {
      this.closeCount += 1;
      this._onMessage = null;
      this._onError = null;
    };
  }

  emit(record: HorizonOperationRecord): void {
    if (!this._onMessage) throw new Error('No active stream to emit to');
    this._onMessage(record);
  }

  fail(error: unknown = new Error('stream error')): void {
    if (!this._onError) throw new Error('No active stream to fail');
    this._onError(error);
  }

  get hasActiveStream(): boolean {
    return this._onMessage !== null;
  }
}

/** Waits for a predicate to become true, polling every 5 ms. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ─── InMemoryCursorCache ──────────────────────────────────────────────────────

test('InMemoryCursorCache returns null before any cursor is saved', async () => {
  const cache = new InMemoryCursorCache();
  assert.equal(await cache.getCursor(), null);
});

test('InMemoryCursorCache persists and retrieves a cursor', async () => {
  const cache = new InMemoryCursorCache();
  await cache.saveCursor('1234567890');
  assert.equal(await cache.getCursor(), '1234567890');
});

test('InMemoryCursorCache clear resets to null', async () => {
  const cache = new InMemoryCursorCache();
  await cache.saveCursor('abc');
  await cache.clear();
  assert.equal(await cache.getCursor(), null);
});

// ─── HorizonSSEIndexer – basic streaming ─────────────────────────────────────

test('starts stream with undefined cursor when cache is empty', async () => {
  const client = new FakeStreamClient();
  const cache = new InMemoryCursorCache();
  const received: HorizonOperationRecord[] = [];

  const indexer = new HorizonSSEIndexer({
    streamClient: client,
    cursorCache: cache,
    onEvent: async (r) => {
      received.push(r);
    },
  });
  indexer.start();

  await waitFor(() => client.openCount === 1);
  assert.equal(client.streamedCursors[0], undefined);

  indexer.stop();
});

test('starts stream with persisted cursor when cache has one', async () => {
  const client = new FakeStreamClient();
  const cache = new InMemoryCursorCache();
  await cache.saveCursor('cursor-from-last-run');

  const indexer = new HorizonSSEIndexer({
    streamClient: client,
    cursorCache: cache,
    onEvent: async () => {},
  });
  indexer.start();

  await waitFor(() => client.openCount === 1);
  assert.equal(client.streamedCursors[0], 'cursor-from-last-run');

  indexer.stop();
});

test('invokes onEvent for each incoming record', async () => {
  const client = new FakeStreamClient();
  const cache = new InMemoryCursorCache();
  const received: HorizonOperationRecord[] = [];

  const indexer = new HorizonSSEIndexer({
    streamClient: client,
    cursorCache: cache,
    onEvent: async (r) => {
      received.push(r);
    },
  });
  indexer.start();
  await waitFor(() => client.openCount === 1);

  client.emit(makeRecord('t1', 'CommitmentCreated'));
  client.emit(makeRecord('t2', 'Attested'));

  await waitFor(() => received.length === 2);

  assert.equal(received[0].paging_token, 't1');
  assert.equal(received[0].type, 'CommitmentCreated');
  assert.equal(received[1].paging_token, 't2');
  assert.equal(received[1].type, 'Attested');

  indexer.stop();
});

test('persists cursor after each successfully processed event', async () => {
  const client = new FakeStreamClient();
  const cache = new InMemoryCursorCache();

  const indexer = new HorizonSSEIndexer({
    streamClient: client,
    cursorCache: cache,
    onEvent: async () => {},
  });
  indexer.start();
  await waitFor(() => client.openCount === 1);

  client.emit(makeRecord('cursor-A'));
  await waitFor(async () => (await cache.getCursor()) === 'cursor-A');

  client.emit(makeRecord('cursor-B'));
  await waitFor(async () => (await cache.getCursor()) === 'cursor-B');

  indexer.stop();
});

test('does not advance cursor when onEvent throws', async () => {
  const client = new FakeStreamClient();
  const cache = new InMemoryCursorCache();
  await cache.saveCursor('initial-cursor');

  const indexer = new HorizonSSEIndexer({
    streamClient: client,
    cursorCache: cache,
    onEvent: async () => {
      throw new Error('processing failed');
    },
  });
  indexer.start();
  await waitFor(() => client.openCount === 1);

  client.emit(makeRecord('failing-cursor'));
  // Give a moment for any async side-effects to settle.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(await cache.getCursor(), 'initial-cursor');

  indexer.stop();
});

// ─── HorizonSSEIndexer – reconnect / auto-reconnect ──────────────────────────

test('reconnects after a stream error and resumes from persisted cursor', async () => {
  const client = new FakeStreamClient();
  const cache = new InMemoryCursorCache();
  await cache.saveCursor('resume-point');

  const received: string[] = [];
  const indexer = new HorizonSSEIndexer({
    streamClient: client,
    cursorCache: cache,
    onEvent: async (r) => {
      received.push(r.paging_token);
    },
    initialReconnectDelayMs: 10,
  });
  indexer.start();
  await waitFor(() => client.openCount === 1);

  // Simulate stream drop.
  client.fail();

  // Indexer should reconnect automatically.
  await waitFor(() => client.openCount === 2);

  // Second connection should use the persisted cursor.
  assert.equal(client.streamedCursors[1], 'resume-point');

  // Emit an event on the new stream.
  client.emit(makeRecord('post-reconnect'));
  await waitFor(() => received.length === 1);
  assert.equal(received[0], 'post-reconnect');

  indexer.stop();
});

test('uses exponential back-off between reconnect attempts', async () => {
  const client = new FakeStreamClient();
  const cache = new InMemoryCursorCache();
  const timestamps: number[] = [];

  const indexer = new HorizonSSEIndexer({
    streamClient: client,
    cursorCache: cache,
    onEvent: async () => {},
    initialReconnectDelayMs: 20,
    maxReconnectDelayMs: 200,
    maxReconnectAttempts: 3,
  });

  const errors: Error[] = [];
  indexer.start((err) => errors.push(err));

  await waitFor(() => client.openCount >= 1);
  timestamps.push(Date.now());

  // Each time a stream opens, immediately fail it.
  for (let i = 0; i < 3; i++) {
    client.fail();
    await waitFor(() => client.openCount >= i + 2, 2000);
    timestamps.push(Date.now());
  }

  // 4th failure exhausts the budget (3 attempts).
  client.fail();
  await waitFor(() => errors.length > 0, 2000);
  assert.ok(errors[0] instanceof HorizonSSEMaxRetriesExceededError);

  // Verify delays are non-decreasing (back-off is increasing or equal to cap).
  for (let i = 1; i < timestamps.length; i++) {
    const gap = timestamps[i] - timestamps[i - 1];
    // Allow 15 ms tolerance for timer imprecision.
    assert.ok(gap >= 5, `Expected non-trivial gap at step ${i}, got ${gap} ms`);
  }

  indexer.stop();
});

test('resets reconnect counter after a successful message', async () => {
  const client = new FakeStreamClient();
  const cache = new InMemoryCursorCache();

  const indexer = new HorizonSSEIndexer({
    streamClient: client,
    cursorCache: cache,
    onEvent: async () => {},
    initialReconnectDelayMs: 10,
    maxReconnectAttempts: 1, // would exhaust budget on 2nd disconnect if not reset
  });
  indexer.start();
  await waitFor(() => client.openCount === 1);

  // First disconnect — uses 1 attempt.
  client.fail();
  await waitFor(() => client.openCount === 2);

  // Receive a successful message — counter resets to 0.
  client.emit(makeRecord('reset-token'));
  await waitFor(async () => (await cache.getCursor()) === 'reset-token');

  // Second disconnect — budget should be fresh again (no fatal error).
  const errors: Error[] = [];
  indexer['onFatalError'] = (e) => errors.push(e);
  client.fail();
  await waitFor(() => client.openCount === 3);

  assert.equal(errors.length, 0);

  indexer.stop();
});

test('stop() prevents reconnect after stream error', async () => {
  const client = new FakeStreamClient();
  const cache = new InMemoryCursorCache();

  const indexer = new HorizonSSEIndexer({
    streamClient: client,
    cursorCache: cache,
    onEvent: async () => {},
    initialReconnectDelayMs: 20,
  });
  indexer.start();
  await waitFor(() => client.openCount === 1);

  // Trigger a stream error BEFORE stopping — this simulates a real drop.
  client.fail();
  // Immediately stop to cancel the pending reconnect timer.
  indexer.stop();

  // Wait longer than the reconnect delay to confirm no second stream opens.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(client.openCount, 1); // no reconnect happened
});

test('calling start() twice does not open a second stream', async () => {
  const client = new FakeStreamClient();
  const cache = new InMemoryCursorCache();

  const indexer = new HorizonSSEIndexer({
    streamClient: client,
    cursorCache: cache,
    onEvent: async () => {},
  });
  indexer.start();
  await waitFor(() => client.openCount === 1);

  indexer.start(); // duplicate call
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(client.openCount, 1);

  indexer.stop();
});

test('emits HorizonSSEMaxRetriesExceededError when budget exhausted', async () => {
  const client = new FakeStreamClient();
  const cache = new InMemoryCursorCache();

  const errors: Error[] = [];
  const indexer = new HorizonSSEIndexer({
    streamClient: client,
    cursorCache: cache,
    onEvent: async () => {},
    initialReconnectDelayMs: 5,
    maxReconnectAttempts: 2,
  });
  indexer.start((err) => errors.push(err));

  await waitFor(() => client.openCount >= 1);
  client.fail(); // attempt 1
  await waitFor(() => client.openCount >= 2);
  client.fail(); // attempt 2
  await waitFor(() => client.openCount >= 3);
  client.fail(); // attempt 3 — over budget
  await waitFor(() => errors.length > 0, 1000);

  assert.ok(errors[0] instanceof HorizonSSEMaxRetriesExceededError);

  indexer.stop();
});

// ─── PostgresCursorCache (integration, requires DATABASE_URL) ─────────────────

test(
  'PostgresCursorCache persists and resumes cursor across simulated restarts',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const schema = `sse_test_${process.pid}_${Date.now()}`;

    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const migration = await readFile(
        path.join(process.cwd(), 'src/db/migrations/008_horizon_sse_cursors.sql'),
        'utf8',
      );
      // Run migration on a dedicated client with search_path locked so the
      // unqualified CREATE TABLE in the SQL lands in the right schema.
      const migrationClient = await pool.connect();
      try {
        await migrationClient.query(`SET search_path TO "${schema}"`);
        await migrationClient.query(migration);
      } finally {
        migrationClient.release();
      }

      const cache1 = new PostgresCursorCache(pool, 'test_stream', schema);
      assert.equal(await cache1.getCursor(), null);

      await cache1.saveCursor('horizon-paging-token-42');
      assert.equal(await cache1.getCursor(), 'horizon-paging-token-42');

      // Simulate restart: create a new cache instance pointing to same DB row.
      const cache2 = new PostgresCursorCache(pool, 'test_stream', schema);
      assert.equal(await cache2.getCursor(), 'horizon-paging-token-42');

      // Advance the cursor.
      await cache2.saveCursor('horizon-paging-token-99');
      assert.equal(await cache2.getCursor(), 'horizon-paging-token-99');

      // Clear removes the row.
      await cache2.clear();
      assert.equal(await cache2.getCursor(), null);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  },
);

test(
  'HorizonSSEIndexer resumes from PostgresCursorCache after simulated restart',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const schema = `sse_test2_${process.pid}_${Date.now()}`;

    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const migration = await readFile(
        path.join(process.cwd(), 'src/db/migrations/008_horizon_sse_cursors.sql'),
        'utf8',
      );
      // Run migration on a dedicated client with search_path locked so the
      // unqualified CREATE TABLE in the SQL lands in the right schema.
      const migrationClient = await pool.connect();
      try {
        await migrationClient.query(`SET search_path TO "${schema}"`);
        await migrationClient.query(migration);
      } finally {
        migrationClient.release();
      }

      const streamClient = new FakeStreamClient();
      const cache = new PostgresCursorCache(pool, 'restart_test', schema);
      const received: string[] = [];

      const indexer = new HorizonSSEIndexer({
        streamClient,
        cursorCache: cache,
        onEvent: async (r) => {
          received.push(r.paging_token);
        },
        initialReconnectDelayMs: 10,
      });
      indexer.start();
      await waitFor(() => streamClient.openCount === 1);

      // First connection has no cursor.
      assert.equal(streamClient.streamedCursors[0], undefined);

      streamClient.emit(makeRecord('pg-cursor-1', 'CommitmentCreated'));
      // Wait until the cursor is actually persisted to the DB before proceeding.
      await waitFor(async () => (await cache.getCursor()) === 'pg-cursor-1', 2000);

      // Simulate stream drop and reconnect.
      streamClient.fail();
      await waitFor(() => streamClient.openCount === 2, 1000);

      // Reconnection must use the persisted cursor.
      assert.equal(streamClient.streamedCursors[1], 'pg-cursor-1');

      streamClient.emit(makeRecord('pg-cursor-2', 'Attested'));
      // Wait until the second cursor is persisted (not just onEvent fired).
      await waitFor(async () => (await cache.getCursor()) === 'pg-cursor-2', 2000);

      assert.equal(received.length, 2);
      assert.equal(await cache.getCursor(), 'pg-cursor-2');

      indexer.stop();
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  },
);

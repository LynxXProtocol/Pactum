import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import type { Commitment, CommitmentFilters } from '@/lib/api';

const DB_NAME = 'pactum-local-indexer';
const DB_VERSION = 1;
const COMMITMENTS_STORE = 'commitments';
const META_STORE = 'meta';
const META_KEY = 'poller';

export interface LocalIndexerMeta {
  /** Soroban RPC `getEvents` pagination cursor for the next poll, if any. */
  cursor: string | null;
  /** The ledger a fresh (non-cursor) poll last started from — a fallback anchor. */
  lastLedgerSeq: number | null;
  lastPolledAt: number | null;
}

const DEFAULT_META: LocalIndexerMeta = { cursor: null, lastLedgerSeq: null, lastPolledAt: null };

interface PactumLocalIndexerDB extends DBSchema {
  [COMMITMENTS_STORE]: {
    key: number;
    value: Commitment;
    indexes: { 'by-issuer': string; 'by-counterparty': string };
  };
  [META_STORE]: {
    key: string;
    value: LocalIndexerMeta;
  };
}

let dbPromise: Promise<IDBPDatabase<PactumLocalIndexerDB>> | null = null;

function getDb(): Promise<IDBPDatabase<PactumLocalIndexerDB>> {
  dbPromise ??= openDB<PactumLocalIndexerDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const commitments = db.createObjectStore(COMMITMENTS_STORE, { keyPath: 'id' });
      commitments.createIndex('by-issuer', 'issuer');
      commitments.createIndex('by-counterparty', 'counterparty');
      db.createObjectStore(META_STORE);
    },
  });
  return dbPromise;
}

export async function upsertCommitment(commitment: Commitment): Promise<void> {
  const db = await getDb();
  await db.put(COMMITMENTS_STORE, commitment);
}

/**
 * Applies an `attested`/`disputed`/`resolved` event's status to an
 * already-indexed commitment. `outcome` is only touched when explicitly
 * provided — a `disputed` event changes `status` to `'Disputed'` but doesn't
 * carry (or overwrite) a final outcome, mirroring
 * frontend/src/store/useStore.ts's `applyEvent` handling of the same event.
 *
 * If the commitment hasn't been indexed yet (its `created` event's
 * `get_commitment` lookup is still in flight, or arrived in a later poll
 * batch), the patch is dropped rather than creating a partial record — the
 * next successful `created` handling fetches the full, already-up-to-date
 * commitment straight from the contract.
 */
export async function patchCommitmentStatus(
  id: number,
  updates: { status: Commitment['status']; outcome?: Commitment['outcome'] },
): Promise<void> {
  const db = await getDb();
  const existing = await db.get(COMMITMENTS_STORE, id);
  if (!existing) return;
  await db.put(COMMITMENTS_STORE, {
    ...existing,
    status: updates.status,
    outcome: updates.outcome !== undefined ? updates.outcome : existing.outcome,
  });
}

function matchesFilters(commitment: Commitment, filters: CommitmentFilters): boolean {
  if (filters.status && commitment.status !== filters.status) return false;
  if (
    filters.address &&
    commitment.issuer !== filters.address &&
    commitment.counterparty !== filters.address
  ) {
    return false;
  }
  return true;
}

/** Drop-in local replacement for `fetchCommitments` — same filters, same shape. */
export async function listCommitments(filters: CommitmentFilters = {}): Promise<Commitment[]> {
  const db = await getDb();
  const all = await db.getAll(COMMITMENTS_STORE);
  const filtered = all.filter((c) => matchesFilters(c, filters)).sort((a, b) => b.id - a.id);

  if (!filters.limit) return filtered;
  const page = filters.page && filters.page > 0 ? filters.page : 1;
  const start = (page - 1) * filters.limit;
  return filtered.slice(start, start + filters.limit);
}

export async function getMeta(): Promise<LocalIndexerMeta> {
  const db = await getDb();
  const stored = await db.get(META_STORE, META_KEY);
  return stored ?? DEFAULT_META;
}

export async function setMeta(meta: LocalIndexerMeta): Promise<void> {
  const db = await getDb();
  await db.put(META_STORE, meta, META_KEY);
}

/**
 * Wipes only the indexed commitments, leaving the poll cursor/meta alone. Used when a retention
 * gap forces the poller to resume from a later ledger than its old cursor: records already in the
 * store may have changed status during the un-indexed gap, so they're dropped rather than left
 * stale — the poll that follows re-discovers whatever `created` events still fall inside the new,
 * narrower window and fetches their current on-chain state fresh via `get_commitment`.
 */
export async function clearCommitments(): Promise<void> {
  const db = await getDb();
  await db.clear(COMMITMENTS_STORE);
}

/** Wipes all locally-indexed data and the poll cursor — a "reset local index" affordance. */
export async function clearAll(): Promise<void> {
  const db = await getDb();
  await db.clear(COMMITMENTS_STORE);
  await db.clear(META_STORE);
}

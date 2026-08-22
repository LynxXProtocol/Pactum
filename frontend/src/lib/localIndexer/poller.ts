import type { rpc } from '@stellar/stellar-sdk';

import type { Commitment, CommitmentStatus } from '@/lib/api';

import { clearCommitments, getMeta, patchCommitmentStatus, setMeta, upsertCommitment } from './db';
import { parseContractEvent, type CommitmentOutcomeName, type RawContractEvent } from './events';

/** Dependency-injected Soroban RPC surface the poller needs — see rpcClient.ts for the real implementation. */
export interface LocalIndexerRpcClient {
  getLatestLedger(): Promise<{ sequence: number }>;
  getEvents(
    request: rpc.Api.GetEventsRequest,
  ): Promise<{ events: RawContractEvent[]; cursor?: string }>;
  /** Reads `get_commitment(id)` and returns its decoded fields, or `null` if it can't be read. */
  getCommitment(id: number): Promise<Record<string, unknown> | null>;
}

export interface PollOptions {
  contractId: string;
  /**
   * How far back (in ledgers) to start when there's no stored cursor yet —
   * bounds how much history a freshly-enabled Local Indexer can see, since
   * public Soroban RPC only retains a limited window of events.
   */
  lookbackLedgers: number;
  pageLimit?: number;
}

export interface PollResult {
  eventsProcessed: number;
  commitmentsIndexed: number;
  /** True when the stored cursor fell outside the RPC's retention window and had to be reset. */
  retentionGapDetected: boolean;
}

const DEFAULT_PAGE_LIMIT = 100;

// Matches the contract's `CommitmentStatus` discriminant (contracts/registry/src/commitments.rs):
// 0=Pending, 1=Fulfilled, 2=Late, 3=Breached, 4=Disputed.
const STATUS_BY_ENUM: CommitmentStatus[] = ['Pending', 'Fulfilled', 'Late', 'Breached', 'Disputed'];

function statusFromEnum(value: unknown): CommitmentStatus {
  const index = typeof value === 'number' ? value : Number(value);
  return STATUS_BY_ENUM[index] ?? 'Pending';
}

/** Only the three terminal outcomes count as a final `outcome` — `Pending` and `Disputed` don't. */
function outcomeFromStatus(status: CommitmentStatus): Commitment['outcome'] {
  return status === 'Pending' || status === 'Disputed' ? null : status;
}

function toOptionalTimestamp(value: unknown): number | undefined {
  if (typeof value === 'bigint' || typeof value === 'number') return Number(value);
  return undefined;
}

function outcomeToStatus(outcome: CommitmentOutcomeName): CommitmentStatus {
  switch (outcome) {
    case 'fulfilled':
      return 'Fulfilled';
    case 'late':
      return 'Late';
    case 'breached':
      return 'Breached';
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Converts a decoded `get_commitment` result (see contracts/registry/src/commitments.rs::Commitment) into the frontend's `Commitment` shape. */
function toCommitment(raw: Record<string, unknown>): Commitment | null {
  const {
    id,
    issuer,
    counterparty,
    terms_hash: termsHash,
    due_at: dueAt,
    status: rawStatus,
    created_at: createdAt,
    attested_at: attestedAt,
  } = raw;

  if (
    (typeof id !== 'bigint' && typeof id !== 'number') ||
    typeof issuer !== 'string' ||
    typeof counterparty !== 'string' ||
    !(termsHash instanceof Uint8Array) ||
    (typeof dueAt !== 'bigint' && typeof dueAt !== 'number')
  ) {
    return null;
  }

  const status = statusFromEnum(rawStatus);

  return {
    id: Number(id),
    issuer,
    counterparty,
    terms_hash: bytesToHex(termsHash),
    due_at: Number(dueAt),
    status,
    outcome: outcomeFromStatus(status),
    created_at: toOptionalTimestamp(createdAt),
    attested_at: toOptionalTimestamp(attestedAt) ?? null,
  };
}

/** Matches the JSON-RPC error Soroban RPC returns when a start ledger predates its retention window. */
function isRetentionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === -32600 &&
    typeof candidate.message === 'string' &&
    /start ledger .* must be between the oldest ledger:/i.test(candidate.message)
  );
}

/**
 * Runs one poll: fetches the next page of `commitment_created`/`attested`/
 * `disputed`/`resolved` events for `options.contractId` since the last stored
 * cursor, applies them to the local IndexedDB store, and persists the new
 * cursor. Entirely RPC-driven — never touches the backend.
 */
export async function pollOnce(
  client: LocalIndexerRpcClient,
  options: PollOptions,
): Promise<PollResult> {
  const limit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const filters: rpc.Api.EventFilter[] = [{ type: 'contract', contractIds: [options.contractId] }];
  const meta = await getMeta();

  let retentionGapDetected = false;
  let nextLastLedgerSeq = meta.lastLedgerSeq;

  const fetchFromScratch = async (): Promise<{ events: RawContractEvent[]; cursor?: string }> => {
    const latest = await client.getLatestLedger();
    const startLedger = Math.max(1, latest.sequence - options.lookbackLedgers);
    nextLastLedgerSeq = startLedger;
    return client.getEvents({ filters, startLedger, limit });
  };

  let response: { events: RawContractEvent[]; cursor?: string };
  try {
    response = meta.cursor
      ? await client.getEvents({ filters, cursor: meta.cursor, limit })
      : await fetchFromScratch();
  } catch (error) {
    if (!isRetentionError(error)) throw error;
    retentionGapDetected = true;
    // Records already stored may have changed status during the un-indexed gap between the old
    // cursor and the new window — drop them rather than risk showing stale state indefinitely.
    // See db.ts::clearCommitments.
    await clearCommitments();
    response = await fetchFromScratch();
  }

  let commitmentsIndexed = 0;

  for (const rawEvent of response.events) {
    const parsed = parseContractEvent(rawEvent);
    if (!parsed) continue;

    if (parsed.type === 'created') {
      const raw = await client.getCommitment(Number(parsed.commitmentId));
      const commitment = raw ? toCommitment(raw) : null;
      if (commitment) {
        await upsertCommitment(commitment);
        commitmentsIndexed += 1;
      }
      continue;
    }

    if (parsed.type === 'attested' || parsed.type === 'resolved') {
      const status = outcomeToStatus(parsed.outcome);
      await patchCommitmentStatus(Number(parsed.commitmentId), { status, outcome: status });
      continue;
    }

    if (parsed.type === 'disputed') {
      // Outcome is left untouched — a dispute contests the current outcome, it doesn't set a new
      // one. Mirrors frontend/src/store/useStore.ts's `applyEvent` handling of the same event.
      await patchCommitmentStatus(Number(parsed.commitmentId), { status: 'Disputed' });
    }
  }

  await setMeta({
    cursor: response.cursor ?? null,
    lastLedgerSeq: nextLastLedgerSeq,
    lastPolledAt: Date.now(),
  });

  return {
    eventsProcessed: response.events.length,
    commitmentsIndexed,
    retentionGapDetected,
  };
}

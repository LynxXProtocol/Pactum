import 'fake-indexeddb/auto';

import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { beforeEach, describe, expect, it } from 'vitest';

import { clearAll, getMeta, listCommitments } from './db';
import type { RawContractEvent } from './events';
import { pollOnce, type LocalIndexerRpcClient } from './poller';

const CONTRACT_ID = 'CBADTVTJ6IN332HIKZ7LWUYMYTLPZYCEBV3X2HS47VHR5UDBHQ3GAA7E';
const ISSUER = 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';
const COUNTERPARTY = 'GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U';

const symbol = (value: string) => nativeToScVal(value, { type: 'symbol' });
const address = (value: string) => nativeToScVal(value, { type: 'address' });
const u64 = (value: number | bigint) => nativeToScVal(BigInt(value), { type: 'u64' });
const u32 = (value: number) => nativeToScVal(value, { type: 'u32' });

function createdEvent(id: number): RawContractEvent {
  return {
    topic: [symbol('created'), address(ISSUER), address(COUNTERPARTY)],
    value: xdr.ScVal.scvVec([u64(id), xdr.ScVal.scvVoid()]),
  };
}

function attestedEvent(id: number, outcome: number): RawContractEvent {
  return { topic: [symbol('attested'), u64(id)], value: u32(outcome) };
}

function disputedEvent(id: number): RawContractEvent {
  return { topic: [symbol('disputed'), u64(id)], value: xdr.ScVal.scvVoid() };
}

function rawCommitment(id: number, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: BigInt(id),
    issuer: ISSUER,
    counterparty: COUNTERPARTY,
    terms_hash: new Uint8Array(32).fill(7),
    due_at: BigInt(1_800_000_000),
    status: 0,
    created_at: BigInt(1_700_000_000),
    attested_at: undefined,
    ...overrides,
  };
}

interface FakeClientOptions {
  latestLedger?: number;
  getEvents: (
    request: Parameters<LocalIndexerRpcClient['getEvents']>[0],
  ) => ReturnType<LocalIndexerRpcClient['getEvents']>;
  commitments?: Record<number, Record<string, unknown> | null>;
}

function fakeClient(options: FakeClientOptions): LocalIndexerRpcClient {
  return {
    getLatestLedger: async () => ({ sequence: options.latestLedger ?? 1_000_000 }),
    getEvents: options.getEvents,
    getCommitment: async (id) =>
      options.commitments && id in options.commitments
        ? options.commitments[id]
        : rawCommitment(id),
  };
}

beforeEach(async () => {
  await clearAll();
});

describe('pollOnce', () => {
  it('starts from latest - lookback when there is no stored cursor, and indexes a created event', async () => {
    const client = fakeClient({
      latestLedger: 1_000_000,
      getEvents: async (request) => {
        expect(request).toMatchObject({ startLedger: 1_000_000 - 500, limit: 100 });
        return { events: [createdEvent(42)], cursor: 'cursor-1' };
      },
    });

    const result = await pollOnce(client, { contractId: CONTRACT_ID, lookbackLedgers: 500 });

    expect(result).toEqual({
      eventsProcessed: 1,
      commitmentsIndexed: 1,
      retentionGapDetected: false,
    });
    const [commitment] = await listCommitments();
    expect(commitment).toMatchObject({
      id: 42,
      issuer: ISSUER,
      counterparty: COUNTERPARTY,
      status: 'Pending',
      outcome: null,
      created_at: 1_700_000_000,
      attested_at: null,
    });
    expect(await getMeta()).toMatchObject({ cursor: 'cursor-1', lastLedgerSeq: 1_000_000 - 500 });
  });

  it('continues from the stored cursor on a subsequent poll', async () => {
    let seenRequest: unknown;
    const client = fakeClient({
      getEvents: async (request) => {
        seenRequest = request;
        return { events: [], cursor: 'cursor-2' };
      },
    });

    // Seed a cursor as if a previous poll already ran.
    await pollOnce(fakeClient({ getEvents: async () => ({ events: [], cursor: 'cursor-1' }) }), {
      contractId: CONTRACT_ID,
      lookbackLedgers: 500,
    });

    await pollOnce(client, { contractId: CONTRACT_ID, lookbackLedgers: 500 });

    expect(seenRequest).toMatchObject({ cursor: 'cursor-1', limit: 100 });
    expect(await getMeta()).toMatchObject({ cursor: 'cursor-2' });
  });

  it('patches status on an attested event for an already-indexed commitment', async () => {
    const seedClient = fakeClient({
      getEvents: async () => ({ events: [createdEvent(1)], cursor: 'c1' }),
    });
    await pollOnce(seedClient, { contractId: CONTRACT_ID, lookbackLedgers: 500 });

    const attestClient = fakeClient({
      getEvents: async () => ({ events: [attestedEvent(1, 1)], cursor: 'c2' }),
    });
    await pollOnce(attestClient, { contractId: CONTRACT_ID, lookbackLedgers: 500 });

    const [commitment] = await listCommitments();
    expect(commitment).toMatchObject({ id: 1, status: 'Fulfilled', outcome: 'Fulfilled' });
  });

  it('sets status to Disputed on a disputed event without touching outcome', async () => {
    const seedClient = fakeClient({
      getEvents: async () => ({ events: [createdEvent(1)], cursor: 'c1' }),
    });
    await pollOnce(seedClient, { contractId: CONTRACT_ID, lookbackLedgers: 500 });

    const disputeClient = fakeClient({
      getEvents: async () => ({ events: [disputedEvent(1)], cursor: 'c2' }),
    });
    await pollOnce(disputeClient, { contractId: CONTRACT_ID, lookbackLedgers: 500 });

    const [commitment] = await listCommitments();
    expect(commitment).toMatchObject({ id: 1, status: 'Disputed', outcome: null });
  });

  it('recovers from a retention-window error by resetting to latest - lookback, dropping stale local records', async () => {
    // Seed an indexed commitment and a stale cursor, as if a previous poll already ran.
    await pollOnce(
      fakeClient({
        getEvents: async () => ({ events: [createdEvent(1)], cursor: 'stale-cursor' }),
      }),
      { contractId: CONTRACT_ID, lookbackLedgers: 500 },
    );
    expect(await listCommitments()).toHaveLength(1);

    let calls = 0;
    const client = fakeClient({
      latestLedger: 2_000_000,
      getEvents: async (request) => {
        calls += 1;
        if (calls === 1) {
          expect(request).toMatchObject({ cursor: 'stale-cursor' });
          const error = new Error(
            'start ledger 1 must be between the oldest ledger: 1999000 and ...',
          );
          (error as unknown as { code: number }).code = -32600;
          throw error;
        }
        expect(request).toMatchObject({ startLedger: 2_000_000 - 500 });
        return { events: [], cursor: 'fresh-cursor' };
      },
    });

    const result = await pollOnce(client, { contractId: CONTRACT_ID, lookbackLedgers: 500 });

    expect(calls).toBe(2);
    expect(result.retentionGapDetected).toBe(true);
    // Commitment #1 may have changed status during the un-indexed gap — it's dropped rather than
    // shown with potentially-stale data. It would be re-discovered by a fresh `created` event if
    // still inside the new window; this poll's window had none.
    expect(await listCommitments()).toEqual([]);
    expect(await getMeta()).toMatchObject({
      cursor: 'fresh-cursor',
      lastLedgerSeq: 2_000_000 - 500,
    });
  });

  it('drops a created event whose get_commitment lookup fails', async () => {
    const client = fakeClient({
      getEvents: async () => ({ events: [createdEvent(1)], cursor: 'c1' }),
      commitments: { 1: null },
    });

    const result = await pollOnce(client, { contractId: CONTRACT_ID, lookbackLedgers: 500 });

    expect(result).toEqual({
      eventsProcessed: 1,
      commitmentsIndexed: 0,
      retentionGapDetected: false,
    });
    expect(await listCommitments()).toEqual([]);
  });
});

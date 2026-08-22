import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Commitment } from '@/lib/api';
import {
  clearAll,
  clearCommitments,
  getMeta,
  listCommitments,
  patchCommitmentStatus,
  setMeta,
  upsertCommitment,
} from './db';

function commitment(id: number, overrides: Partial<Commitment> = {}): Commitment {
  return {
    id,
    issuer: 'GAJKUMA6V4MJKQPFM4MXNMWQZX3CTMK2KMMCSZQPK5JXBZWBZM7S4C',
    counterparty: 'GB4UFBX57KE2RPEXB4NCPQHXL5UZL7HSFBVQ2YEZQDZ2DXR2X3CHHZX',
    terms_hash: 'a3f9c1d2e4b5678901234567890abcdef1234567890abcdef1234567890ab',
    due_at: 1700000000,
    status: 'Pending',
    outcome: null,
    ...overrides,
  };
}

beforeEach(async () => {
  await clearAll();
});

describe('listCommitments', () => {
  it('returns everything, newest id first, with no filters', async () => {
    await upsertCommitment(commitment(1));
    await upsertCommitment(commitment(2));

    const result = await listCommitments();
    expect(result.map((c) => c.id)).toEqual([2, 1]);
  });

  it('filters by status', async () => {
    await upsertCommitment(commitment(1, { status: 'Pending' }));
    await upsertCommitment(commitment(2, { status: 'Fulfilled', outcome: 'Fulfilled' }));

    const result = await listCommitments({ status: 'Fulfilled' });
    expect(result.map((c) => c.id)).toEqual([2]);
  });

  it('filters by address, matching either issuer or counterparty', async () => {
    const other = 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';
    await upsertCommitment(commitment(1, { issuer: other }));
    await upsertCommitment(commitment(2, { counterparty: other }));
    await upsertCommitment(commitment(3));

    const result = await listCommitments({ address: other });
    expect(result.map((c) => c.id).sort()).toEqual([1, 2]);
  });

  it('paginates when a limit is given', async () => {
    await upsertCommitment(commitment(1));
    await upsertCommitment(commitment(2));
    await upsertCommitment(commitment(3));

    const page1 = await listCommitments({ limit: 2, page: 1 });
    const page2 = await listCommitments({ limit: 2, page: 2 });
    expect(page1.map((c) => c.id)).toEqual([3, 2]);
    expect(page2.map((c) => c.id)).toEqual([1]);
  });
});

describe('patchCommitmentStatus', () => {
  it('updates status and outcome on an existing commitment', async () => {
    await upsertCommitment(commitment(1, { status: 'Pending', outcome: null }));

    await patchCommitmentStatus(1, { status: 'Fulfilled', outcome: 'Fulfilled' });

    const [result] = await listCommitments();
    expect(result).toMatchObject({ id: 1, status: 'Fulfilled', outcome: 'Fulfilled' });
  });

  it('leaves outcome untouched when only status is given, e.g. a dispute', async () => {
    await upsertCommitment(commitment(1, { status: 'Pending', outcome: null }));

    await patchCommitmentStatus(1, { status: 'Disputed' });

    const [result] = await listCommitments();
    expect(result).toMatchObject({ id: 1, status: 'Disputed', outcome: null });
  });

  it('is a no-op when the commitment has not been indexed yet', async () => {
    await patchCommitmentStatus(99, { status: 'Fulfilled', outcome: 'Fulfilled' });
    expect(await listCommitments()).toEqual([]);
  });
});

describe('clearCommitments', () => {
  it('wipes commitments but leaves meta alone', async () => {
    await upsertCommitment(commitment(1));
    await setMeta({ cursor: 'abc', lastLedgerSeq: 123, lastPolledAt: 456 });

    await clearCommitments();

    expect(await listCommitments()).toEqual([]);
    expect(await getMeta()).toEqual({ cursor: 'abc', lastLedgerSeq: 123, lastPolledAt: 456 });
  });
});

describe('meta', () => {
  it('defaults to an empty cursor before anything is stored', async () => {
    expect(await getMeta()).toEqual({ cursor: null, lastLedgerSeq: null, lastPolledAt: null });
  });

  it('persists whatever is written', async () => {
    await setMeta({ cursor: 'abc', lastLedgerSeq: 123, lastPolledAt: 456 });
    expect(await getMeta()).toEqual({ cursor: 'abc', lastLedgerSeq: 123, lastPolledAt: 456 });
  });
});

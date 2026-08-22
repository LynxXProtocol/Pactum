import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { parseContractEvent } from './events';

const ISSUER = 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';
const COUNTERPARTY = 'GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U';

const symbol = (value: string) => nativeToScVal(value, { type: 'symbol' });
const address = (value: string) => nativeToScVal(value, { type: 'address' });
const u64 = (value: number | bigint) => nativeToScVal(BigInt(value), { type: 'u64' });
const u32 = (value: number) => nativeToScVal(value, { type: 'u32' });
const voidVal = () => xdr.ScVal.scvVoid();

/**
 * Mirrors the `(id, schema_id)` tuple contracts/registry/src/events.rs
 * publishes as `commitment_created` data — encoded as a Soroban Vec, which
 * `scValToNative` decodes to a JS array.
 */
const createdData = (id: number, schemaId?: number) =>
  xdr.ScVal.scvVec([u64(id), schemaId === undefined ? voidVal() : u32(schemaId)]);

describe('parseContractEvent', () => {
  it('parses a created event, unwrapping the (id, schema_id) tuple', () => {
    const parsed = parseContractEvent({
      topic: [symbol('created'), address(ISSUER), address(COUNTERPARTY)],
      value: createdData(42, 7),
    });

    expect(parsed).toEqual({
      type: 'created',
      commitmentId: '42',
      issuer: ISSUER,
      counterparty: COUNTERPARTY,
    });
  });

  it('parses a created event whose schema_id is absent (None)', () => {
    const parsed = parseContractEvent({
      topic: [symbol('created'), address(ISSUER), address(COUNTERPARTY)],
      value: createdData(1),
    });

    expect(parsed).toMatchObject({ type: 'created', commitmentId: '1' });
  });

  it('still parses a created event if the value is ever a bare id instead of a tuple', () => {
    const parsed = parseContractEvent({
      topic: [symbol('created'), address(ISSUER), address(COUNTERPARTY)],
      value: u64(5),
    });

    expect(parsed).toEqual({
      type: 'created',
      commitmentId: '5',
      issuer: ISSUER,
      counterparty: COUNTERPARTY,
    });
  });

  it('parses an attested event into a final outcome', () => {
    const parsed = parseContractEvent({
      topic: [symbol('attested'), u64(7)],
      value: u32(2),
    });

    expect(parsed).toEqual({ type: 'attested', commitmentId: '7', outcome: 'late' });
  });

  it('parses a disputed event, ignoring its unit payload', () => {
    const parsed = parseContractEvent({
      topic: [symbol('disputed'), u64(9)],
      value: voidVal(),
    });

    expect(parsed).toEqual({ type: 'disputed', commitmentId: '9' });
  });

  it('parses a resolved event into its final outcome', () => {
    const parsed = parseContractEvent({
      topic: [symbol('resolved'), u64(3)],
      value: u32(3),
    });

    expect(parsed).toEqual({ type: 'resolved', commitmentId: '3', outcome: 'breached' });
  });

  it('maps every commitment status discriminant to an outcome', () => {
    const byStatus = [1, 2, 3].map((status) =>
      parseContractEvent({ topic: [symbol('attested'), u64(1)], value: u32(status) }),
    );

    expect(byStatus.map((parsed) => (parsed as { outcome: string }).outcome)).toEqual([
      'fulfilled',
      'late',
      'breached',
    ]);
  });

  it('ignores events from symbols other than the four handled events', () => {
    const parsed = parseContractEvent({ topic: [symbol('upgraded')], value: voidVal() });
    expect(parsed).toBeNull();
  });

  it('returns null for an event with no topics', () => {
    expect(parseContractEvent({ topic: [], value: voidVal() })).toBeNull();
  });

  it('returns null when the leading topic does not decode to a string symbol', () => {
    const nonSymbolTopic = xdr.ScVal.scvVec([]);
    expect(parseContractEvent({ topic: [nonSymbolTopic], value: voidVal() })).toBeNull();
  });
});

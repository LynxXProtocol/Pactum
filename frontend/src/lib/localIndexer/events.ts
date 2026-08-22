import { scValToNative, xdr } from '@stellar/stellar-sdk';

export type CommitmentOutcomeName = 'fulfilled' | 'late' | 'breached';

export interface LocalCreatedEvent {
  type: 'created';
  commitmentId: string;
  issuer: string;
  counterparty: string;
}

export interface LocalAttestedEvent {
  type: 'attested';
  commitmentId: string;
  outcome: CommitmentOutcomeName;
}

export interface LocalDisputedEvent {
  type: 'disputed';
  commitmentId: string;
}

export interface LocalResolvedEvent {
  type: 'resolved';
  commitmentId: string;
  outcome: CommitmentOutcomeName;
}

export type LocalContractEvent =
  LocalCreatedEvent | LocalAttestedEvent | LocalDisputedEvent | LocalResolvedEvent;

/**
 * The subset of a Soroban RPC `getEvents` entry the decoder needs — matches
 * `rpc.Api.EventResponse`'s `topic`/`value` shape (live `xdr.ScVal` objects,
 * not base64-serialized JSON, unlike the backend indexer's snapshot format).
 */
export interface RawContractEvent {
  topic: xdr.ScVal[];
  value: xdr.ScVal;
}

/**
 * A commitment id arrives as a u64, which the SDK surfaces as a bigint, a
 * number, or a decimal string depending on the code path that produced it.
 */
const toCommitmentId = (value: unknown): string | null => {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return null;
};

/**
 * `commitment_created` publishes `(id, schema_id)` as a tuple (see
 * contracts/registry/src/events.rs::commitment_created), which `scValToNative`
 * decodes to a JS array. Passing that array straight to `toCommitmentId`
 * matches none of its branches and silently drops the event — the same bug
 * present in backend/src/indexer/commitments.ts and events.ts. Unwrap the
 * tuple's first element before parsing; fall back to treating the value as a
 * bare id for resilience against any non-tuple shape.
 */
const toCreatedCommitmentId = (value: unknown): string | null => {
  if (Array.isArray(value)) return toCommitmentId(value[0]);
  return toCommitmentId(value);
};

const OUTCOME_BY_STATUS = new Map<number, CommitmentOutcomeName>([
  [1, 'fulfilled'],
  [2, 'late'],
  [3, 'breached'],
]);

/**
 * The contract's `CommitmentStatus` discriminant: 0=Pending, 1=Fulfilled,
 * 2=Late, 3=Breached, 4=Disputed. Attestations and dispute resolutions carry
 * the final outcome, so only the three terminal states map to an outcome name.
 */
const toOutcome = (value: unknown): CommitmentOutcomeName | null => {
  const status = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(status) ? (OUTCOME_BY_STATUS.get(status) ?? null) : null;
};

const decode = (value: xdr.ScVal): unknown => {
  try {
    return scValToNative(value);
  } catch {
    return undefined;
  }
};

/**
 * Decodes a single raw Soroban contract event into a typed record, keyed off
 * the leading topic symbol. Mirrors backend/src/indexer/events.ts's decoding
 * rules, adapted for the live `xdr.ScVal` objects `rpc.Server.getEvents()`
 * returns directly (no base64 round-trip needed client-side). Events from
 * other contracts/symbols or with undecodable payloads are skipped rather
 * than throwing, so one malformed event cannot stall a poll.
 */
export function parseContractEvent(event: RawContractEvent): LocalContractEvent | null {
  if (!Array.isArray(event.topic) || event.topic.length === 0) return null;

  const symbol = decode(event.topic[0]);
  if (typeof symbol !== 'string') return null;

  const topicValues = event.topic.slice(1).map((entry) => decode(entry));
  const value = decode(event.value);

  switch (symbol) {
    case 'created': {
      const [issuer, counterparty] = topicValues;
      const commitmentId = toCreatedCommitmentId(value);
      if (commitmentId === null || typeof issuer !== 'string' || typeof counterparty !== 'string') {
        return null;
      }
      return { type: 'created', commitmentId, issuer, counterparty };
    }
    case 'attested': {
      const commitmentId = toCommitmentId(topicValues[0]);
      const outcome = toOutcome(value);
      if (commitmentId === null || outcome === null) return null;
      return { type: 'attested', commitmentId, outcome };
    }
    case 'disputed': {
      const commitmentId = toCommitmentId(topicValues[0]);
      if (commitmentId === null) return null;
      return { type: 'disputed', commitmentId };
    }
    case 'resolved': {
      const commitmentId = toCommitmentId(topicValues[0]);
      const outcome = toOutcome(value);
      if (commitmentId === null || outcome === null) return null;
      return { type: 'resolved', commitmentId, outcome };
    }
    default:
      return null;
  }
}

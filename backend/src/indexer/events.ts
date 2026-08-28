import type { scValToNative as ScValToNative, xdr as ScValXdr } from '@stellar/stellar-sdk' with {
  'resolution-mode': 'import',
};
import { LedgerEvent, LedgerSnapshot } from './types';

export type CommitmentOutcomeName = 'fulfilled' | 'late' | 'breached';

export interface CommitmentCreatedEvent {
  type: 'created';
  commitmentId: string;
  issuer: string;
  counterparty: string;
}

export interface CommitmentAttestedEvent {
  type: 'attested';
  commitmentId: string;
  outcome: CommitmentOutcomeName;
}

export interface CommitmentDisputedEvent {
  type: 'disputed';
  commitmentId: string;
}

export interface CommitmentResolvedEvent {
  type: 'resolved';
  commitmentId: string;
  outcome: CommitmentOutcomeName;
}

/** An attestor cast a vote on a disputed commitment (`votecast` on-chain). */
export interface AttestorVotedEvent {
  type: 'votecast';
  commitmentId: string;
  attestor: string;
  outcome: CommitmentOutcomeName;
}

/**
 * A disputed commitment reached a final outcome via panel vote (`voteres`) or
 * fell back after the voting window elapsed (`votefall`). The gap between this
 * final outcome and an attestor's earlier `votecast` is the "overturned" signal.
 */
export interface AttestorResolvedEvent {
  type: 'voteres' | 'votefall';
  commitmentId: string;
  finalOutcome: CommitmentOutcomeName;
}

/** An attestor staked (`staked`) or withdrew (`unstaked`) funds. */
export interface AttestorStakeEvent {
  type: 'staked' | 'unstaked';
  attestor: string;
  amount: string;
}

export type ContractEvent =
  | CommitmentCreatedEvent
  | CommitmentAttestedEvent
  | CommitmentDisputedEvent
  | CommitmentResolvedEvent
  | AttestorVotedEvent
  | AttestorResolvedEvent
  | AttestorStakeEvent;

interface ScValDecoder {
  scValToNative: typeof ScValToNative;
  xdr: typeof ScValXdr;
}

// The SDK ships as an ES module while the indexer compiles to CommonJS, so it
// is imported lazily and the promise is reused across every event in a batch.
let decoderPromise: Promise<ScValDecoder> | null = null;

const decoder = (): Promise<ScValDecoder> => {
  decoderPromise ??= import('@stellar/stellar-sdk') as Promise<ScValDecoder>;
  return decoderPromise;
};

const decodeBase64 = async (encoded: string): Promise<unknown> => {
  const { scValToNative, xdr } = await decoder();
  return scValToNative(xdr.ScVal.fromXDR(encoded, 'base64'));
};

/**
 * A commitment id arrives as a u64, which the SDK surfaces as a bigint, a
 * number, or a decimal string depending on the code path that serialized it.
 */
const toCommitmentId = (value: unknown): string | null => {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return null;
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

/**
 * Decodes a single raw contract event (topics and value arrive as base64 ScVal
 * XDR) into a typed record, keyed off the leading topic symbol. Events from
 * other contracts, unknown symbols, and undecodable payloads are ignored.
 */
export const parseContractEvent = async (event: LedgerEvent): Promise<ContractEvent | null> => {
  const payload = event.payload as { topic?: unknown; value?: unknown } | null;
  if (!payload || typeof payload !== 'object') return null;
  if (!Array.isArray(payload.topic) || payload.topic.length === 0) return null;
  if (typeof payload.topic[0] !== 'string') return null;

  let symbol: unknown;
  try {
    symbol = await decodeBase64(payload.topic[0]);
  } catch {
    return null;
  }
  if (typeof symbol !== 'string') return null;

  const topicValues = await Promise.all(
    payload.topic.slice(1).map(async (entry) => {
      if (typeof entry !== 'string') return undefined;
      try {
        return await decodeBase64(entry);
      } catch {
        return undefined;
      }
    }),
  );

  let value: unknown;
  if (typeof payload.value === 'string') {
    try {
      value = await decodeBase64(payload.value);
    } catch {
      value = undefined;
    }
  } else {
    value = undefined;
  }

  switch (symbol) {
    case 'created': {
      const [issuer, counterparty] = topicValues;
      // The event value is (id, schema_id) -- a tuple, which scValToNative decodes as a JS
      // array. Tolerate a bare id too, for events indexed before schema_id/oracle were added
      // to commitment_created. See contracts/registry/src/events.rs::commitment_created and
      // the identical unwrap in ../commitments.ts::parseCommitmentCreatedEvents.
      const rawId = Array.isArray(value) ? value[0] : value;
      const commitmentId = toCommitmentId(rawId);
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
    case 'votecast': {
      const commitmentId = toCommitmentId(topicValues[0]);
      const attestor = topicValues[1];
      const outcome = toOutcome(value);
      if (commitmentId === null || typeof attestor !== 'string' || outcome === null) return null;
      return { type: 'votecast', commitmentId, attestor, outcome };
    }
    case 'voteres':
    case 'votefall': {
      const commitmentId = toCommitmentId(topicValues[0]);
      const finalOutcome = toOutcome(value);
      if (commitmentId === null || finalOutcome === null) return null;
      return { type: symbol as 'voteres' | 'votefall', commitmentId, finalOutcome };
    }
    case 'staked':
    case 'unstaked': {
      const attestor = topicValues[0];
      if (typeof attestor !== 'string') return null;
      if (typeof value !== 'bigint' && typeof value !== 'number' && typeof value !== 'string') {
        return null;
      }
      return { type: symbol as 'staked' | 'unstaked', attestor, amount: String(value) };
    }
    default:
      return null;
  }
};

export const parseLedgerEvents = async (ledger: LedgerSnapshot): Promise<ContractEvent[]> => {
  const events: ContractEvent[] = [];
  for (const event of ledger.events) {
    const parsed = await parseContractEvent(event);
    if (parsed) events.push(parsed);
  }
  return events;
};

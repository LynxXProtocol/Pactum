import { StrKey } from '@stellar/stellar-sdk';
import { doubleSha256, sha256 } from './merkleTree';
import { HeaderProof, ScoreData } from '../schemas/stateProof';

/**
 * Converts a Stellar account (G...), contract (C...), or hex string to a 32-byte Buffer.
 */
export function addressToBytes32(address: string): Buffer {
  const clean = address.trim();
  if (clean.startsWith('0x')) {
    const raw = clean.slice(2);
    if (!/^[0-9a-fA-F]{1,64}$/.test(raw)) {
      throw new Error(`Invalid hexadecimal address payload: ${clean}`);
    }
    const padded = raw.padStart(64, '0');
    return Buffer.from(padded, 'hex');
  }

  if (clean.startsWith('G')) {
    try {
      return Buffer.from(StrKey.decodeEd25519PublicKey(clean));
    } catch {
      // Fallback
    }
  }

  if (clean.startsWith('C')) {
    try {
      return Buffer.from(StrKey.decodeContract(clean));
    } catch {
      // Fallback
    }
  }

  // Fallback if plain hex without 0x
  if (/^[0-9a-fA-F]{64}$/.test(clean)) {
    return Buffer.from(clean, 'hex');
  }

  // Otherwise hash string to 32 bytes
  return sha256(Buffer.from(clean, 'utf8'));
}

/**
 * Encodes leaf payload into a 92-byte buffer matching Solidity abi.encodePacked:
 * - bytes32 contractId (32 bytes)
 * - bytes32 stellarAddress (32 bytes)
 * - uint32 score (4 bytes, BE)
 * - uint32 fulfilledCount (4 bytes, BE)
 * - uint32 lateCount (4 bytes, BE)
 * - uint32 breachedCount (4 bytes, BE)
 * - uint32 epoch (4 bytes, BE)
 * - uint64 sourceLedgerSeq (8 bytes, BE)
 */
export function encodeLeafPayload(
  contractIdBytes: Buffer,
  stellarAddressBytes: Buffer,
  scoreData: ScoreData
): Buffer {
  const buf = Buffer.alloc(92);

  contractIdBytes.copy(buf, 0, 0, 32);
  stellarAddressBytes.copy(buf, 32, 0, 32);
  buf.writeUInt32BE(scoreData.score, 64);
  buf.writeUInt32BE(scoreData.fulfilledCount, 68);
  buf.writeUInt32BE(scoreData.lateCount, 72);
  buf.writeUInt32BE(scoreData.breachedCount, 76);
  buf.writeUInt32BE(scoreData.epoch, 80);

  // Write uint64 sourceLedgerSeq as BigInt (8 bytes big endian)
  buf.writeBigUInt64BE(BigInt(scoreData.sourceLedgerSeq), 84);

  return buf;
}

/**
 * Computes the 32-byte SHA-256 leaf hash for a trust score contract data entry.
 */
export function computeLeafHash(
  contractId: string,
  stellarAddress: string,
  scoreData: ScoreData
): Buffer {
  const contractIdBytes = addressToBytes32(contractId);
  const stellarAddressBytes = addressToBytes32(stellarAddress);
  const payload = encodeLeafPayload(contractIdBytes, stellarAddressBytes, scoreData);
  return sha256(payload);
}

/**
 * Encodes header fields into buffer matching Solidity abi.encodePacked:
 * - uint32 ledgerSeq (4 bytes, BE)
 * - bytes32 previousLedgerHash (32 bytes)
 * - bytes32 txSetResultHash (32 bytes)
 * - bytes32 bucketListHash (32 bytes)
 * - uint32 ledgerVersion (4 bytes, BE)
 * Total: 104 bytes
 */
export function encodeHeaderPayload(
  ledgerSeq: number,
  headerProof: HeaderProof
): Buffer {
  const buf = Buffer.alloc(104);

  buf.writeUInt32BE(ledgerSeq, 0);

  const prevHash = Buffer.from(headerProof.previousLedgerHash.replace(/^0x/, ''), 'hex');
  const txHash = Buffer.from(headerProof.txSetResultHash.replace(/^0x/, ''), 'hex');
  const bucketHash = Buffer.from(headerProof.bucketListHash.replace(/^0x/, ''), 'hex');

  prevHash.copy(buf, 4, 0, 32);
  txHash.copy(buf, 36, 0, 32);
  bucketHash.copy(buf, 68, 0, 32);
  buf.writeUInt32BE(headerProof.ledgerVersion, 100);

  return buf;
}

/**
 * Computes the SHA-256 header hash from ledger sequence and header proof fields.
 */
export function computeHeaderHash(
  ledgerSeq: number,
  headerProof: HeaderProof
): Buffer {
  const payload = encodeHeaderPayload(ledgerSeq, headerProof);
  return sha256(payload);
}

/**
 * Packed aggregation commitment (84 bytes), matching Solidity abi.encodePacked:
 * - uint64 sequenceId (8 bytes, BE)
 * - bytes32 stellarAddress (32)
 * - bytes32 leafHash (32)
 * - uint32 score (4 bytes, BE)
 * - uint64 sourceLedgerSeq (8 bytes, BE)
 */
export function encodeAggregationPayload(
  sequenceId: number,
  stellarAddressBytes: Buffer,
  leafHash: Buffer,
  score: number,
  sourceLedgerSeq: number
): Buffer {
  const buf = Buffer.alloc(84);
  buf.writeBigUInt64BE(BigInt(sequenceId), 0);
  stellarAddressBytes.copy(buf, 8, 0, 32);
  leafHash.copy(buf, 40, 0, 32);
  buf.writeUInt32BE(score, 72);
  buf.writeBigUInt64BE(BigInt(sourceLedgerSeq), 76);
  return buf;
}

/**
 * Double-SHA256 aggregation leaf. Sequence id makes batch order unambiguous.
 */
export function computeAggregationLeaf(
  sequenceId: number,
  stellarAddress: string,
  leafHash: Buffer,
  score: number,
  sourceLedgerSeq: number
): Buffer {
  const payload = encodeAggregationPayload(
    sequenceId,
    addressToBytes32(stellarAddress),
    leafHash,
    score,
    sourceLedgerSeq
  );
  return doubleSha256(payload);
}

/** Compact EVM submission shape: no strings, no per-entry audit paths. */
export interface EvmCompactBatchEntry {
  stellarAddress: string;
  score: number;
  fulfilledCount: number;
  lateCount: number;
  breachedCount: number;
  epoch: number;
  sourceLedgerSeq: number;
}

export interface EvmBatchedStateProof {
  version: number;
  ledgerSeq: number;
  ledgerHeaderHash: string;
  contractId: string;
  aggregationRoot: string;
  headerProof: HeaderProof;
  entries: EvmCompactBatchEntry[];
}

/**
 * Maps an off-chain batched proof onto the compact ABI the Solidity verifier expects.
 */
export function toEvmBatchedStateProof(
  batch: {
    ledgerSeq: number;
    ledgerHeaderHash: string;
    contractId: string;
    aggregationRoot: string;
    headerProof: HeaderProof;
    entries: Array<{
      stellarAddress: string;
      scoreData: ScoreData;
    }>;
  }
): EvmBatchedStateProof {
  return {
    version: 1,
    ledgerSeq: batch.ledgerSeq,
    ledgerHeaderHash: batch.ledgerHeaderHash,
    contractId: `0x${addressToBytes32(batch.contractId).toString('hex')}`,
    aggregationRoot: batch.aggregationRoot,
    headerProof: batch.headerProof,
    entries: batch.entries.map((entry) => ({
      stellarAddress: `0x${addressToBytes32(entry.stellarAddress).toString('hex')}`,
      score: entry.scoreData.score,
      fulfilledCount: entry.scoreData.fulfilledCount,
      lateCount: entry.scoreData.lateCount,
      breachedCount: entry.scoreData.breachedCount,
      epoch: entry.scoreData.epoch,
      sourceLedgerSeq: entry.scoreData.sourceLedgerSeq,
    })),
  };
}

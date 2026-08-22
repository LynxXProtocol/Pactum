import { StrKey } from '@stellar/stellar-sdk';
import { sha256 } from './sha256';

export interface ScoreData {
  score: number;
  fulfilledCount: number;
  lateCount: number;
  breachedCount: number;
  epoch: number;
  sourceLedgerSeq: number;
}

export interface MerkleProofNode {
  sibling: string;
  isRight: boolean;
}

export interface HeaderProof {
  previousLedgerHash: string;
  txSetResultHash: string;
  bucketListHash: string;
  ledgerVersion: number;
}

export interface PactumStateProof {
  version: string;
  networkPassphrase: string;
  ledgerSeq: number;
  ledgerHeaderHash: string;
  stateRootHash: string;
  contractId: string;
  stellarAddress: string;
  scoreData: ScoreData;
  leafHash: string;
  merkleProof: MerkleProofNode[];
  headerProof: HeaderProof;
}

export interface VerificationResult {
  valid: boolean;
  score?: number;
  ledgerSeq?: number;
  stellarAddress?: string;
  contractId?: string;
  error?: string;
}

export function normalizeHex32(hex: string): string {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return `0x${clean.toLowerCase().padStart(64, '0')}`;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`Invalid hexadecimal string: ${hex}`);
  }
  if (clean.length % 2 !== 0) {
    throw new Error(`Invalid hex length: ${clean.length}`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '0x';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function addressToBytes32(address: string): Uint8Array {
  const clean = address.trim();
  if (clean.startsWith('0x')) {
    const raw = clean.slice(2);
    if (!/^[0-9a-fA-F]{1,64}$/.test(raw)) {
      throw new Error(`Invalid hexadecimal address payload: ${clean}`);
    }
    const padded = raw.padStart(64, '0');
    return hexToBytes(padded);
  }

  if (clean.startsWith('G')) {
    try {
      return StrKey.decodeEd25519PublicKey(clean);
    } catch {
      // Fallback if not standard StrKey
    }
  }

  if (clean.startsWith('C')) {
    try {
      return StrKey.decodeContract(clean);
    } catch {
      // Fallback if not standard StrKey
    }
  }

  if (/^[0-9a-fA-F]{64}$/.test(clean)) {
    return hexToBytes(clean);
  }

  // Fallback hash
  const encoder = new TextEncoder();
  return sha256(encoder.encode(clean));
}

/**
 * Encodes leaf payload (92 bytes):
 * - contractId (32 bytes)
 * - stellarAddress (32 bytes)
 * - score (4 bytes, BE)
 * - fulfilledCount (4 bytes, BE)
 * - lateCount (4 bytes, BE)
 * - breachedCount (4 bytes, BE)
 * - epoch (4 bytes, BE)
 * - sourceLedgerSeq (8 bytes, BE)
 */
export function computeLeafHash(
  contractId: string,
  stellarAddress: string,
  scoreData: ScoreData
): Uint8Array {
  const buf = new Uint8Array(92);
  const view = new DataView(buf.buffer);

  const contractBytes = addressToBytes32(contractId);
  const addressBytes = addressToBytes32(stellarAddress);

  buf.set(contractBytes, 0);
  buf.set(addressBytes, 32);

  view.setUint32(64, scoreData.score, false);
  view.setUint32(68, scoreData.fulfilledCount, false);
  view.setUint32(72, scoreData.lateCount, false);
  view.setUint32(76, scoreData.breachedCount, false);
  view.setUint32(80, scoreData.epoch, false);

  // uint64 sourceLedgerSeq
  const seq = BigInt(scoreData.sourceLedgerSeq);
  view.setUint32(84, Number(seq >> 32n), false);
  view.setUint32(88, Number(seq & 0xffffffffn), false);

  return sha256(buf);
}

/**
 * Computes the Merkle Root by hashing the leaf along the audit path.
 */
export function computeMerkleRoot(
  leaf: Uint8Array,
  merkleProof: MerkleProofNode[]
): Uint8Array {
  let current = leaf;

  for (const node of merkleProof) {
    const siblingBytes = hexToBytes(node.sibling);
    const combined = new Uint8Array(64);

    if (node.isRight) {
      combined.set(current, 0);
      combined.set(siblingBytes, 32);
    } else {
      combined.set(siblingBytes, 0);
      combined.set(current, 32);
    }

    current = sha256(combined);
  }

  return current;
}

/**
 * Computes the header hash from ledger sequence and header proof fields (104 bytes).
 */
export function computeHeaderHash(
  ledgerSeq: number,
  headerProof: HeaderProof
): Uint8Array {
  const buf = new Uint8Array(104);
  const view = new DataView(buf.buffer);

  view.setUint32(0, ledgerSeq, false);
  buf.set(hexToBytes(headerProof.previousLedgerHash), 4);
  buf.set(hexToBytes(headerProof.txSetResultHash), 36);
  buf.set(hexToBytes(headerProof.bucketListHash), 68);
  view.setUint32(100, headerProof.ledgerVersion, false);

  return sha256(buf);
}

/**
 * Verifies a zero-trust PactumStateProof against a known trusted Stellar ledger header hash.
 *
 * @param proof - The PactumStateProof object to verify.
 * @param trustedLedgerHeaderHash - Known Stellar block/ledger hash to verify against.
 * @returns VerificationResult with validation status and verified score.
 */
export function verifyPactumStateProof(
  proof: PactumStateProof,
  trustedLedgerHeaderHash?: string
): VerificationResult {
  try {
    if (!proof || proof.version !== '1.0.0') {
      return { valid: false, error: `Unsupported proof version: ${proof?.version}` };
    }

    if (!trustedLedgerHeaderHash) {
      return {
        valid: false,
        error: 'Trusted ledger header hash anchor is required for zero-trust verification',
      };
    }

    // 1. Verify Leaf Hash
    const expectedLeaf = computeLeafHash(
      proof.contractId,
      proof.stellarAddress,
      proof.scoreData
    );
    const expectedLeafHex = normalizeHex32(bytesToHex(expectedLeaf));
    const proofLeafHex = normalizeHex32(proof.leafHash);

    if (expectedLeafHex !== proofLeafHex) {
      return {
        valid: false,
        error: `Leaf hash mismatch. Claimed ${proof.leafHash}, computed ${expectedLeafHex}`,
      };
    }

    // 2. Verify Merkle Proof against State Root Hash
    const computedRoot = computeMerkleRoot(expectedLeaf, proof.merkleProof);
    const computedRootHex = normalizeHex32(bytesToHex(computedRoot));
    const proofStateRootHex = normalizeHex32(proof.stateRootHash);

    if (computedRootHex !== proofStateRootHex) {
      return {
        valid: false,
        error: `Merkle root mismatch. Claimed ${proof.stateRootHash}, computed ${computedRootHex}`,
      };
    }

    // 3. Verify BucketList / StateRoot match in Header Proof
    const headerBucketListHex = normalizeHex32(proof.headerProof.bucketListHash);
    if (headerBucketListHex !== proofStateRootHex) {
      return {
        valid: false,
        error: 'Header proof bucketListHash does not match stateRootHash',
      };
    }

    // 4. Verify Ledger Header Hash
    const computedHeader = computeHeaderHash(proof.ledgerSeq, proof.headerProof);
    const computedHeaderHex = normalizeHex32(bytesToHex(computedHeader));
    const proofHeaderHex = normalizeHex32(proof.ledgerHeaderHash);

    if (computedHeaderHex !== proofHeaderHex) {
      return {
        valid: false,
        error: `Ledger header hash mismatch. Claimed ${proof.ledgerHeaderHash}, computed ${computedHeaderHex}`,
      };
    }

    // 5. Verify against trusted header hash anchor
    const normalizedTrusted = normalizeHex32(trustedLedgerHeaderHash);
    if (proofHeaderHex !== normalizedTrusted) {
      return {
        valid: false,
        error: `Header hash ${proof.ledgerHeaderHash} does not match trusted hash ${trustedLedgerHeaderHash}`,
      };
    }

    return {
      valid: true,
      score: proof.scoreData.score,
      ledgerSeq: proof.ledgerSeq,
      stellarAddress: proof.stellarAddress,
      contractId: proof.contractId,
    };
  } catch (err) {
    return {
      valid: false,
      error: `Verification exception: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

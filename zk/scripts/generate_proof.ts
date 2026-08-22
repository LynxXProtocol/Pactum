import { buildPoseidon } from 'circomlibjs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface CommitmentOp {
  issuerAddress: string;      // Stellar address (G...)
  counterpartyAddress: string;
  termsHash: bigint;
  dueAt: bigint;
}

export interface BatchWitness {
  leafPos: bigint;
  siblings: bigint[];   // length BATCH_DEPTH
  pathBits: (0 | 1)[];  // length BATCH_DEPTH
}

export interface FraudProofInputs {
  claimedBatchRoot: bigint;   // what sequencer claimed
  operation: CommitmentOp;
  issuerSignature: string;
  merkleWitness: BatchWitness;
}

function addressToField(addr: string): bigint {
  const bytes = Buffer.from(addr, 'utf8');
  const hash = crypto.createHash('sha256').update(bytes).digest();
  return BigInt('0x' + hash.slice(0, 31).toString('hex'));
}

export async function generateFraudProof(inputs: FraudProofInputs) {
  const poseidon = await buildPoseidon();

  const issuerHash       = addressToField(inputs.operation.issuerAddress);
  const counterpartyHash = addressToField(inputs.operation.counterpartyAddress);

  const commitmentId = poseidon.F.toObject(
    poseidon([issuerHash, counterpartyHash, inputs.operation.termsHash, inputs.operation.dueAt])
  );

  const correctBatchRoot = computeBatchMerkleRoot(
    commitmentId,
    inputs.merkleWitness.siblings,
    inputs.merkleWitness.pathBits,
    poseidon
  );

  return {
    isFraud: inputs.claimedBatchRoot.toString() !== correctBatchRoot.toString(),
    correctBatchRoot,
  };
}

function computeBatchMerkleRoot(
  leaf: bigint,
  siblings: bigint[],
  pathBits: (0 | 1)[],
  poseidon: any
): bigint {
  let current = leaf;
  for (let i = 0; i < siblings.length; i++) {
    const [left, right] = pathBits[i] === 0
      ? [current, siblings[i]]
      : [siblings[i], current];
    current = poseidon.F.toObject(poseidon([left, right]));
  }
  return current;
}

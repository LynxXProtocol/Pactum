import * as crypto from "node:crypto";


import { buildPoseidon } from 'circomlibjs';
import { generateFraudProof } from '../scripts/generate_proof.ts';
import type { FraudProofInputs, CommitmentOp, BatchWitness } from '../scripts/generate_proof.ts';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as test from 'node:test';
import * as assert from 'node:assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('FraudProof circuit', () => {
  let poseidon: any;

  test.before(async () => {
    poseidon = await buildPoseidon();
  });

  function buildTestInputs(tamperPostStateRoot: boolean): FraudProofInputs {
    const operation: CommitmentOp = {
      issuerAddress: 'GCHQ...',
      counterpartyAddress: 'GCHQ...',
      termsHash: 12345n,
      dueAt: BigInt(Date.now()),
    };

    const merkleWitness: BatchWitness = {
      leafPos: 0n,
      siblings: new Array(10).fill(0n),
      pathBits: new Array(10).fill(0),
    };

    function addressToField(addr: string): bigint {
      const bytes = Buffer.from(addr, 'utf8');
      const hash = crypto.createHash('sha256').update(bytes).digest();
      return BigInt('0x' + hash.slice(0, 31).toString('hex'));
    }
    const issuerHash = addressToField(operation.issuerAddress);
    const counterpartyHash = addressToField(operation.counterpartyAddress);
    const commitmentId = poseidon.F.toObject(
      poseidon([issuerHash, counterpartyHash, operation.termsHash, operation.dueAt])
    );
    let realRoot = commitmentId;
    for (let i = 0; i < 10; i++) {
      realRoot = poseidon.F.toObject(poseidon([realRoot, 0n]));
    }

    return {
      claimedBatchRoot: tamperPostStateRoot ? realRoot + 1n : realRoot,
      operation,
      issuerSignature: '00'.repeat(64), // Dummy signature for test
      merkleWitness
    };
  }

  test.it('valid proof for a real fraud case', async () => {
    const inputs = buildTestInputs(true);
    const result = await generateFraudProof(inputs);
    assert.strictEqual(result.isFraud, true);
    assert.notStrictEqual(result.correctBatchRoot, inputs.claimedBatchRoot);
  });

  test.it('no fraud when sequencer is honest', async () => {
    const inputs = buildTestInputs(false);
    const result = await generateFraudProof(inputs);
    assert.strictEqual(result.isFraud, false);
    assert.strictEqual(result.correctBatchRoot.toString(), inputs.claimedBatchRoot.toString());
  });
});

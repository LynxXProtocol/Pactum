/**
 * End-to-end circuit tests.
 *
 * These need the compiled artifacts, so run `npm run build:circuit` first (which needs
 * `circom` on PATH). Without them the suite skips rather than silently passing.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import * as snarkjs from 'snarkjs';

import { generateTrustThresholdProof, toCircuitInput } from '../src/prove.ts';
import {
  buildPoseidonHash,
  buildSnapshot,
  findLeafIndex,
  merklePath,
  type MerklePath,
  type PoseidonHash,
  type ReputationSnapshot,
} from '../src/tree.ts';
import {
  PUBLIC_SIGNAL_ORDER,
  parsePublicSignals,
  verifyTrustThresholdProof,
  type VerificationKey,
} from '../src/verify.ts';
import { artifacts, circuitArtifactsPresent, testEntries } from './helpers.ts';

const CONTEXT_ID = 424242n;

describe(
  'trust_threshold circuit',
  { skip: circuitArtifactsPresent() ? false : 'run `npm run build:circuit` first' },
  () => {
    let hash: PoseidonHash;
    let snapshot: ReputationSnapshot;
    let vkey: VerificationKey;
    let scratch: string;

    const entries = testEntries();

    /** Path for the entry with the given score, from the real depth-16 snapshot. */
    function pathForScore(score: number): MerklePath {
      const entry = entries.find((candidate) => candidate.score === score);
      assert.ok(entry, `no test entry with score ${score}`);
      return merklePath(snapshot, findLeafIndex(entries, entry.address));
    }

    function requestFor(score: number, threshold: number) {
      const entry = entries.find((candidate) => candidate.score === score)!;
      return {
        address: entry.address,
        score,
        threshold,
        contextId: CONTEXT_ID,
        path: pathForScore(score),
      };
    }

    /**
     * Runs witness generation only.
     *
     * Failure cases fail here, before any proving key is touched, so asserting on
     * this is both faster and a more precise statement than "fullProve rejected".
     */
    async function calculateWitness(input: unknown): Promise<void> {
      await snarkjs.wtns.calculate(input, artifacts.wasm, join(scratch, 'witness.wtns'));
    }

    before(async () => {
      hash = await buildPoseidonHash();
      snapshot = buildSnapshot(hash, entries);
      vkey = JSON.parse(readFileSync(artifacts.vkey, 'utf8'));
      scratch = mkdtempSync(join(tmpdir(), 'pactum-zk-'));
    });

    after(async () => {
      // snarkjs caches a curve object backed by a worker pool. Without this the test
      // process stays alive after the last assertion.
      const curve = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
      await curve?.terminate();
    });

    it('proves and verifies a score comfortably above the threshold', async () => {
      const { proof, publicSignals } = await generateTrustThresholdProof(
        requestFor(950, 800),
        artifacts,
      );

      const result = await verifyTrustThresholdProof({
        proof,
        publicSignals,
        verificationKey: vkey,
        expectedRoot: snapshot.root,
        minThreshold: 800n,
        expectedContextId: CONTEXT_ID,
      });

      assert.equal(result.valid, true, result.valid ? '' : result.reason);
    });

    it('emits public signals in the documented order, and nothing else', async () => {
      const { publicSignals } = await generateTrustThresholdProof(requestFor(950, 800), artifacts);

      assert.equal(publicSignals.length, PUBLIC_SIGNAL_ORDER.length);

      const signals = parsePublicSignals(publicSignals);
      assert.equal(signals.aboveThreshold, 1n);
      assert.equal(signals.root, snapshot.root);
      assert.equal(signals.threshold, 800n);
      assert.equal(signals.contextId, CONTEXT_ID);

      // The score and the address must not be recoverable from anything published.
      assert.ok(!publicSignals.includes('950'), 'the exact score leaked into the public signals');
    });

    it('cannot produce a witness for a score below the threshold', async () => {
      await assert.rejects(() => calculateWitness(toCircuitInput(requestFor(799, 800))));
    });

    it('cannot produce a witness at the boundary, because the comparison is strict', async () => {
      await assert.rejects(() => calculateWitness(toCircuitInput(requestFor(800, 800))));
    });

    it('proves one point above the boundary', async () => {
      const { proof, publicSignals } = await generateTrustThresholdProof(
        requestFor(801, 800),
        artifacts,
      );

      const result = await verifyTrustThresholdProof({
        proof,
        publicSignals,
        verificationKey: vkey,
        expectedRoot: snapshot.root,
        minThreshold: 800n,
        expectedContextId: CONTEXT_ID,
      });

      assert.equal(result.valid, true, result.valid ? '' : result.reason);
    });

    it('cannot produce a witness from a tampered Merkle path', async () => {
      const input = toCircuitInput(requestFor(950, 800));
      input.pathElements[0] = (BigInt(input.pathElements[0]) + 1n).toString();

      await assert.rejects(() => calculateWitness(input));
    });

    it('cannot produce a witness from flipped path directions', async () => {
      const input = toCircuitInput(requestFor(950, 800));
      input.pathIndices[0] = input.pathIndices[0] === '1' ? '0' : '1';

      await assert.rejects(() => calculateWitness(input));
    });

    it('rejects a non-boolean path direction', async () => {
      const input = toCircuitInput(requestFor(950, 800));
      input.pathIndices[0] = '2';

      await assert.rejects(() => calculateWitness(input));
    });

    it('cannot claim membership with a score that is not the committed one', async () => {
      // Same address and path, but a score the indexer never published. The leaf no
      // longer matches, so the inclusion check fails even though the score clears 800.
      const input = toCircuitInput(requestFor(799, 700));
      input.score = '999';

      await assert.rejects(() => calculateWitness(input));
    });

    it('rejects a score wider than the range check allows', async () => {
      // Without the Num2Bits range checks a value like this could wrap the field and
      // make GreaterThan report the wrong answer. This asserts the guard is live.
      const input = toCircuitInput(requestFor(950, 800));
      input.score = (2n ** 32n).toString();

      await assert.rejects(() => calculateWitness(input));
    });

    it('rejects a threshold wider than the range check allows', async () => {
      const input = toCircuitInput(requestFor(950, 800));
      input.threshold = (2n ** 32n).toString();

      await assert.rejects(() => calculateWitness(input));
    });

    it('fails verification when a public signal is altered after proving', async () => {
      const { proof, publicSignals } = await generateTrustThresholdProof(
        requestFor(950, 800),
        artifacts,
      );

      const tampered = [...publicSignals];
      tampered[2] = '900'; // claim a higher threshold was proven than actually was

      const result = await verifyTrustThresholdProof({
        proof,
        publicSignals: tampered,
        verificationKey: vkey,
        expectedRoot: snapshot.root,
        minThreshold: 900n,
        expectedContextId: CONTEXT_ID,
      });

      assert.equal(result.valid, false);
      assert.match((result as { reason: string }).reason, /Groth16 verification failed/);
    });

    it('rejects a proof made against a different snapshot root', async () => {
      const { proof, publicSignals } = await generateTrustThresholdProof(
        requestFor(950, 800),
        artifacts,
      );

      const result = await verifyTrustThresholdProof({
        proof,
        publicSignals,
        verificationKey: vkey,
        expectedRoot: snapshot.root + 1n,
        minThreshold: 800n,
        expectedContextId: CONTEXT_ID,
      });

      assert.equal(result.valid, false);
      assert.match((result as { reason: string }).reason, /different reputation snapshot/);
    });

    it('rejects a proof replayed at a different verifier', async () => {
      const { proof, publicSignals } = await generateTrustThresholdProof(
        requestFor(950, 800),
        artifacts,
      );

      const result = await verifyTrustThresholdProof({
        proof,
        publicSignals,
        verificationKey: vkey,
        expectedRoot: snapshot.root,
        minThreshold: 800n,
        expectedContextId: CONTEXT_ID + 1n,
      });

      assert.equal(result.valid, false);
      assert.match((result as { reason: string }).reason, /different context/);
    });

    it('accepts a proof for a higher threshold than the verifier requires', async () => {
      // "> 900" is strictly stronger than "> 800", so a verifier asking for 800 should
      // take it. Proving the exact bar would otherwise force users to regenerate a
      // proof per verifier even when they already cleared a higher one.
      const { proof, publicSignals } = await generateTrustThresholdProof(
        requestFor(950, 900),
        artifacts,
      );

      const result = await verifyTrustThresholdProof({
        proof,
        publicSignals,
        verificationKey: vkey,
        expectedRoot: snapshot.root,
        minThreshold: 800n,
        expectedContextId: CONTEXT_ID,
      });

      assert.equal(result.valid, true, result.valid ? '' : result.reason);
    });

    it('rejects a proof for a lower threshold than the verifier requires', async () => {
      const { proof, publicSignals } = await generateTrustThresholdProof(
        requestFor(950, 500),
        artifacts,
      );

      const result = await verifyTrustThresholdProof({
        proof,
        publicSignals,
        verificationKey: vkey,
        expectedRoot: snapshot.root,
        minThreshold: 800n,
        expectedContextId: CONTEXT_ID,
      });

      assert.equal(result.valid, false);
      assert.match((result as { reason: string }).reason, /below the required/);
    });
  },
);

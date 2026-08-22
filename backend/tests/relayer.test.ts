import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MerkleTree } from '../src/relayer/merkleTree';
import { StateProofGenerator } from '../src/relayer/stateProofGenerator';
import { RelayerService } from '../src/relayer/relayerService';
import { ProofBatchEngine } from '../src/relayer/proofBatchEngine';
import { DurableProofQueue } from '../src/relayer/durableQueue';
import { verifyPactumStateProof, verifyPactumBatchedStateProof } from '../src/relayer/verifier';
import { computeHeaderHash, toEvmBatchedStateProof } from '../src/relayer/encoder';
import { pactumStateProofSchema, pactumBatchedStateProofSchema, ScoreData } from '../src/schemas/stateProof';

describe('Zero-Trust Oracle Relayer and State Proofs', () => {
  const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const stellarAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const networkPassphrase = 'Test SDF Network ; September 2015';

  const scoreData: ScoreData = {
    score: 92,
    fulfilledCount: 25,
    lateCount: 2,
    breachedCount: 0,
    epoch: 3,
    sourceLedgerSeq: 12000,
  };

  describe('MerkleTree', () => {
    it('builds a binary tree and generates verifiable proofs for all leaves', () => {
      const leaves = [
        Buffer.from('11'.repeat(32), 'hex'),
        Buffer.from('22'.repeat(32), 'hex'),
        Buffer.from('33'.repeat(32), 'hex'),
        Buffer.from('44'.repeat(32), 'hex'),
      ];

      const tree = new MerkleTree(leaves);
      const root = tree.getRoot();

      assert.ok(root);
      assert.equal(root.length, 32);

      for (let i = 0; i < leaves.length; i++) {
        const proof = tree.getProof(i);
        const isValid = MerkleTree.verify(leaves[i], proof, root);
        assert.equal(isValid, true);
      }
    });

    it('handles odd number of leaves gracefully by duplicating the last node', () => {
      const leaves = [
        Buffer.from('aa'.repeat(32), 'hex'),
        Buffer.from('bb'.repeat(32), 'hex'),
        Buffer.from('cc'.repeat(32), 'hex'),
      ];

      const tree = new MerkleTree(leaves);
      const root = tree.getRoot();

      for (let i = 0; i < leaves.length; i++) {
        const proof = tree.getProof(i);
        assert.equal(MerkleTree.verify(leaves[i], proof, root), true);
      }
    });
  });

  describe('StateProofGenerator and RelayerService', () => {
    let generator: StateProofGenerator;
    let relayerService: RelayerService;

    beforeEach(() => {
      generator = new StateProofGenerator({
        contractId,
        networkPassphrase,
      });

      relayerService = new RelayerService({
        contractId,
        networkPassphrase,
        pollIntervalMs: 1000,
      });
    });

    it('generates a valid, schema-compliant PactumStateProof', async () => {
      generator.setScoreData(stellarAddress, scoreData);

      const proof = await generator.generateProof(stellarAddress, {
        targetLedgerSeq: 12050,
      });

      // Assert schema compliance
      const parsed = pactumStateProofSchema.parse(proof);
      assert.equal(parsed.version, '1.0.0');
      assert.equal(parsed.stellarAddress, stellarAddress);
      assert.equal(parsed.scoreData.score, 92);

      // Independently compute expected header hash
      const expectedHeaderBuf = computeHeaderHash(proof.ledgerSeq, proof.headerProof);
      const knownTrustedHeader = `0x${expectedHeaderBuf.toString('hex')}`;

      // Verify cryptographically against known trusted header
      const result = verifyPactumStateProof(proof, knownTrustedHeader);
      assert.equal(result.valid, true);
      assert.equal(result.score, 92);
      assert.equal(result.ledgerSeq, 12050);

      // Rejects when trusted header is omitted
      const unanchoredResult = verifyPactumStateProof(proof);
      assert.equal(unanchoredResult.valid, false);
      assert.match(unanchoredResult.error || '', /anchor is required/i);

      // Rejects when unrelated trusted header is passed
      const wrongTrustedHeader = '0x' + '88'.repeat(32);
      const wrongResult = verifyPactumStateProof(proof, wrongTrustedHeader);
      assert.equal(wrongResult.valid, false);
      assert.match(wrongResult.error || '', /does not match trusted hash/i);
    });

    it('relayer service caches and serves generated state proofs', async () => {
      relayerService.updateScore(stellarAddress, scoreData);

      const proof = await relayerService.getProofForAddress(stellarAddress);
      assert.ok(proof);
      assert.equal(proof.stellarAddress, stellarAddress);

      const knownTrustedHeader = `0x${computeHeaderHash(proof.ledgerSeq, proof.headerProof).toString('hex')}`;
      const verifyResult = verifyPactumStateProof(proof, knownTrustedHeader);
      assert.equal(verifyResult.valid, true);
      assert.equal(verifyResult.score, 92);
    });

    it('detects and rejects tampered scores or corrupted proof nodes', async () => {
      generator.setScoreData(stellarAddress, scoreData);
      const proof = await generator.generateProof(stellarAddress);
      const knownTrustedHeader = `0x${computeHeaderHash(proof.ledgerSeq, proof.headerProof).toString('hex')}`;

      // 1. Tampered score
      const tamperedProof = {
        ...proof,
        scoreData: {
          ...proof.scoreData,
          score: 100, // Tampered
        },
      };
      assert.equal(verifyPactumStateProof(tamperedProof, knownTrustedHeader).valid, false);

      // 2. Tampered sibling
      const corruptedProof = {
        ...proof,
        merkleProof: proof.merkleProof.map(node => ({
          ...node,
          sibling: '0x' + '00'.repeat(32),
        })),
      };
      if (proof.merkleProof.length > 0) {
        assert.equal(verifyPactumStateProof(corruptedProof, knownTrustedHeader).valid, false);
      }
    });

    it('start and stop lifecycle functions execute cleanly', () => {
      relayerService.start();
      relayerService.stop();
    });

    it('autoStart starts the relayer automatically on construction', () => {
      const autoService = new RelayerService({
        contractId,
        networkPassphrase,
        pollIntervalMs: 1000,
        autoStart: true,
      });
      autoService.stop();
    });
  });

  describe('Multi-proof Merkle batching', () => {
    it('produces independently verifiable proofs for every requested leaf', () => {
      const leaves = [
        Buffer.from('11'.repeat(32), 'hex'),
        Buffer.from('22'.repeat(32), 'hex'),
        Buffer.from('33'.repeat(32), 'hex'),
        Buffer.from('44'.repeat(32), 'hex'),
      ];
      const tree = new MerkleTree(leaves);
      const compact = tree.getCompactMultiProof([0, 2, 3]);

      assert.equal(compact.indices.length, 3);
      assert.equal(
        MerkleTree.verifyMultiProof(
          compact.leaves.map((h) => Buffer.from(h.replace(/^0x/, ''), 'hex')),
          compact.proofs,
          Buffer.from(compact.root.replace(/^0x/, ''), 'hex')
        ),
        true
      );
    });

    it('reconstructs the same root from the ordered leaf set', () => {
      const leaves = [
        Buffer.from('aa'.repeat(32), 'hex'),
        Buffer.from('bb'.repeat(32), 'hex'),
        Buffer.from('cc'.repeat(32), 'hex'),
      ];
      const tree = new MerkleTree(leaves);
      assert.equal(MerkleTree.computeRootFromLeaves(leaves).equals(tree.getRoot()), true);
    });
  });

  describe('Batched state proof aggregation', () => {
    const hexAddr = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

    it('generates a schema-compliant unified batch proof that verifies as a whole and per entry', async () => {
      const generator = new StateProofGenerator({ contractId, networkPassphrase });
      const targets = [1, 2, 3, 4].map((n) => ({
        stellarAddress: hexAddr(n),
        scoreData: { ...scoreData, score: 60 + n, sourceLedgerSeq: 12000 + n },
      }));

      for (const t of targets) {
        generator.setScoreData(t.stellarAddress, t.scoreData);
      }

      const batch = await generator.generateBatchProof(targets.map((t) => t.stellarAddress), {
        targetLedgerSeq: 13000,
      });

      const parsed = pactumBatchedStateProofSchema.parse(batch);
      assert.equal(parsed.version, '1.1.0');
      assert.equal(parsed.entries.length, 4);
      parsed.entries.forEach((entry, i) => assert.equal(entry.sequenceId, i));

      const trusted = `0x${computeHeaderHash(batch.ledgerSeq, batch.headerProof).toString('hex')}`;
      const result = verifyPactumBatchedStateProof(batch, trusted);
      assert.equal(result.valid, true);
      assert.equal(result.entryCount, 4);
      assert.deepEqual(result.scores, targets.map((t) => t.scoreData.score).sort((a, b) => a - b));

      for (const entry of batch.entries) {
        assert.equal(
          MerkleTree.verify(
            Buffer.from(entry.leafHash.replace(/^0x/, ''), 'hex'),
            entry.merkleProof,
            Buffer.from(batch.stateRootHash.replace(/^0x/, ''), 'hex')
          ),
          true
        );
      }

      const evm = toEvmBatchedStateProof(batch);
      assert.equal(evm.version, 1);
      assert.equal(evm.entries.length, 4);
      assert.match(evm.contractId, /^0x[0-9a-f]{64}$/);
    });

    it('rejects a batch when the trusted header is wrong or an entry is tampered', async () => {
      const generator = new StateProofGenerator({ contractId, networkPassphrase });
      generator.setScoreData(hexAddr(1), scoreData);
      generator.setScoreData(hexAddr(2), { ...scoreData, score: 70 });

      const batch = await generator.generateBatchProof([hexAddr(1), hexAddr(2)]);
      const trusted = `0x${computeHeaderHash(batch.ledgerSeq, batch.headerProof).toString('hex')}`;

      assert.equal(verifyPactumBatchedStateProof(batch, '0x' + '88'.repeat(32)).valid, false);

      const tampered = {
        ...batch,
        entries: batch.entries.map((e, i) =>
          i === 0 ? { ...e, scoreData: { ...e.scoreData, score: 99 } } : e
        ),
      };
      assert.equal(verifyPactumBatchedStateProof(tampered, trusted).valid, false);
    });
  });

  describe('Polling engine TTL / max-batch + durable queue', () => {
    const hexAddr = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

    it('flushes when max batch size is reached', async () => {
      const generator = new StateProofGenerator({ contractId, networkPassphrase });
      const engine = new ProofBatchEngine({
        generator,
        maxBatchSize: 3,
        batchTtlMs: 60_000,
      });

      const first = await engine.enqueue(hexAddr(1), scoreData);
      const second = await engine.enqueue(hexAddr(2), { ...scoreData, score: 70 });
      assert.equal(first, null);
      assert.equal(second, null);
      assert.equal(engine.size(), 2);

      const flushed = await engine.enqueue(hexAddr(3), { ...scoreData, score: 80 });
      assert.ok(flushed, 'expected a flushed batch at max size');
      assert.equal(flushed!.entries.length, 3);
      assert.equal(engine.size(), 0);

      const trusted = `0x${computeHeaderHash(flushed!.ledgerSeq, flushed!.headerProof).toString('hex')}`;
      assert.equal(verifyPactumBatchedStateProof(flushed!, trusted).valid, true);
    });

    it('flushes when batch TTL elapses even if the batch is not full', async () => {
      let now = 1_000;
      const generator = new StateProofGenerator({ contractId, networkPassphrase });
      const engine = new ProofBatchEngine({
        generator,
        maxBatchSize: 32,
        batchTtlMs: 500,
        now: () => now,
      });

      await engine.enqueue(hexAddr(1), scoreData);
      assert.equal(engine.shouldFlush(), false);

      now = 1_600;
      assert.equal(engine.shouldFlush(), true);
      const flushed = await engine.flushIfDue();
      assert.ok(flushed, 'expected TTL flush');
      assert.equal(flushed!.entries.length, 1);
    });

    it('restores an in-flight buffer from the durable queue after restart', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pactum-batch-'));
      const persistPath = join(dir, 'queue.json');
      try {
        const generator = new StateProofGenerator({ contractId, networkPassphrase });
        const engine = new ProofBatchEngine({
          generator,
          maxBatchSize: 8,
          batchTtlMs: 60_000,
          persistPath,
        });
        await engine.enqueue(hexAddr(1), scoreData);
        await engine.enqueue(hexAddr(2), { ...scoreData, score: 71 });
        assert.equal(engine.size(), 2);

        const restarted = new ProofBatchEngine({
          generator: new StateProofGenerator({ contractId, networkPassphrase }),
          maxBatchSize: 8,
          persistPath,
        });
        await restarted.restore();
        assert.equal(restarted.size(), 2);

        const flushed = await restarted.flush();
        assert.ok(flushed, 'expected restored buffer to flush');
        assert.equal(flushed!.entries.length, 2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('durable queue replaces the same address in place instead of duplicating', async () => {
      const queue = new DurableProofQueue();
      await queue.enqueue(hexAddr(1), scoreData, 10);
      await queue.enqueue(hexAddr(1), { ...scoreData, score: 99 }, 20);
      assert.equal(queue.size(), 1);
      const only = queue.list()[0];
      assert.ok(only);
      assert.equal(only.scoreData.score, 99);
      assert.equal(only.enqueuedAt, 10);
    });
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const crypto = require("crypto");

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest();
}

function hexToBuf(hex) {
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

function bufToHex(buf) {
  return "0x" + buf.toString("hex");
}

function padAddr(n) {
  return ethers.zeroPadValue(ethers.toBeHex(n), 32);
}

function computeLeafHash(contractId, stellarAddress, scoreData) {
  const buf = Buffer.alloc(92);
  hexToBuf(contractId).copy(buf, 0, 0, 32);
  hexToBuf(stellarAddress).copy(buf, 32, 0, 32);
  buf.writeUInt32BE(scoreData.score, 64);
  buf.writeUInt32BE(scoreData.fulfilledCount, 68);
  buf.writeUInt32BE(scoreData.lateCount, 72);
  buf.writeUInt32BE(scoreData.breachedCount, 76);
  buf.writeUInt32BE(scoreData.epoch, 80);
  buf.writeBigUInt64BE(BigInt(scoreData.sourceLedgerSeq), 84);
  return bufToHex(sha256(buf));
}

function computeMerkleRoot(leafHex, merkleProof) {
  let current = hexToBuf(leafHex);
  for (const node of merkleProof) {
    const sibling = hexToBuf(node.sibling);
    if (node.isRight) {
      current = sha256(Buffer.concat([current, sibling]));
    } else {
      current = sha256(Buffer.concat([sibling, current]));
    }
  }
  return bufToHex(current);
}

function computeRootFromLeaves(leafHexes) {
  let layer = leafHexes.map(hexToBuf);
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : left;
      next.push(sha256(Buffer.concat([left, right])));
    }
    layer = next;
  }
  return bufToHex(layer[0]);
}

function computeAggregationLeaf(sequenceId, stellarAddress, leafHash, score, sourceLedgerSeq) {
  const buf = Buffer.alloc(84);
  buf.writeBigUInt64BE(BigInt(sequenceId), 0);
  hexToBuf(stellarAddress).copy(buf, 8, 0, 32);
  hexToBuf(leafHash).copy(buf, 40, 0, 32);
  buf.writeUInt32BE(score, 72);
  buf.writeBigUInt64BE(BigInt(sourceLedgerSeq), 76);
  return bufToHex(sha256(sha256(buf)));
}

function computeHeaderHash(ledgerSeq, headerProof) {
  const buf = Buffer.alloc(104);
  buf.writeUInt32BE(ledgerSeq, 0);
  hexToBuf(headerProof.previousLedgerHash).copy(buf, 4, 0, 32);
  hexToBuf(headerProof.txSetResultHash).copy(buf, 36, 0, 32);
  hexToBuf(headerProof.bucketListHash).copy(buf, 68, 0, 32);
  buf.writeUInt32BE(headerProof.ledgerVersion, 100);
  return bufToHex(sha256(buf));
}

describe("PactumStateProof aggregation pipeline", function () {
  const REGISTRY_CONTRACT_ID = ethers.id("soroban-registry-pactum");
  const BATCH_SIZE = 8;

  function createValidStateProof(overrides = {}) {
    const scoreData = {
      score: 88,
      fulfilledCount: 15,
      lateCount: 1,
      breachedCount: 0,
      epoch: 2,
      sourceLedgerSeq: 5000,
      ...(overrides.scoreData || {}),
    };

    const contractId = overrides.contractId !== undefined ? overrides.contractId : REGISTRY_CONTRACT_ID;
    const stellarAddress = overrides.stellarAddress !== undefined ? overrides.stellarAddress : padAddr(0x1234);
    const ledgerSeq = overrides.ledgerSeq !== undefined ? overrides.ledgerSeq : 5050;

    const leafHash = computeLeafHash(contractId, stellarAddress, scoreData);
    const merkleProof = overrides.merkleProof || [
      { sibling: "0x" + "aa".repeat(32), isRight: true },
      { sibling: "0x" + "bb".repeat(32), isRight: false },
    ];
    const stateRootHash = computeMerkleRoot(leafHash, merkleProof);
    const headerProof = {
      previousLedgerHash: "0x" + "11".repeat(32),
      txSetResultHash: "0x" + "22".repeat(32),
      bucketListHash: stateRootHash,
      ledgerVersion: 21,
      ...(overrides.headerProof || {}),
    };
    const ledgerHeaderHash = computeHeaderHash(ledgerSeq, headerProof);

    const {
      scoreData: _sd,
      contractId: _cid,
      stellarAddress: _sa,
      ledgerSeq: _ls,
      merkleProof: _mp,
      headerProof: _hp,
      ...restOverrides
    } = overrides;

    return {
      version: "1.0.0",
      networkPassphrase: "Test SDF Network ; September 2015",
      ledgerSeq,
      ledgerHeaderHash,
      stateRootHash,
      contractId,
      stellarAddress,
      scoreData,
      leafHash,
      merkleProof,
      headerProof,
      ...restOverrides,
    };
  }

  function createValidBatch(count = BATCH_SIZE, ledgerSeq = 9000) {
    const entries = [];
    const stateLeaves = [];
    const aggLeaves = [];

    for (let i = 1; i <= count; i++) {
      const stellarAddress = padAddr(i);
      const scoreData = {
        score: 50 + (i % 50),
        fulfilledCount: i,
        lateCount: 0,
        breachedCount: 0,
        epoch: 1,
        sourceLedgerSeq: 8000 + i,
      };
      const leafHash = computeLeafHash(REGISTRY_CONTRACT_ID, stellarAddress, scoreData);
      entries.push({
        stellarAddress,
        score: scoreData.score,
        fulfilledCount: scoreData.fulfilledCount,
        lateCount: scoreData.lateCount,
        breachedCount: scoreData.breachedCount,
        epoch: scoreData.epoch,
        sourceLedgerSeq: scoreData.sourceLedgerSeq,
      });
      stateLeaves.push(leafHash);
      aggLeaves.push(
        computeAggregationLeaf(i - 1, stellarAddress, leafHash, scoreData.score, scoreData.sourceLedgerSeq)
      );
    }

    const stateRoot = computeRootFromLeaves(stateLeaves);
    const aggregationRoot = computeRootFromLeaves(aggLeaves);
    const headerProof = {
      previousLedgerHash: "0x" + "11".repeat(32),
      txSetResultHash: "0x" + "22".repeat(32),
      bucketListHash: stateRoot,
      ledgerVersion: 21,
    };

    return {
      version: 1,
      ledgerSeq,
      ledgerHeaderHash: computeHeaderHash(ledgerSeq, headerProof),
      contractId: REGISTRY_CONTRACT_ID,
      aggregationRoot,
      headerProof,
      entries,
    };
  }

  async function deployFixture() {
    const [owner, relayer] = await ethers.getSigners();
    const Oracle = await ethers.getContractFactory("PactumZeroTrustOracle");
    const oracle = await Oracle.deploy(owner.address, REGISTRY_CONTRACT_ID);
    const Harness = await ethers.getContractFactory("StateProofVerifierHarness");
    const harness = await Harness.deploy();
    return { oracle, harness, owner, relayer };
  }

  it("unpacks a batched proof and caches every trust score", async function () {
    const { oracle, owner, relayer } = await loadFixture(deployFixture);
    const batch = createValidBatch(4);

    await oracle.connect(owner).setTrustedLedgerHeader(batch.ledgerSeq, batch.ledgerHeaderHash);

    const tx = await oracle.connect(relayer).submitBatchedStateProof(batch);
    await expect(tx)
      .to.emit(oracle, "BatchedStateProofVerified")
      .withArgs(batch.aggregationRoot, 4, batch.ledgerSeq, batch.ledgerHeaderHash, relayer.address);

    for (const entry of batch.entries) {
      const record = await oracle.getVerifiedTrustScore(entry.stellarAddress);
      expect(record.score).to.equal(entry.score);
      expect(record.fulfilledCount).to.equal(entry.fulfilledCount);
      expect(record.sourceLedgerSeq).to.equal(entry.sourceLedgerSeq);
      expect(record.verifiedHeaderHash).to.equal(batch.ledgerHeaderHash);
    }
  });

  it("rejects a batched proof with a tampered score", async function () {
    const { oracle, owner, relayer } = await loadFixture(deployFixture);
    const batch = createValidBatch(4);
    await oracle.connect(owner).setTrustedLedgerHeader(batch.ledgerSeq, batch.ledgerHeaderHash);
    batch.entries[0].score = 99;

    await expect(
      oracle.connect(relayer).submitBatchedStateProof(batch)
    ).to.be.revertedWithCustomError(oracle, "BucketListMismatch");
  });

  it("rejects unsorted batch entries", async function () {
    const { oracle, owner, relayer } = await loadFixture(deployFixture);
    const batch = createValidBatch(4);
    const tmp = batch.entries[0];
    batch.entries[0] = batch.entries[1];
    batch.entries[1] = tmp;
    await oracle.connect(owner).setTrustedLedgerHeader(batch.ledgerSeq, batch.ledgerHeaderHash);

    await expect(
      oracle.connect(relayer).submitBatchedStateProof(batch)
    ).to.be.revertedWithCustomError(oracle, "UnsortedBatchEntries");
  });

  it("reduces per-entry verification gas by at least 75% versus discrete proofs", async function () {
    const { harness } = await loadFixture(deployFixture);
    const discreteProofs = [];
    for (let i = 1; i <= BATCH_SIZE; i++) {
      discreteProofs.push(
        createValidStateProof({
          stellarAddress: padAddr(i),
          ledgerSeq: 5050 + i,
          scoreData: {
            score: 50 + i,
            fulfilledCount: i,
            lateCount: 0,
            breachedCount: 0,
            epoch: 2,
            sourceLedgerSeq: 4000 + i,
          },
        })
      );
    }

    let discreteTotal = 0n;
    for (const proof of discreteProofs) {
      discreteTotal += await harness.verifyProof.estimateGas(proof, proof.ledgerHeaderHash);
    }
    const discretePerEntry = discreteTotal / BigInt(BATCH_SIZE);

    const batch = createValidBatch(BATCH_SIZE);
    const batchGas = await harness.verifyBatchedProof.estimateGas(batch, batch.ledgerHeaderHash);
    const batchPerEntry = batchGas / BigInt(BATCH_SIZE);

    const reductionBps = ((discretePerEntry - batchPerEntry) * 10000n) / discretePerEntry;
    // eslint-disable-next-line no-console
    console.log(
      `verification gas: discrete ${discretePerEntry} /entry, batched ${batchPerEntry} /entry, reduction ${Number(reductionBps) / 100}%`
    );

    expect(batchPerEntry * 4n).to.be.lte(discretePerEntry);
  });
});

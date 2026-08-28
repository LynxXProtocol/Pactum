/* eslint-disable @typescript-eslint/no-unused-expressions */
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers');
const crypto = require('crypto');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function hexToBuf(hex) {
  return Buffer.from(hex.replace(/^0x/, ''), 'hex');
}

function bufToHex(buf) {
  return '0x' + buf.toString('hex');
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

function computeHeaderHash(ledgerSeq, headerProof) {
  const buf = Buffer.alloc(104);
  buf.writeUInt32BE(ledgerSeq, 0);
  hexToBuf(headerProof.previousLedgerHash).copy(buf, 4, 0, 32);
  hexToBuf(headerProof.txSetResultHash).copy(buf, 36, 0, 32);
  hexToBuf(headerProof.bucketListHash).copy(buf, 68, 0, 32);
  buf.writeUInt32BE(headerProof.ledgerVersion, 100);
  return bufToHex(sha256(buf));
}

describe('PactumZeroTrustOracle', function () {
  const REGISTRY_CONTRACT_ID = ethers.id('soroban-registry-pactum');
  const STELLAR_ADDRESS = ethers.zeroPadValue(ethers.toBeHex(0x1234), 32);

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

    const contractId =
      overrides.contractId !== undefined ? overrides.contractId : REGISTRY_CONTRACT_ID;
    const stellarAddress =
      overrides.stellarAddress !== undefined ? overrides.stellarAddress : STELLAR_ADDRESS;
    const ledgerSeq = overrides.ledgerSeq !== undefined ? overrides.ledgerSeq : 5050;

    const leafHash = computeLeafHash(contractId, stellarAddress, scoreData);

    const sibling1 = '0x' + 'aa'.repeat(32);
    const sibling2 = '0x' + 'bb'.repeat(32);
    const merkleProof = overrides.merkleProof || [
      { sibling: sibling1, isRight: true },
      { sibling: sibling2, isRight: false },
    ];

    const stateRootHash = computeMerkleRoot(leafHash, merkleProof);

    const headerProof = {
      previousLedgerHash: '0x' + '11'.repeat(32),
      txSetResultHash: '0x' + '22'.repeat(32),
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
      version: '1.0.0',
      networkPassphrase: 'Test SDF Network ; September 2015',
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

  async function deployFixture() {
    const [owner, relayer, user] = await ethers.getSigners();

    const Oracle = await ethers.getContractFactory('PactumZeroTrustOracle');
    const oracle = await Oracle.deploy(owner.address, REGISTRY_CONTRACT_ID);

    return { oracle, owner, relayer, user };
  }

  describe('Zero-Trust State Proof Verification', function () {
    it('successfully verifies proof and caches trust score when header is trusted', async function () {
      const { oracle, owner, relayer } = await loadFixture(deployFixture);

      const proof = createValidStateProof();

      // Register the trusted Stellar ledger header hash
      await oracle.connect(owner).setTrustedLedgerHeader(proof.ledgerSeq, proof.ledgerHeaderHash);
      expect(await oracle.isHeaderTrusted(proof.ledgerSeq, proof.ledgerHeaderHash)).to.be.true;

      // An untrusted relayer submits the proof
      const tx = await oracle.connect(relayer).submitStateProof(proof);
      await expect(tx)
        .to.emit(oracle, 'StateProofVerified')
        .withArgs(
          proof.stellarAddress,
          88,
          proof.ledgerSeq,
          proof.ledgerHeaderHash,
          relayer.address,
        );

      // Verify cached score record
      const record = await oracle.getVerifiedTrustScore(proof.stellarAddress);
      expect(record.score).to.equal(88);
      expect(record.fulfilledCount).to.equal(15);
      expect(record.lateCount).to.equal(1);
      expect(record.breachedCount).to.equal(0);
      expect(record.sourceLedgerSeq).to.equal(5000);
      expect(record.verifiedHeaderHash).to.equal(proof.ledgerHeaderHash);
      expect(await oracle.isScoreStale(proof.stellarAddress, 3600)).to.be.false;

      // Advance time beyond maxAge and check staleness
      await time.increase(3601);
      expect(await oracle.isScoreStale(proof.stellarAddress, 3600)).to.be.true;
    });

    it('allows batch registration of trusted ledger headers', async function () {
      const { oracle, owner } = await loadFixture(deployFixture);

      const seqs = [100, 200, 300];
      const hashes = ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32), '0x' + '33'.repeat(32)];

      await oracle.connect(owner).setTrustedLedgerHeadersBatch(seqs, hashes);

      expect(await oracle.isHeaderTrusted(100, hashes[0])).to.be.true;
      expect(await oracle.isHeaderTrusted(200, hashes[1])).to.be.true;
      expect(await oracle.isHeaderTrusted(300, hashes[2])).to.be.true;
    });

    it('rejects proof if header hash is not trusted', async function () {
      const { oracle, relayer } = await loadFixture(deployFixture);

      const proof = createValidStateProof();
      // Notice we do NOT register proof.ledgerHeaderHash as trusted

      await expect(oracle.connect(relayer).submitStateProof(proof)).to.be.revertedWithCustomError(
        oracle,
        'UntrustedHeader',
      );
    });

    it('rejects proof with mismatched contract registry id', async function () {
      const { oracle, owner, relayer } = await loadFixture(deployFixture);

      const fakeRegistryId = ethers.id('fake-registry-id');
      const proof = createValidStateProof({ contractId: fakeRegistryId });

      await oracle.connect(owner).setTrustedLedgerHeader(proof.ledgerSeq, proof.ledgerHeaderHash);

      await expect(oracle.connect(relayer).submitStateProof(proof)).to.be.revertedWithCustomError(
        oracle,
        'MismatchedRegistry',
      );
    });

    it('rejects proof with unsupported version', async function () {
      const { oracle, owner, relayer } = await loadFixture(deployFixture);

      const proof = createValidStateProof({ version: '2.0.0' });
      await oracle.connect(owner).setTrustedLedgerHeader(proof.ledgerSeq, proof.ledgerHeaderHash);

      await expect(oracle.connect(relayer).submitStateProof(proof)).to.be.revertedWithCustomError(
        oracle,
        'UnsupportedVersion',
      );
    });

    it('rejects proof with tampered trust score', async function () {
      const { oracle, owner, relayer } = await loadFixture(deployFixture);

      const proof = createValidStateProof();
      await oracle.connect(owner).setTrustedLedgerHeader(proof.ledgerSeq, proof.ledgerHeaderHash);

      // Tamper score inside scoreData without changing leafHash
      proof.scoreData.score = 100;

      await expect(oracle.connect(relayer).submitStateProof(proof)).to.be.revertedWithCustomError(
        oracle,
        'LeafHashMismatch',
      );
    });

    it('rejects proof with corrupted Merkle audit path', async function () {
      const { oracle, owner, relayer } = await loadFixture(deployFixture);

      const proof = createValidStateProof();
      await oracle.connect(owner).setTrustedLedgerHeader(proof.ledgerSeq, proof.ledgerHeaderHash);

      // Corrupt sibling
      proof.merkleProof[0].sibling = '0x' + 'ff'.repeat(32);

      await expect(oracle.connect(relayer).submitStateProof(proof)).to.be.revertedWithCustomError(
        oracle,
        'MerkleRootMismatch',
      );
    });

    it('rejects proof with corrupted header fields', async function () {
      const { oracle, owner, relayer } = await loadFixture(deployFixture);

      const proof = createValidStateProof();
      await oracle.connect(owner).setTrustedLedgerHeader(proof.ledgerSeq, proof.ledgerHeaderHash);

      // Corrupt previousLedgerHash
      proof.headerProof.previousLedgerHash = '0x' + '99'.repeat(32);

      await expect(oracle.connect(relayer).submitStateProof(proof)).to.be.revertedWithCustomError(
        oracle,
        'HeaderHashMismatch',
      );
    });

    it('rejects resubmission of same or older sourceLedgerSeq', async function () {
      const { oracle, owner, relayer } = await loadFixture(deployFixture);

      // First submit score at seq 6000
      const proof1 = createValidStateProof({
        ledgerSeq: 6050,
        scoreData: {
          score: 90,
          fulfilledCount: 20,
          lateCount: 0,
          breachedCount: 0,
          epoch: 2,
          sourceLedgerSeq: 6000,
        },
      });
      await oracle.connect(owner).setTrustedLedgerHeader(proof1.ledgerSeq, proof1.ledgerHeaderHash);
      await oracle.connect(relayer).submitStateProof(proof1);

      // 1. Resubmit the exact same proof (same sourceLedgerSeq 6000)
      await expect(oracle.connect(relayer).submitStateProof(proof1)).to.be.revertedWithCustomError(
        oracle,
        'StaleLedgerSeq',
      );

      // 2. Attempt to submit older score at seq 4000
      const proof2 = createValidStateProof({
        ledgerSeq: 4050,
        scoreData: {
          score: 70,
          fulfilledCount: 10,
          lateCount: 0,
          breachedCount: 0,
          epoch: 1,
          sourceLedgerSeq: 4000,
        },
      });
      await oracle.connect(owner).setTrustedLedgerHeader(proof2.ledgerSeq, proof2.ledgerHeaderHash);

      await expect(oracle.connect(relayer).submitStateProof(proof2)).to.be.revertedWithCustomError(
        oracle,
        'StaleLedgerSeq',
      );
    });
  });

  describe('Owner Configuration & Permissions', function () {
    it('only owner can update trusted ledger headers and registry contract ID', async function () {
      const { oracle, user } = await loadFixture(deployFixture);

      await expect(
        oracle.connect(user).setTrustedLedgerHeader(100, '0x' + '11'.repeat(32)),
      ).to.be.revertedWithCustomError(oracle, 'OwnableUnauthorizedAccount');

      await expect(
        oracle.connect(user).setRegistryContractId(ethers.id('new-id')),
      ).to.be.revertedWithCustomError(oracle, 'OwnableUnauthorizedAccount');
    });
  });
});

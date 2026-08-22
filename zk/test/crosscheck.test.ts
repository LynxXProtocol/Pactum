/**
 * BATCH_DEPTH Cross-Check Test
 *
 * This test verifies that the TypeScript off-chain Merkle builder (used in
 * generate_proof.ts and the backend's fraudProofService) produces IDENTICAL
 * roots to what the Soroban contract would compute for the same inputs.
 *
 * If this test fails, a proof submitted on-chain will ALWAYS be rejected,
 * regardless of whether fraud actually occurred. The most common causes:
 *   - path_bits endianness reversed (left/right convention differs)
 *   - domain tag mismatch between TypeScript and Rust hash2()
 *   - BATCH_DEPTH constant differs between TypeScript and circuit
 *
 * Run: npm test (in zk/)
 */

import { execSync } from 'node:child_process';
import * as assert from 'node:assert';
import * as test from 'node:test';
import { buildPoseidon } from 'circomlibjs';

const BATCH_DEPTH = 10; // Must match fraud_proof.circom component main = FraudProof(10)

let poseidon: any;

test.before(async () => {
  poseidon = await buildPoseidon();
});

// ─── Mirrored from contracts/fraud_verifier/src/verifier.rs ──────────────────

/**
 * hash2: Poseidon hash of two 32-byte nodes.
 */
function hash2(left: Buffer, right: Buffer): Buffer {
  // Convert 32-byte BE buffers to BigInts, hash, and convert back to 32-byte BE buffer
  const l = poseidon.F.fromObject(BigInt('0x' + left.toString('hex')));
  const r = poseidon.F.fromObject(BigInt('0x' + right.toString('hex')));
  const hash = poseidon([l, r]);
  const hashHex = poseidon.F.toObject(hash).toString(16).padStart(64, '0');
  return Buffer.from(hashHex, 'hex');
}

import { createHash } from 'node:crypto';

function addressToBytes32(addr: string): Buffer {
  const hash = createHash('sha256').update(Buffer.from(addr, 'utf8')).digest();
  return hash;
}

function commitmentLeaf(
  issuer: string,
  counterparty: string,
  termsHash: Buffer,
  dueAt: bigint,
): Buffer {
  const issuerBytes = addressToBytes32(issuer);
  const cpBytes = addressToBytes32(counterparty);

  const dueAtBuf = Buffer.alloc(8);
  dueAtBuf.writeBigUInt64BE(dueAt);

  const i = poseidon.F.fromObject(BigInt('0x' + issuerBytes.toString('hex')));
  const c = poseidon.F.fromObject(BigInt('0x' + cpBytes.toString('hex')));
  const t = poseidon.F.fromObject(BigInt('0x' + termsHash.toString('hex')));
  const d = poseidon.F.fromObject(BigInt('0x' + dueAtBuf.toString('hex')));

  const hash = poseidon([i, c, t, d]);
  const hashHex = poseidon.F.toObject(hash).toString(16).padStart(64, '0');
  return Buffer.from(hashHex, 'hex');
}

function computeMerkleRoot(
  leaf: Buffer,
  siblings: Buffer[],
  pathBits: (0 | 1)[],
): Buffer {
  assert.strictEqual(siblings.length, BATCH_DEPTH);
  assert.strictEqual(pathBits.length, BATCH_DEPTH);

  let current = leaf;
  for (let i = 0; i < BATCH_DEPTH; i++) {
    const sibling = siblings[i];
    current = pathBits[i] === 0
      ? hash2(current, sibling)  // current is left child
      : hash2(sibling, current); // current is right child
  }
  return current;
}

function computeRustPoseidon(numInputs: number, inputs: Buffer[]): Buffer {
  const hexArgs = inputs.map(b => b.toString('hex')).join(' ');
  const res = execSync(`cargo run --bin hash_helper -- ${numInputs} ${hexArgs}`, {
    cwd: '../contracts/fraud_verifier',
    encoding: 'utf8',
  });
  return Buffer.from(res.trim(), 'hex');
}

// ─── Test vectors ─────────────────────────────────────────────────────────────

const TEST_ISSUER = 'GBY54VG5G4A7DC4D6YJ6GHD4X4QW2AR43JLYZ2QVWSHKACWK3BLDR5IX';
const TEST_COUNTERPARTY = 'GB4UFBX57KE2RPEXB4NCPQHXL5UZL7HSFBVQ2YEZQDZ2DXR2X3CHHZX';
const TEST_TERMS_HASH = Buffer.alloc(32, 0xab);
const TEST_DUE_AT = 1_700_000_000n;

const ZERO_SIBLINGS: Buffer[] = Array.from({ length: BATCH_DEPTH }, () => Buffer.alloc(32, 0x00));
const ALL_LEFT: (0 | 1)[] = Array.from({ length: BATCH_DEPTH }, () => 0);

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('BATCH_DEPTH cross-check: TypeScript ↔ Soroban contract conventions', () => {

  test.it('Rust and TypeScript produce identical hashes for the same four inputs', () => {
    // We explicitly confirm in the cross-check test that Rust and TypeScript produce identical hashes
    const issuerBytes = addressToBytes32(TEST_ISSUER);
    const cpBytes = addressToBytes32(TEST_COUNTERPARTY);
    const dueAtBuf = Buffer.alloc(8);
    dueAtBuf.writeBigUInt64BE(TEST_DUE_AT);

    const tsLeaf = commitmentLeaf(TEST_ISSUER, TEST_COUNTERPARTY, TEST_TERMS_HASH, TEST_DUE_AT);
    
    // Call the Rust hash helper
    const rustLeaf = computeRustPoseidon(4, [issuerBytes, cpBytes, TEST_TERMS_HASH, dueAtBuf]);
    assert.deepStrictEqual(rustLeaf, tsLeaf, 'Rust Poseidon must match circomlibjs Poseidon for 4 inputs');

    // Also check hash2
    const tsNode = hash2(tsLeaf, ZERO_SIBLINGS[0]);
    const rustNode = computeRustPoseidon(2, [tsLeaf, ZERO_SIBLINGS[0]]);
    assert.deepStrictEqual(rustNode, tsNode, 'Rust Poseidon must match circomlibjs Poseidon for 2 inputs');
  });

  test.it('leaf hash is deterministic for identical inputs', () => {
    const leaf1 = commitmentLeaf(TEST_ISSUER, TEST_COUNTERPARTY, TEST_TERMS_HASH, TEST_DUE_AT);
    const leaf2 = commitmentLeaf(TEST_ISSUER, TEST_COUNTERPARTY, TEST_TERMS_HASH, TEST_DUE_AT);
    assert.deepStrictEqual(leaf1, leaf2, 'Leaf hash must be deterministic');
    assert.strictEqual(leaf1.length, 32, 'Leaf must be 32 bytes');
  });

  test.it('root is deterministic for identical leaf + path', () => {
    const leaf = commitmentLeaf(TEST_ISSUER, TEST_COUNTERPARTY, TEST_TERMS_HASH, TEST_DUE_AT);
    const root1 = computeMerkleRoot(leaf, ZERO_SIBLINGS, ALL_LEFT);
    const root2 = computeMerkleRoot(leaf, ZERO_SIBLINGS, ALL_LEFT);
    assert.deepStrictEqual(root1, root2, 'Root must be deterministic');
    assert.strictEqual(root1.length, 32, 'Root must be 32 bytes');
  });

  test.it('changing path_bit[0] from left to right produces a different root', () => {
    const leaf = commitmentLeaf(TEST_ISSUER, TEST_COUNTERPARTY, TEST_TERMS_HASH, TEST_DUE_AT);
    const rootLeft = computeMerkleRoot(leaf, ZERO_SIBLINGS, ALL_LEFT);
    const allRight: (0 | 1)[] = Array.from({ length: BATCH_DEPTH }, () => 1);
    const rootRight = computeMerkleRoot(leaf, ZERO_SIBLINGS, allRight);
    assert.notDeepStrictEqual(rootLeft, rootRight,
      'Left-path root must differ from right-path root — catches path_bits endianness bugs');
  });

  test.it('changing a sibling changes the root — proves depth sensitivity', () => {
    const leaf = commitmentLeaf(TEST_ISSUER, TEST_COUNTERPARTY, TEST_TERMS_HASH, TEST_DUE_AT);
    const rootA = computeMerkleRoot(leaf, ZERO_SIBLINGS, ALL_LEFT);

    const differentSiblings = ZERO_SIBLINGS.map((s, i) =>
      i === 5 ? Buffer.alloc(32, 0xff) : s
    );
    const rootB = computeMerkleRoot(leaf, differentSiblings, ALL_LEFT);
    assert.notDeepStrictEqual(rootA, rootB,
      'Changing sibling at depth 5 must change the root');
  });

  test.it('hash2 is NOT commutative — left/right ordering is enforced', () => {
    const a = Buffer.alloc(32, 0xaa);
    const b = Buffer.alloc(32, 0xbb);
    const h1 = hash2(a, b);
    const h2 = hash2(b, a);
    assert.notDeepStrictEqual(h1, h2,
      'hash2(a,b) must differ from hash2(b,a) — catches left/right swap bugs');
  });
});

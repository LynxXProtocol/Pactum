/**
 * Unit tests for the Paillier PHE module — Issue #190
 *
 * Uses Node.js built-in test runner (node:test + node:assert/strict),
 * matching the existing test style in the project.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  modPow,
  modInverse,
  keyPairFromPrimes,
  compactPublicKey,
  encrypt,
  decrypt,
  encAdd,
  encScale,
  encNegate,
  computeEncryptedScore,
  toEncryptedScore,
  fromEncryptedScore,
  COMPACT_N,
  BASE_SCORE,
  FULFILLED_WEIGHT,
  LATE_WEIGHT,
  BREACH_WEIGHT,
} from './paillier';

// ---------------------------------------------------------------------------
// modPow
// ---------------------------------------------------------------------------

test('modPow: 2^10 mod 1024 = 0', () => {
  assert.equal(modPow(2n, 10n, 1024n), 0n);
});

test('modPow: 3^4 mod 100 = 81', () => {
  assert.equal(modPow(3n, 4n, 100n), 81n);
});

test('modPow: x^0 mod m = 1', () => {
  assert.equal(modPow(999n, 0n, 101n), 1n);
});

test('modPow: 0^k mod m = 0', () => {
  assert.equal(modPow(0n, 5n, 7n), 0n);
});

test('modPow: any x mod 1 = 0', () => {
  assert.equal(modPow(99999n, 99999n, 1n), 0n);
});

// ---------------------------------------------------------------------------
// modInverse
// ---------------------------------------------------------------------------

test('modInverse: 3 * 3^-1 ≡ 1 (mod 7)', () => {
  const inv = modInverse(3n, 7n);
  assert.equal((3n * inv) % 7n, 1n);
});

test('modInverse: throws when gcd(a,m) ≠ 1', () => {
  assert.throws(() => modInverse(2n, 4n), /no inverse/);
});

// ---------------------------------------------------------------------------
// Key generation from small primes (fast, deterministic)
// ---------------------------------------------------------------------------

const P = 61n; // small safe prime
const Q = 53n;
const keyPair = keyPairFromPrimes(P, Q);
const { publicKey } = keyPair;

test('keyPairFromPrimes: n = p * q', () => {
  assert.equal(publicKey.n, P * Q);
});

test('keyPairFromPrimes: g = n + 1', () => {
  assert.equal(publicKey.g, publicKey.n + 1n);
});

test('keyPairFromPrimes: nSquared = n^2', () => {
  assert.equal(publicKey.nSquared, publicKey.n * publicKey.n);
});

// ---------------------------------------------------------------------------
// Encrypt / Decrypt round-trip
// ---------------------------------------------------------------------------

test('encrypt/decrypt round-trip for m = 0', () => {
  const ct = encrypt(publicKey, 0n, 2n);
  assert.equal(decrypt(keyPair, ct), 0n);
});

test('encrypt/decrypt round-trip for m = 42', () => {
  const ct = encrypt(publicKey, 42n, 3n);
  assert.equal(decrypt(keyPair, ct), 42n);
});

test('encrypt/decrypt round-trip for m = n - 1 (max plaintext)', () => {
  const m = publicKey.n - 1n;
  const ct = encrypt(publicKey, m, 5n);
  assert.equal(decrypt(keyPair, ct), m);
});

test('encrypt throws for negative plaintext', () => {
  assert.throws(() => encrypt(publicKey, -1n, 2n), RangeError);
});

test('encrypt throws for plaintext >= n', () => {
  assert.throws(() => encrypt(publicKey, publicKey.n, 2n), RangeError);
});

// ---------------------------------------------------------------------------
// Additive homomorphism: Enc(a) * Enc(b) = Enc(a+b) mod n²
// ---------------------------------------------------------------------------

test('encAdd: Enc(3) + Enc(4) decrypts to 7', () => {
  const ctA = encrypt(publicKey, 3n, 2n);
  const ctB = encrypt(publicKey, 4n, 3n);
  const ctSum = encAdd(publicKey, ctA, ctB);
  assert.equal(decrypt(keyPair, ctSum), 7n);
});

test('encAdd is commutative', () => {
  const ctA = encrypt(publicKey, 5n, 2n);
  const ctB = encrypt(publicKey, 8n, 3n);
  assert.equal(encAdd(publicKey, ctA, ctB), encAdd(publicKey, ctB, ctA));
});

test('encAdd accumulates across three ciphertexts', () => {
  const ct1 = encrypt(publicKey, 1n, 2n);
  const ct2 = encrypt(publicKey, 2n, 3n);
  const ct3 = encrypt(publicKey, 3n, 4n);
  const sum = encAdd(publicKey, encAdd(publicKey, ct1, ct2), ct3);
  assert.equal(decrypt(keyPair, sum), 6n);
});

// ---------------------------------------------------------------------------
// Scalar multiplication: Enc(v)^k = Enc(v*k)
// ---------------------------------------------------------------------------

test('encScale: Enc(3) scaled by 4 decrypts to 12', () => {
  const ct = encrypt(publicKey, 3n, 2n);
  const scaled = encScale(publicKey, ct, 4n);
  assert.equal(decrypt(keyPair, scaled), 12n);
});

test('encScale by 0 yields Enc(0)', () => {
  const ct = encrypt(publicKey, 7n, 2n);
  const scaled = encScale(publicKey, ct, 0n);
  assert.equal(decrypt(keyPair, scaled), 0n);
});

test('encScale by 1 is identity', () => {
  const ct = encrypt(publicKey, 13n, 2n);
  assert.equal(encScale(publicKey, ct, 1n), ct);
});

// ---------------------------------------------------------------------------
// Negation: Enc(v) + Enc(-v) = Enc(0) mod n
// ---------------------------------------------------------------------------

test('encNegate: Enc(v) + Enc(-v) decrypts to 0 (mod n)', () => {
  const v = 7n;
  const ct = encrypt(publicKey, v, 2n);
  const neg = encNegate(publicKey, ct);
  const sum = encAdd(publicKey, ct, neg);
  // Enc(v) + Enc(-v) = Enc(v + n - v) = Enc(n) ≡ Enc(0) mod n
  const plain = decrypt(keyPair, sum);
  assert.equal(plain % publicKey.n, 0n);
});

// ---------------------------------------------------------------------------
// computeEncryptedScore — full formula
// ---------------------------------------------------------------------------

test('computeEncryptedScore with all-zero outcomes returns BASE_SCORE', () => {
  const enc0 = encrypt(publicKey, 0n, 2n);
  const encScore = computeEncryptedScore(publicKey, enc0, enc0, enc0);
  const plain = decrypt(keyPair, encScore);
  assert.equal(plain, BASE_SCORE);
});

test('computeEncryptedScore: 3 fulfilled, 0 late, 0 breached', () => {
  // score = 50 + 10*3 - 10*0 - 50*0 = 80
  const encF = encrypt(publicKey, 3n, 2n);
  const enc0 = encrypt(publicKey, 0n, 3n);
  const encScore = computeEncryptedScore(publicKey, encF, enc0, enc0);
  const plain = decrypt(keyPair, encScore);
  assert.equal(plain, BASE_SCORE + FULFILLED_WEIGHT * 3n);
});

test('computeEncryptedScore: 0 fulfilled, 1 late, 0 breached', () => {
  // score = 50 + 0 - 10*1 - 0 = 40
  const enc0 = encrypt(publicKey, 0n, 2n);
  const encL = encrypt(publicKey, 1n, 3n);
  const encScore = computeEncryptedScore(publicKey, enc0, encL, enc0);
  const plain = decrypt(keyPair, encScore);
  assert.equal(plain, BASE_SCORE - LATE_WEIGHT);
});

test('computeEncryptedScore: 0 fulfilled, 0 late, 1 breached', () => {
  // score = 50 + 0 - 0 - 50*1 = 0  (clamped at 0 in service layer)
  const enc0 = encrypt(publicKey, 0n, 2n);
  const encB = encrypt(publicKey, 1n, 3n);
  const encScore = computeEncryptedScore(publicKey, enc0, enc0, encB);
  const plain = decrypt(keyPair, encScore);
  assert.equal(plain, BASE_SCORE - BREACH_WEIGHT);
});

// ---------------------------------------------------------------------------
// EncryptedScore wire format round-trip
// ---------------------------------------------------------------------------

test('toEncryptedScore / fromEncryptedScore round-trip for small value', () => {
  const v = 0xabcdef01234567n;
  const es = toEncryptedScore(v, 3);
  assert.equal(fromEncryptedScore(es), v);
  assert.equal(es.count, 3);
});

test('toEncryptedScore / fromEncryptedScore round-trip for 128-bit value', () => {
  const v = (1n << 127n) | 0xdeadbeefn;
  const es = toEncryptedScore(v, 7);
  assert.equal(fromEncryptedScore(es), v);
});

// ---------------------------------------------------------------------------
// Compact public key
// ---------------------------------------------------------------------------

test('compactPublicKey returns COMPACT_N as modulus', () => {
  const pk = compactPublicKey();
  assert.equal(pk.n, COMPACT_N);
  assert.equal(pk.nSquared, COMPACT_N * COMPACT_N);
  assert.equal(pk.g, COMPACT_N + 1n);
});

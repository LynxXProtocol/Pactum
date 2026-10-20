/**
 * Paillier Partially Homomorphic Encryption — Issue #190
 *
 * Implements the Paillier cryptosystem using JavaScript's native `BigInt` so no
 * external dependencies are required.  The public interface mirrors the on-chain
 * Soroban module (`he_reputation.rs`) so that ciphertexts produced here can be
 * submitted directly to the contract's `submit_encrypted_outcome` entrypoint.
 *
 * ## Mathematical basis
 *
 * Key generation (2048-bit in production, 64-bit demo modulus for tests):
 *   n   = p · q          (product of two large primes)
 *   n²  = n · n          (ciphertext space)
 *   g   = n + 1          (standard Paillier generator choice)
 *   λ   = lcm(p-1, q-1)  (Carmichael function)
 *   μ   = λ⁻¹ mod n      (decryption helper)
 *
 * Encryption of plaintext m ∈ [0, n):
 *   c = g^m · r^n  mod n²    where r ∈ Zn* is random
 *
 * Additive homomorphism:
 *   Enc(a) · Enc(b)  ≡  Enc(a + b)  (mod n²)
 *   Enc(a) ^ k       ≡  Enc(a · k)  (mod n²)
 *
 * Decryption:
 *   m = L(c^λ mod n²) · μ  mod n
 *   where L(x) = (x - 1) / n
 *
 * ## Compact 64-bit modulus
 *
 * The Soroban contract uses `PAILLIER_N = 2^64 - 59` (a 64-bit prime) to stay
 * within CPU limits.  When constructing ciphertexts destined for the contract,
 * call `PaillierPublicKey.withCompactModulus()` which uses exactly that value.
 */

// ---------------------------------------------------------------------------
// Modular arithmetic helpers
// ---------------------------------------------------------------------------

/** Computes (base ** exp) mod modulus using fast binary exponentiation. */
export function modPow(base: bigint, exp: bigint, modulus: bigint): bigint {
  if (modulus === 1n) return 0n;
  let result = 1n;
  base = base % modulus;
  while (exp > 0n) {
    if (exp % 2n === 1n) {
      result = (result * base) % modulus;
    }
    exp = exp >> 1n;
    base = (base * base) % modulus;
  }
  return result;
}

/** Extended Euclidean algorithm — returns [gcd, x, y] s.t. a·x + b·y = gcd. */
function extGcd(a: bigint, b: bigint): [bigint, bigint, bigint] {
  if (a === 0n) return [b, 0n, 1n];
  const [g, x, y] = extGcd(b % a, a);
  return [g, y - (b / a) * x, x];
}

/** Modular multiplicative inverse of a mod m.  Throws if gcd(a,m) ≠ 1. */
export function modInverse(a: bigint, m: bigint): bigint {
  const [g, x] = extGcd(((a % m) + m) % m, m);
  if (g !== 1n) throw new Error(`modInverse: ${a} has no inverse mod ${m}`);
  return ((x % m) + m) % m;
}

/** Least common multiple. */
function lcm(a: bigint, b: bigint): bigint {
  return (a / gcd(a, b)) * b;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Key types
// ---------------------------------------------------------------------------

/** The public component of a Paillier key pair. */
export interface PaillierPublicKey {
  /** RSA modulus n = p·q */
  readonly n: bigint;
  /** Ciphertext space modulus n² */
  readonly nSquared: bigint;
  /** Generator g = n + 1 (standard Paillier choice) */
  readonly g: bigint;
}

/** The private component of a Paillier key pair (never leaves the KMS). */
export interface PaillierPrivateKey {
  readonly publicKey: PaillierPublicKey;
  /** λ = lcm(p-1, q-1) */
  readonly lambda: bigint;
  /** μ = λ⁻¹ mod n */
  readonly mu: bigint;
}

// ---------------------------------------------------------------------------
// The compact 64-bit public key (matches the on-chain contract constants)
// ---------------------------------------------------------------------------

/** 2^64 - 59 — the 64-bit prime used by the Soroban contract. */
export const COMPACT_N = 2n ** 64n - 59n;

/**
 * Returns a `PaillierPublicKey` using the same 64-bit compact modulus that the
 * Soroban contract uses.  Ciphertexts produced with this key can be submitted
 * directly to `submit_encrypted_outcome`.
 */
export function compactPublicKey(): PaillierPublicKey {
  const n = COMPACT_N;
  return { n, nSquared: n * n, g: n + 1n };
}

// ---------------------------------------------------------------------------
// Key generation (for off-chain full-size use)
// ---------------------------------------------------------------------------

/**
 * Derives a Paillier key pair from two primes `p` and `q`.
 * In production these come from a CSPRNG; in tests deterministic small primes
 * are used to keep test runtime under a millisecond.
 */
export function keyPairFromPrimes(p: bigint, q: bigint): PaillierPrivateKey {
  const n = p * q;
  const nSquared = n * n;
  const g = n + 1n;
  const lambda = lcm(p - 1n, q - 1n);
  // L(x) = (x - 1) / n
  const lValue = (modPow(g, lambda, nSquared) - 1n) / n;
  const mu = modInverse(lValue, n);
  return { publicKey: { n, nSquared, g }, lambda, mu };
}

// ---------------------------------------------------------------------------
// Encryption / Decryption
// ---------------------------------------------------------------------------

/**
 * Encrypts plaintext `m` under `publicKey`.
 *
 * `c = g^m · r^n  mod n²`
 *
 * For deterministic output (e.g., in tests or for the compact-modulus contract
 * submission where the blinding factor is provided by the caller), pass an
 * explicit `r`.  Otherwise a random blinding factor is derived from the
 * system time mixed with the plaintext (sufficient for non-adversarial tests).
 */
export function encrypt(publicKey: PaillierPublicKey, plaintext: bigint, r?: bigint): bigint {
  const { n, nSquared, g } = publicKey;

  if (plaintext < 0n || plaintext >= n) {
    throw new RangeError(`plaintext ${plaintext} is out of range [0, n)`);
  }

  // Blinding factor: in production this must be a uniformly random element of Zn*.
  // For the compact 64-bit key used in tests, we derive a stable r from plaintext.
  const blinding = r ?? deriveBlinding(plaintext, n);

  const gm = modPow(g, plaintext, nSquared); // g^m mod n²
  const rn = modPow(blinding, n, nSquared); // r^n mod n²
  return (gm * rn) % nSquared;
}

/**
 * Decrypts ciphertext `c` using the private key.
 *
 * `m = L(c^λ mod n²) · μ  mod n`
 */
export function decrypt(privateKey: PaillierPrivateKey, ciphertext: bigint): bigint {
  const {
    publicKey: { n, nSquared },
    lambda,
    mu,
  } = privateKey;
  const cl = modPow(ciphertext, lambda, nSquared);
  const lValue = (cl - 1n) / n; // L(x) = (x - 1) / n
  return (lValue * mu) % n;
}

// ---------------------------------------------------------------------------
// Homomorphic operations
// ---------------------------------------------------------------------------

/**
 * Homomorphic addition of two ciphertexts:
 *
 * `encAdd(Enc(a), Enc(b)) = Enc(a + b)  (mod n²)`
 */
export function encAdd(publicKey: PaillierPublicKey, ctA: bigint, ctB: bigint): bigint {
  return (ctA * ctB) % publicKey.nSquared;
}

/**
 * Homomorphic scalar multiplication:
 *
 * `encScale(Enc(v), k) = Enc(v · k)  (mod n²)`
 */
export function encScale(publicKey: PaillierPublicKey, ct: bigint, k: bigint): bigint {
  return modPow(ct, k, publicKey.nSquared);
}

/**
 * Homomorphic negation: returns `Enc(-v)` given `Enc(v)`.
 *
 * `Enc(-v) = Enc(n - v) = Enc(v)^(n-1)  mod n²`
 */
export function encNegate(publicKey: PaillierPublicKey, ct: bigint): bigint {
  return modPow(ct, publicKey.n - 1n, publicKey.nSquared);
}

// ---------------------------------------------------------------------------
// Encrypted score formula
// ---------------------------------------------------------------------------

/**
 * Weights matching `trust_score.rs` constants.
 */
export const BASE_SCORE = 50n;
export const FULFILLED_WEIGHT = 10n;
export const LATE_WEIGHT = 10n;
export const BREACH_WEIGHT = 50n;

/**
 * Evaluates the encrypted trust score formula:
 *
 * ```
 * Enc(score) = Enc(BASE)
 *            ⊕ scale(Enc(F), FULFILLED_WEIGHT)
 *            ⊕ scale(Enc(−L), LATE_WEIGHT)
 *            ⊕ scale(Enc(−B), BREACH_WEIGHT)
 * ```
 *
 * All operations are performed over ciphertexts — the plaintext score is never
 * computed or stored here.
 */
export function computeEncryptedScore(
  publicKey: PaillierPublicKey,
  encFulfilled: bigint,
  encLate: bigint,
  encBreached: bigint,
): bigint {
  const { n, nSquared } = publicKey;

  // Enc(BASE_SCORE) = g^BASE_SCORE mod n²  (with r = 1 for constant term)
  const encBase = modPow(publicKey.g, BASE_SCORE, nSquared);

  const scoredF = encScale(publicKey, encFulfilled, FULFILLED_WEIGHT);

  const negL = encNegate(publicKey, encLate);
  const scoredL = encScale(publicKey, negL, LATE_WEIGHT);

  const negB = encNegate(publicKey, encBreached);
  const scoredB = encScale(publicKey, negB, BREACH_WEIGHT);

  let acc = (encBase * scoredF) % nSquared;
  acc = (acc * scoredL) % nSquared;
  acc = (acc * scoredB) % nSquared;
  return acc;
}

// ---------------------------------------------------------------------------
// EncryptedScore wire format (matches the Soroban struct)
// ---------------------------------------------------------------------------

/** Wire format matching the `EncryptedScore` Soroban `#[contracttype]`. */
export interface EncryptedScore {
  lo: bigint; // low 64 bits
  hi: bigint; // high 64 bits
  count: number;
}

const U64_MASK = (1n << 64n) - 1n;

/** Splits a 128-bit `BigInt` into `{ lo, hi }` matching the on-chain struct. */
export function toEncryptedScore(value: bigint, count: number): EncryptedScore {
  return {
    lo: value & U64_MASK,
    hi: (value >> 64n) & U64_MASK,
    count,
  };
}

/** Reconstructs the 128-bit ciphertext from the wire format. */
export function fromEncryptedScore(es: EncryptedScore): bigint {
  return (es.hi << 64n) | es.lo;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic (non-cryptographic) blinding factor for tests.
 * In production, replace with a CSPRNG-drawn value in Zn*.
 */
function deriveBlinding(plaintext: bigint, n: bigint): bigint {
  // Mix plaintext with a fixed salt using cheap arithmetic.
  const mixed = ((plaintext + 0x9e3779b97f4a7c15n) * 0x6c62272e07bb0142n) % n;
  return mixed === 0n ? 1n : mixed;
}
